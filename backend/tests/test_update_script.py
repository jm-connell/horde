"""update.sh end to end with a fake ``docker``/``curl``: ordering and rollback rules.

The fake docker keeps a tiny state machine (which image is ``horde:latest``, whether
the running version is healthy, what the schema revision says) and appends every
call to a log so the tests can assert what happened and in which order.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

FAKE_DOCKER = r"""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

d = Path(os.environ["FAKE_DIR"])
state_path = d / "state.json"
state = json.loads(state_path.read_text())
args = sys.argv[1:]
with (d / "calls.log").open("a") as log:
    log.write(" ".join(args[:8]) + "\n")

def save():
    state_path.write_text(json.dumps(state))

def out(text=""):
    sys.stdout.write(text)
    sys.exit(0)

cmd = args[0]
fmt = " ".join(args)
if cmd == "info":
    out()
if cmd == "ps":
    out()
if cmd == "rmi":
    state.setdefault("removed", []).append(args[-1])
    state["image_list"] = [i for i in state.get("image_list", []) if i[1] != args[-1].split(":")[-1]]
    save(); out()
if cmd == "tag":
    state["tags"][args[2]] = state["tags"].get(args[1], args[1])
    save(); out()
if cmd == "image":
    if args[1] == "ls":  # image ls horde --format '{{.CreatedAt}}|{{.Tag}}'
        out("".join(f"{created}|{tag}\n" for created, tag in state.get("image_list", [])))
    ref = args[-1]  # image inspect --format {{.Id}} REF
    ident = state["tags"].get(ref) or (ref if ref in state["images"] else "")
    if not ident:
        sys.exit(1)
    if "Labels" in fmt:
        out(state.get("labels", {}).get(ident, "") + "\n")
    out(ident + "\n")
if cmd == "inspect":
    target = args[-1]
    if target == "horde-ollama" or state.get("no_container"):
        sys.exit(1)
    if "{{.Image}}" in fmt:
        out(state.get("running_image", "sha256:old") + "\n")
    if "State.Running" in fmt:
        out("true\n" if state["running"] else "false\n")
    if "Mounts" in fmt:
        out(f"/downloads={d}/dl\n/app/data={d}/data\n")
    if "Config.Env" in fmt:
        out("PUID=1000\nPGID=1000\n")
    out("")

def tool_result(tool):
    # What scripts/sqlite_tool.py would print / exit with.
    if state.get("db_missing"):
        sys.exit(3)
    if state.get("db_unreadable"):
        sys.exit(1)
    if tool[:1] == ["backup"]:
        state["backup_made"] = True
        save(); out("ok\n")
    if tool[:1] == ["revision"]:
        out(state["revision"] + "\n")
    out()

if cmd == "exec":
    if state.get("exec_fails"):
        sys.exit(1)
    if "-" in args:
        tool_result(args[args.index("-") + 1:])
    out()
if cmd == "cp":
    Path(args[-1]).write_text("backup-of-db")
    out()
if cmd == "run":
    if "--entrypoint python" in fmt:  # sqlite_tool.py in a one-off container
        state["tool_in_image_used"] = True
        save()
        tool_result(args[args.index("-") + 1:])
    if "--entrypoint sh" in fmt:  # restore_database
        if state.get("restore_fails"):
            state["restore_attempted"] = True
            save(); sys.exit(1)
        state["revision"] = state["revision_before"]
        state["restored"] = True
        save(); out()
    out()
if cmd == "compose":
    sub = [a for a in args[1:] if a not in ("--profile", "ai")]
    verb = next((a for a in sub if a in ("ps", "config", "build", "up", "pull", "stop", "logs")), "")
    if verb == "ps":
        out("cid-1\n" if state["running"] else "")
    if verb == "config":
        out(json.dumps({"services": {"horde": {"volumes": [
            {"type": "bind", "source": f"{d}/dl", "target": "/downloads"},
            {"type": "bind", "source": f"{d}/data", "target": "/app/data"}]}}}))
    if verb == "build":
        if state.get("build_fails"):
            sys.exit(1)
        state["images"].append("sha256:new")
        state["tags"]["horde:latest"] = "sha256:new"
        state.setdefault("labels", {})["sha256:new"] = os.environ.get("HORDE_GIT_SHA", "")
        save(); out()
    if verb == "stop":
        state["running"] = False
        save(); out()
    if verb == "up":
        image = state["tags"]["horde:latest"]
        state["running"] = True
        state["running_image"] = image
        state["healthy"] = image != "sha256:new" or state["new_is_healthy"]
        if image == "sha256:new":
            state["revision"] = state["revision_new"]
            if state.get("unreadable_after_up"):
                state["db_unreadable"] = True
        save(); out()
    out()
sys.exit(0)
"""

FAKE_CURL = r"""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
d = Path(os.environ["FAKE_DIR"])
state = json.loads((d / "state.json").read_text())
if state["running"] and state["healthy"]:
    print(json.dumps({"status": "ok", "horde_version": "x"}))
    sys.exit(0)
sys.exit(22)
"""


def _git(repo: Path, *args: str) -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.com",
    }
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    ).stdout.strip()


class Harness:
    def __init__(self, tmp_path: Path) -> None:
        self.dir = tmp_path / "fake"
        (self.dir / "bin").mkdir(parents=True)
        (self.dir / "dl").mkdir()
        (self.dir / "data").mkdir()
        # The database lives inside the (fake) container; the host user cannot
        # see it, like a 0700 PUID-owned dataset. Only the SQLite tool reports it.
        for name, body in (("docker", FAKE_DOCKER), ("curl", FAKE_CURL)):
            path = self.dir / "bin" / name
            path.write_text(body)
            path.chmod(0o755)

        self.origin = tmp_path / "origin.git"
        self.work = tmp_path / "stack"
        self.other = tmp_path / "other"
        self.work.mkdir()
        subprocess.run(
            ["git", "init", "-b", "main", str(self.work)],
            check=True,
            capture_output=True,
        )
        shutil.copy(REPO / "update.sh", self.work / "update.sh")
        (self.work / "scripts").mkdir()
        for name in ("update_lib.sh", "parse_compose_mounts.py", "sqlite_tool.py"):
            shutil.copy(REPO / "scripts" / name, self.work / "scripts" / name)
        (self.work / ".gitignore").write_text(".env\n.local/\n")
        (self.work / "docker-compose.yml").write_text("services: {}\n")
        (self.work / "VERSION").write_text("1\n")
        (self.work / ".env").write_text(
            f"DOWNLOADS_PATH={self.dir}/dl\nDATA_PATH={self.dir}/data\n"
        )
        _git(self.work, "add", "-A")
        _git(self.work, "commit", "-m", "v1")
        subprocess.run(
            ["git", "clone", "--bare", str(self.work), str(self.origin)],
            check=True,
            capture_output=True,
        )
        _git(self.work, "remote", "add", "origin", str(self.origin))
        _git(self.work, "fetch", "origin")
        subprocess.run(
            ["git", "clone", str(self.origin), str(self.other)],
            check=True,
            capture_output=True,
        )
        self.v1 = _git(self.work, "rev-parse", "HEAD")

        state = {
            "running": True,
            "healthy": True,
            "images": ["sha256:old"],
            "tags": {"horde:latest": "sha256:old"},
            "revision": "0001",
            "revision_before": "0001",
            "revision_new": "0001",
            "new_is_healthy": True,
        }
        state["labels"] = {"sha256:old": self.v1}
        (self.dir / "state.json").write_text(json.dumps(state))
        (self.dir / "calls.log").write_text("")

    def read_state(self) -> dict:
        return json.loads((self.dir / "state.json").read_text())

    def calls(self) -> list[str]:
        return (self.dir / "calls.log").read_text().splitlines()

    def publish(self) -> str:
        (self.other / "VERSION").write_text("2\n")
        _git(self.other, "add", "VERSION")
        _git(self.other, "commit", "-m", "v2")
        _git(self.other, "push", "origin", "main")
        return _git(self.other, "rev-parse", "HEAD")

    def set(self, **changes: object) -> None:
        state = self.read_state()
        state.update(changes)
        (self.dir / "state.json").write_text(json.dumps(state))

    def run(self, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        full_env = {
            **os.environ,
            "PATH": f"{self.dir / 'bin'}:{os.environ['PATH']}",
            "FAKE_DIR": str(self.dir),
            "HORDE_HEALTH_URL": "http://127.0.0.1:1/api/health",
            "HORDE_HEALTH_TIMEOUT_SEC": "3",
            **env,
        }
        return subprocess.run(
            ["bash", str(self.work / "update.sh"), *args],
            cwd=self.work,
            capture_output=True,
            text=True,
            env=full_env,
            check=False,
            timeout=120,
        )


@pytest.fixture
def harness(tmp_path):
    return Harness(tmp_path)


def _index(calls: list[str], prefix: str, start: int = 0) -> int:
    for i in range(start, len(calls)):
        if calls[i].startswith(prefix):
            return i
    raise AssertionError(f"no call starting with {prefix!r} in {calls}")


def test_update_backs_up_before_recreate_and_tags_images(harness):
    v2 = harness.publish()

    result = harness.run()
    assert result.returncode == 0, result.stdout + result.stderr

    calls = harness.calls()
    backup = _index(calls, "exec -i cid-1 python - backup")
    build = _index(calls, "compose build")
    up = _index(calls, "compose up")
    # The backup is taken after a successful build, right before the recreate.
    assert build < backup < up
    state = harness.read_state()
    assert state["tags"]["horde:latest"] == "sha256:new"
    assert state["tags"][f"horde:{v2[:7]}"] == "sha256:new"
    assert state["tags"][f"horde:{harness.v1[:7]}"] == "sha256:old"

    recorded = (harness.work / ".local" / "update-state.env").read_text()
    assert f"PREV_GIT_SHA={harness.v1}" in recorded
    assert "PREV_IMAGE_ID=sha256:old" in recorded
    backups = list((harness.work / ".local" / "update-backups").glob("*/horde.db"))
    assert len(backups) == 1


def test_unhealthy_update_rolls_back_code_and_image_without_touching_db(harness):
    harness.publish()
    harness.set(new_is_healthy=False)  # same revision: no migration ran

    result = harness.run()

    assert result.returncode == 1
    assert "rolled back" in result.stderr
    state = harness.read_state()
    assert state["tags"]["horde:latest"] == "sha256:old"
    assert state["healthy"] is True
    assert "restored" not in state
    assert _git(harness.work, "rev-parse", "HEAD") == harness.v1
    assert _git(harness.work, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    calls = harness.calls()
    # The rollback must reuse the old image: exactly one build overall.
    assert sum(c.startswith("compose build") for c in calls) == 1
    last_up = [c for c in calls if c.startswith("compose up")][-1]
    assert "--no-build" in last_up
    assert "--pull never" in last_up


def test_unhealthy_update_that_migrated_restores_the_database_backup(harness):
    harness.publish()
    harness.set(new_is_healthy=False, revision_new="0002")

    result = harness.run()

    assert result.returncode == 1
    assert "A database schema migration ran" in result.stderr
    assert "RESTORING DATABASE" in result.stderr
    state = harness.read_state()
    assert state["restored"] is True
    assert state["revision"] == "0001"
    assert state["tags"]["horde:latest"] == "sha256:old"


def test_auto_rollback_can_be_disabled(harness):
    harness.publish()
    harness.set(new_is_healthy=False)

    result = harness.run(HORDE_AUTO_ROLLBACK="0")

    assert result.returncode == 1
    state = harness.read_state()
    assert state["tags"]["horde:latest"] == "sha256:new"
    assert "update.sh --rollback" in result.stderr


def test_manual_rollback_after_a_migration_refuses_before_touching_anything(harness):
    v2 = harness.publish()
    harness.set(revision_new="0002")
    assert harness.run().returncode == 0
    assert _git(harness.work, "rev-parse", "HEAD") == v2
    before = len(harness.calls())

    result = harness.run("--rollback")

    assert result.returncode == 1, result.stdout + result.stderr
    assert "--restore-db" in result.stderr
    assert "Nothing was changed" in result.stderr
    state = harness.read_state()
    # Still running the new version, never stopped, git untouched.
    assert state["running"] is True
    assert state["tags"]["horde:latest"] == "sha256:new"
    assert _git(harness.work, "rev-parse", "HEAD") == v2
    later = harness.calls()[before:]
    assert not any(c.startswith(("compose stop", "compose up", "tag ")) for c in later)

    result = harness.run("--rollback", "--restore-db")
    assert result.returncode == 0, result.stdout + result.stderr
    state = harness.read_state()
    assert state["restored"] is True
    assert state["tags"]["horde:latest"] == "sha256:old"
    assert _git(harness.work, "rev-parse", "HEAD") == harness.v1


def test_manual_rollback_without_a_migration_just_switches_back(harness):
    harness.publish()
    assert harness.run().returncode == 0

    result = harness.run("--rollback")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "restored" not in harness.read_state()
    assert harness.read_state()["tags"]["horde:latest"] == "sha256:old"
    assert _git(harness.work, "rev-parse", "HEAD") == harness.v1


def test_rollback_without_a_recorded_update_is_an_error(harness):
    result = harness.run("--rollback")
    assert result.returncode == 1
    assert "Nothing to roll back to" in result.stderr


def test_update_stops_on_edited_compose_before_changing_anything(harness):
    harness.publish()
    (harness.work / "docker-compose.yml").write_text("services: {}\n# mine\n")

    result = harness.run()

    assert result.returncode == 1
    assert "Stopping: you have local edits" in result.stderr
    assert not any(
        c.startswith(("compose build", "compose up")) for c in harness.calls()
    )
    assert _git(harness.work, "rev-parse", "HEAD") == harness.v1
    assert not (harness.work / ".local" / "update-state.env").exists()


def test_database_that_cannot_be_backed_up_aborts_unless_skipped(harness):
    harness.publish()
    harness.set(exec_fails=True)

    result = harness.run()
    assert result.returncode == 1, result.stdout + result.stderr
    assert "Cannot back up the database" in result.stderr
    assert not any(c.startswith("compose up") for c in harness.calls())

    result = harness.run(HORDE_SKIP_DB_BACKUP="1")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "WITHOUT a database backup" in result.stderr


def test_first_alembic_adoption_counts_as_a_migration(harness):
    harness.publish()
    harness.set(revision="none", revision_before="none", revision_new="0001_baseline")
    harness.set(new_is_healthy=False)

    result = harness.run()

    assert result.returncode == 1
    assert "A database schema migration ran" in result.stderr
    assert harness.read_state()["restored"] is True


def _state_text(harness) -> str:
    return (harness.work / ".local" / "update-state.env").read_text()


def test_update_with_nothing_new_keeps_the_rollback_point(harness):
    harness.publish()
    assert harness.run().returncode == 0
    recorded = _state_text(harness)
    assert f"PREV_GIT_SHA={harness.v1}" in recorded
    calls_before = len(harness.calls())

    result = harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Already up to date" in result.stdout
    assert _state_text(harness) == recorded
    later = harness.calls()[calls_before:]
    assert not any(c.startswith(("compose build", "compose up")) for c in later)
    # ... so the rollback still goes back to v1.
    assert harness.run("--rollback").returncode == 0
    assert _git(harness.work, "rev-parse", "HEAD") == harness.v1


def test_forced_rebuild_of_the_same_commit_does_not_overwrite_the_rollback_point(
    harness,
):
    harness.publish()
    assert harness.run().returncode == 0
    recorded = _state_text(harness)

    result = harness.run(HORDE_FORCE_REBUILD="1")

    assert result.returncode == 0, result.stdout + result.stderr
    after = _state_text(harness)
    for key in ("PREV_GIT_SHA", "PREV_IMAGE_ID", "DB_BACKUP", "GIT_BRANCH"):
        line = next(x for x in recorded.splitlines() if x.startswith(key + "="))
        assert line in after.splitlines()


def test_restore_failure_aborts_loudly_and_changes_nothing_else(harness):
    harness.publish()
    harness.set(new_is_healthy=False, revision_new="0002", restore_fails=True)

    result = harness.run()

    assert result.returncode == 1
    assert "RESTORE FAILED" in result.stderr
    assert "rolled back to" not in result.stderr
    state = harness.read_state()
    assert state["restore_attempted"] is True
    assert "restored" not in state
    # The migrated checkout and image are left as they were for a retry.
    assert state["tags"]["horde:latest"] == "sha256:new"
    assert _git(harness.work, "rev-parse", "HEAD") != harness.v1
    assert state["running"] is False


def test_unreadable_revision_is_not_an_automatic_restore(harness):
    harness.publish()
    harness.set(new_is_healthy=False)
    # Readable for the backup, unreadable once the new version has failed.
    assert harness.run(HORDE_AUTO_ROLLBACK="0").returncode == 1
    harness.set(db_unreadable=True, new_is_healthy=False)
    assert "restored" not in harness.read_state()

    result = harness.run("--rollback")

    assert result.returncode == 1
    assert "could not be determined" in result.stderr
    assert "restored" not in harness.read_state()


def test_rollback_stops_when_the_checkout_moved_since_the_update(harness):
    v2 = harness.publish()
    assert harness.run().returncode == 0
    (harness.work / "LOCAL.txt").write_text("mine\n")
    _git(harness.work, "add", "LOCAL.txt")
    _git(harness.work, "commit", "-m", "my own commit")
    mine = _git(harness.work, "rev-parse", "HEAD")
    assert mine != v2

    result = harness.run("--rollback")

    assert result.returncode == 1
    assert "not where the update left it" in result.stderr
    assert _git(harness.work, "rev-parse", "HEAD") == mine
    assert harness.read_state()["tags"]["horde:latest"] == "sha256:new"


def test_missing_database_is_a_fresh_install_without_backup(harness):
    harness.publish()
    harness.set(db_missing=True)

    result = harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "No existing database to back up" in result.stdout
    assert "DB_BACKUP" not in _state_text(harness)
    assert not list((harness.work / ".local" / "update-backups").glob("*/horde.db"))


def test_database_invisible_to_the_host_user_is_still_backed_up(harness):
    harness.publish()
    # A 0700 PUID-owned dataset (the harness never creates horde.db on the host)
    # and a stopped container: the one-off image container must do the work.
    harness.set(running=False)

    result = harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "via image" in result.stdout
    assert harness.read_state()["tool_in_image_used"] is True
    assert list((harness.work / ".local" / "update-backups").glob("*/horde.db"))


def test_no_backup_folder_for_rollback_or_aborted_runs(harness):
    harness.publish()
    (harness.work / "docker-compose.yml").write_text("services: {}\n# mine\n")
    assert harness.run().returncode == 1
    backups = harness.work / ".local" / "update-backups"
    # Only the saved compose edit exists; no database backup, no snapshot folders.
    assert not list(backups.glob("*/horde.db"))
    assert not list((harness.work / ".local").glob("update-snap.*"))


def test_failed_build_takes_no_backup_and_leaves_no_state(harness):
    harness.publish()
    harness.set(build_fails=True)

    result = harness.run()

    assert result.returncode != 0
    assert not any(c.startswith("compose up") for c in harness.calls())
    assert not list((harness.work / ".local").glob("update-backups/*/horde.db"))
    assert not (harness.work / ".local" / "update-state.env").exists()


def test_old_image_tags_are_pruned_but_rollback_tags_are_kept(harness):
    v2 = harness.publish()
    images = [(f"2026-01-0{n} 00:00:00 +0000 UTC", f"{n}" * 7) for n in range(1, 8)]
    images.append(("2026-02-01 00:00:00 +0000 UTC", harness.v1[:7]))
    images.append(("2026-03-01 00:00:00 +0000 UTC", v2[:7]))
    harness.set(image_list=images)

    result = harness.run(HORDE_KEEP_IMAGES="3")

    assert result.returncode == 0, result.stdout + result.stderr
    removed = {x.split(":")[-1] for x in harness.read_state()["removed"]}
    assert f"{v2[:7]}" not in removed and harness.v1[:7] not in removed
    assert "1111111" in removed and "2222222" in removed
    assert "7777777" not in removed  # within the newest three


def test_unreadable_revision_after_a_failed_update_is_not_an_automatic_restore(
    harness,
):
    harness.publish()
    harness.set(new_is_healthy=False, unreadable_after_up=True)

    result = harness.run()

    assert result.returncode == 1
    assert "could not be determined" in result.stderr
    assert "--restore-db" in result.stderr
    state = harness.read_state()
    assert "restored" not in state, "an unknown state must never auto-restore"
    # The code and image still go back, so the user is not left on a failed version.
    assert state["tags"]["horde:latest"] == "sha256:old"


def test_first_install_with_no_container_image_or_data_is_a_fresh_install(harness):
    harness.publish()
    harness.set(
        no_container=True, running=False, images=[], tags={}, labels={}, db_missing=True
    )
    # Only the build produces an image; there is nothing to back up or roll back to.
    result = harness.run()

    assert "No existing database to back up" in result.stdout, (
        result.stdout + result.stderr
    )
    assert not list((harness.work / ".local").glob("update-backups/*/horde.db"))

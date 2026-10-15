"""update.sh end to end with a fake ``docker``/``curl``: ordering and rollback rules.

The fake docker keeps a tiny state machine (which image is ``horde:latest``, whether
the running version is healthy, what the migration ledger says) and appends every
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
if cmd == "info":
    out()
if cmd == "ps":
    out()
if cmd == "tag":
    state["tags"][args[2]] = state["tags"].get(args[1], args[1])
    save(); out()
if cmd == "image":  # image inspect --format {{.Id}} REF
    ref = args[-1]
    ident = state["tags"].get(ref) or (ref if ref in state["images"] else "")
    if not ident:
        sys.exit(1)
    out(ident + "\n")
if cmd == "inspect":
    target = args[-1]
    if target == "horde-ollama" or not state["running"]:
        sys.exit(1)
    fmt = " ".join(args)
    if "Mounts" in fmt:
        out(f"/downloads={d}/dl\n/app/data={d}/data\n")
    if "Config.Env" in fmt:
        out("PUID=1000\nPGID=1000\n")
    out("")
if cmd == "exec":
    if state.get("exec_fails"):
        sys.exit(1)
    tool = args[args.index("-") + 1:] if "-" in args else []
    if tool[:1] == ["backup"]:
        state["backup_made"] = True
        save(); out("ok\n")
    if tool[:1] == ["ledger"]:
        out(state["ledger"] + "\n")
    out()
if cmd == "cp":
    Path(args[-1]).write_text("backup-of-db")
    out()
if cmd == "run":
    fmt = " ".join(args)
    if "--entrypoint python" in fmt:  # sqlite_tool.py ledger in a one-off container
        out(state["ledger"] + "\n")
    if "pre-rollback" in fmt or "--entrypoint sh" in fmt:  # restore_database
        state["ledger"] = state["ledger_before"]
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
        state["images"].append("sha256:new")
        state["tags"]["horde:latest"] = "sha256:new"
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
            state["ledger"] = state["ledger_new"]
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
        (self.dir / "data" / "horde.db").write_text("db")
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
            "ledger": "m1",
            "ledger_before": "m1",
            "ledger_new": "m1",
            "new_is_healthy": True,
        }
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
    assert backup < build < up
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
    harness.set(new_is_healthy=False)  # same ledger: no migration ran

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
    harness.set(new_is_healthy=False, ledger_new="m1,m2")

    result = harness.run()

    assert result.returncode == 1
    assert "A database schema migration ran" in result.stderr
    assert "RESTORING DATABASE" in result.stderr
    state = harness.read_state()
    assert state["restored"] is True
    assert state["ledger"] == "m1"
    assert state["tags"]["horde:latest"] == "sha256:old"


def test_auto_rollback_can_be_disabled(harness):
    harness.publish()
    harness.set(new_is_healthy=False)

    result = harness.run(HORDE_AUTO_ROLLBACK="0")

    assert result.returncode == 1
    state = harness.read_state()
    assert state["tags"]["horde:latest"] == "sha256:new"
    assert "update.sh --rollback" in result.stderr


def test_manual_rollback_warns_before_discarding_data_after_a_migration(harness):
    v2 = harness.publish()
    harness.set(ledger_new="m1,m2")
    assert harness.run().returncode == 0
    assert _git(harness.work, "rev-parse", "HEAD") == v2

    result = harness.run("--rollback")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "--restore-db" in result.stderr
    state = harness.read_state()
    assert "restored" not in state
    assert state["tags"]["horde:latest"] == "sha256:old"
    assert _git(harness.work, "rev-parse", "HEAD") == harness.v1

    result = harness.run("--rollback", "--restore-db")
    assert result.returncode == 0, result.stdout + result.stderr
    assert harness.read_state()["restored"] is True


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
    # exec into the container fails and the host fallback gets a file that is not SQLite.
    harness.set(exec_fails=True)

    result = harness.run()
    assert result.returncode == 1, result.stdout + result.stderr
    assert "Could not back up" in result.stderr
    assert not any(c.startswith("compose build") for c in harness.calls())

    result = harness.run(HORDE_SKIP_DB_BACKUP="1")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "WITHOUT a database backup" in result.stderr

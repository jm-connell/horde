"""Regression: host volume paths and .env survive the TrueNAS update script."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
LIB = REPO / "scripts" / "update_lib.sh"
UPDATE_SH = REPO / "update.sh"
SQLITE_TOOL = REPO / "scripts" / "sqlite_tool.py"


def _run(script: str, *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    bash = f"set -euo pipefail\nsource '{LIB}'\n{script}\n"
    return subprocess.run(
        ["bash", "-c", bash],
        cwd=cwd or REPO,
        capture_output=True,
        text=True,
        check=False,
    )


def _check(script: str, *, cwd: Path | None = None) -> str:
    result = _run(script, cwd=cwd)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    return result.stdout


def test_update_scripts_are_valid_bash():
    for path in (LIB, UPDATE_SH):
        result = subprocess.run(
            ["bash", "-n", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, f"{path}: {result.stderr}"


def test_env_get_handles_quotes_export_and_last_assignment(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "# comment\n"
        "DOWNLOADS_PATH=/old\n"
        "export DATA_PATH='/mnt/tank/data'\n"
        'DOWNLOADS_PATH="/mnt/tank/media/YouTube Archive"\n'
        "PUID=1000\n",
        encoding="utf-8",
    )
    out = _check(
        f"""
        printf '%s\\n' "$(horde_env_get '{env}' DOWNLOADS_PATH)"
        printf '%s\\n' "$(horde_env_get '{env}' DATA_PATH)"
        printf 'missing=%s\\n' "$(horde_env_get '{env}' MISSING)"
        """
    )
    lines = out.splitlines()
    assert lines[0] == "/mnt/tank/media/YouTube Archive"
    assert lines[1] == "/mnt/tank/data"
    assert lines[2] == "missing="


def test_env_upsert_replaces_empty_and_does_not_duplicate(tmp_path):
    env = tmp_path / ".env"
    env.write_text("PUID=1000\nDOWNLOADS_PATH=\n", encoding="utf-8")
    _check(
        f"""
        horde_env_upsert '{env}' DOWNLOADS_PATH '/mnt/real/media'
        horde_env_upsert '{env}' DOWNLOADS_PATH '/mnt/real/media'
        horde_env_set_if_missing '{env}' PUID '568'
        horde_env_set_if_missing '{env}' DATA_PATH '/mnt/real/data'
        """
    )
    text = env.read_text(encoding="utf-8")
    assert text.count("DOWNLOADS_PATH=") == 1
    assert "DOWNLOADS_PATH=/mnt/real/media" in text
    assert "PUID=1000" in text
    assert "PUID=568" not in text
    assert "DATA_PATH=/mnt/real/data" in text


def test_seed_env_prefers_live_container_paths_over_stale_env(tmp_path):
    env = tmp_path / ".env"
    snap = tmp_path / "live.env"
    env.write_text(
        "DOWNLOADS_PATH=/mnt/tank/media/youtube_archive\n"
        "DATA_PATH=/opt/dockge/horde/data\n",
        encoding="utf-8",
    )
    snap.write_text(
        "DOWNLOADS_PATH=/mnt/tank/media/actual_library\n"
        "DATA_PATH=/mnt/tank/apps/horde-data\n"
        "PUID=568\n",
        encoding="utf-8",
    )
    _check(f"horde_seed_env_from_snapshot '{env}' '{snap}'")
    text = env.read_text(encoding="utf-8")
    assert "DOWNLOADS_PATH=/mnt/tank/media/actual_library" in text
    assert "DATA_PATH=/mnt/tank/apps/horde-data" in text
    assert "PUID=568" in text
    assert "/opt/dockge/horde/data" not in text


def test_guard_blocks_volume_path_change():
    result = _run(
        """
        if horde_guard_volume_paths \\
            /mnt/live/media /mnt/live/data \\
            /mnt/tank/media/youtube_archive /opt/dockge/horde/data; then
          echo ALLOWED
          exit 0
        fi
        echo BLOCKED
        """
    )
    assert result.returncode == 0
    assert "BLOCKED" in result.stdout
    assert "DOWNLOADS_PATH would change" in result.stderr
    assert "DATA_PATH would change" in result.stderr


def test_guard_allows_same_paths_with_trailing_slash():
    result = _run(
        """
        horde_guard_volume_paths \\
            /mnt/live/media /mnt/live/data/ \\
            /mnt/live/media/ /mnt/live/data
        echo OK
        """
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_extract_bind_mounts_from_compose_json():
    json_cfg = """
    {
      "services": {
        "horde": {
          "volumes": [
            {"type": "bind", "source": "/mnt/media", "target": "/downloads"},
            {"type": "bind", "source": "/mnt/data", "target": "/app/data"}
          ]
        }
      }
    }
    """
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"set -euo pipefail; source '{LIB}'; horde_extract_horde_bind_mounts",
        ],
        input=json_cfg,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    lines = dict(
        line.split("=", 1) for line in result.stdout.splitlines() if "=" in line
    )
    assert lines["/downloads"] == "/mnt/media"
    assert lines["/app/data"] == "/mnt/data"


_GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}

_COMPOSE = (
    "services:\n"
    "  horde:\n"
    "    volumes:\n"
    "      - ${DOWNLOADS_PATH:-/mnt/tank/media/youtube_archive}:/downloads\n"
    "      - ${DATA_PATH:-/opt/dockge/horde/data}:/app/data\n"
)


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    )
    return result.stdout.strip()


@pytest.fixture
def stack(tmp_path):
    """A user's checkout (``work``) cloned from ``origin``; ``other`` pushes upstream."""
    work = tmp_path / "stack"
    other = tmp_path / "other"
    origin = tmp_path / "origin.git"
    work.mkdir()
    subprocess.run(
        ["git", "init", "-b", "main", str(work)], check=True, capture_output=True
    )
    (work / ".gitignore").write_text(".env\n.local/\n", encoding="utf-8")
    (work / "docker-compose.yml").write_text(_COMPOSE, encoding="utf-8")
    (work / "README.txt").write_text("readme\n", encoding="utf-8")
    (work / ".env").write_text(
        "DOWNLOADS_PATH=/mnt/custom/media\nDATA_PATH=/mnt/custom/data\n",
        encoding="utf-8",
    )
    _git(work, "add", ".gitignore", "docker-compose.yml", "README.txt")
    _git(work, "commit", "-m", "initial")
    subprocess.run(
        ["git", "clone", "--bare", str(work), str(origin)],
        check=True,
        capture_output=True,
    )
    _git(work, "remote", "add", "origin", str(origin))
    _git(work, "fetch", "origin")
    _git(work, "branch", "--set-upstream-to=origin/main", "main")
    subprocess.run(
        ["git", "clone", str(origin), str(other)], check=True, capture_output=True
    )

    def push_upstream(name: str, content: str) -> None:
        (other / name).write_text(content, encoding="utf-8")
        _git(other, "add", name)
        _git(other, "commit", "-m", f"upstream {name}")
        _git(other, "push", "origin", "main")

    return work, push_upstream


def test_git_pull_fast_forwards_and_keeps_env(stack):
    work, push_upstream = stack
    push_upstream("docker-compose.yml", _COMPOSE + "    image: horde:latest\n")

    result = _run("horde_git_pull", cwd=work)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr

    assert "image: horde:latest" in (work / "docker-compose.yml").read_text(
        encoding="utf-8"
    )
    assert "DOWNLOADS_PATH=/mnt/custom/media" in (work / ".env").read_text(
        encoding="utf-8"
    )
    assert _git(work, "rev-parse", "HEAD") == _git(work, "rev-parse", "origin/main")


def test_git_pull_stops_on_edited_compose_and_never_stashes(stack):
    work, push_upstream = stack
    push_upstream("docker-compose.yml", _COMPOSE + "    image: horde:latest\n")
    edited = _COMPOSE.replace(
        "${DOWNLOADS_PATH:-/mnt/tank/media/youtube_archive}", "/mnt/custom/media"
    )
    (work / "docker-compose.yml").write_text(edited, encoding="utf-8")
    head_before = _git(work, "rev-parse", "HEAD")

    result = _run("horde_git_pull .local/backup", cwd=work)

    assert result.returncode != 0
    assert "docker-compose.override.yml" in result.stderr
    # The user's file is untouched, a copy is kept, and nothing was merged or stashed.
    assert (work / "docker-compose.yml").read_text(encoding="utf-8") == edited
    assert (work / ".local/backup/docker-compose.yml.local-edit").read_text(
        encoding="utf-8"
    ) == edited
    assert _git(work, "rev-parse", "HEAD") == head_before
    assert _git(work, "stash", "list") == ""
    assert "<<<<<<<" not in edited


def test_git_pull_can_discard_compose_edits_after_backing_them_up(stack):
    work, push_upstream = stack
    push_upstream("docker-compose.yml", _COMPOSE + "    image: horde:latest\n")
    (work / "docker-compose.yml").write_text("services: {}\n# mine\n", encoding="utf-8")

    result = _run(
        "HORDE_DISCARD_COMPOSE_EDITS=1 horde_git_pull .local/backup", cwd=work
    )
    assert result.returncode == 0, result.stdout + "\n" + result.stderr

    compose = (work / "docker-compose.yml").read_text(encoding="utf-8")
    assert "image: horde:latest" in compose
    assert "<<<<<<<" not in compose
    assert "# mine" in (work / ".local/backup/docker-compose.yml.local-edit").read_text(
        encoding="utf-8"
    )
    assert "DATA_PATH=/mnt/custom/data" in (work / ".env").read_text(encoding="utf-8")


def test_git_pull_keeps_unrelated_local_edits(stack):
    work, push_upstream = stack
    push_upstream("NEWS.txt", "news\n")
    (work / "README.txt").write_text("my notes\n", encoding="utf-8")

    result = _run("horde_git_pull", cwd=work)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert (work / "NEWS.txt").is_file()
    assert (work / "README.txt").read_text(encoding="utf-8") == "my notes\n"


def test_git_pull_refuses_diverged_history_without_merging(stack):
    work, push_upstream = stack
    push_upstream("NEWS.txt", "news\n")
    (work / "LOCAL.txt").write_text("local\n", encoding="utf-8")
    _git(work, "add", "LOCAL.txt")
    _git(work, "commit", "-m", "local commit")
    head_before = _git(work, "rev-parse", "HEAD")

    result = _run("horde_git_pull", cwd=work)

    assert result.returncode != 0
    assert "Cannot fast-forward" in result.stderr
    assert _git(work, "rev-parse", "HEAD") == head_before
    assert not (work / "NEWS.txt").exists()


def test_git_pull_refuses_detached_head(stack):
    work, _ = stack
    _git(work, "checkout", "--detach")
    result = _run("horde_git_pull", cwd=work)
    assert result.returncode != 0
    assert "detached HEAD" in result.stderr


def test_prune_backups_keeps_newest_n(tmp_path):
    root = tmp_path / "update-backups"
    for stamp in (
        "20260101T000000Z",
        "20260102T000000Z",
        "20260103T000000Z",
        "20260104T000000Z",
    ):
        (root / stamp).mkdir(parents=True)
        (root / stamp / "horde.db").write_text(stamp, encoding="utf-8")

    _check(f"horde_prune_backups '{root}' 2")

    assert sorted(p.name for p in root.iterdir()) == [
        "20260103T000000Z",
        "20260104T000000Z",
    ]
    # Missing dir and junk N must not fail or delete everything.
    _check(f"horde_prune_backups '{tmp_path / 'nope'}' 5")
    _check(f"horde_prune_backups '{root}' abc")
    assert len(list(root.iterdir())) == 2


def test_schema_changed_decides_database_restore():
    out = _check(
        """
        horde_schema_changed "0001" "0002" && echo changed
        horde_schema_changed "0002" "0002" || echo same
        horde_schema_changed "none" "0001" && echo adoption
        horde_schema_changed "none" "none" || echo none_none
        horde_schema_changed "" "0001" || echo unknown_before
        horde_schema_changed "0001" "unreadable" && echo unreadable
        """
    )
    assert out.split() == [
        "changed",
        "same",
        "adoption",
        "none_none",
        "unknown_before",
        "unreadable",
    ]


def test_only_a_pre_alembic_version_tolerates_a_migrated_database():
    out = _check(
        """
        horde_old_version_tolerates_schema "none" && echo pre_alembic
        horde_old_version_tolerates_schema "0001" || echo has_check
        horde_old_version_tolerates_schema "" || echo unknown
        """
    )
    assert out.split() == ["pre_alembic", "has_check", "unknown"]


def test_version_string_uses_nearest_release_tag(stack):
    work, _ = stack
    assert _check("horde_version_string", cwd=work) == "dev"
    _git(work, "tag", "v1.4.0")
    assert _check("horde_version_string", cwd=work) == "1.4.0"
    (work / "NEW.txt").write_text("x", encoding="utf-8")
    _git(work, "add", "NEW.txt")
    _git(work, "commit", "-m", "later")
    assert _check("horde_version_string", cwd=work).startswith("1.4.0-1-g")


def _make_db(path: Path, revision: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    # The legacy ledger stays in the file but no longer changes; it must be ignored.
    conn.execute(
        "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)"
    )
    conn.execute("INSERT INTO schema_migrations VALUES ('2026_07_legacy', 'now')")
    conn.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
    conn.execute("INSERT INTO alembic_version VALUES (?)", (revision,))
    conn.execute("CREATE TABLE video (id INTEGER PRIMARY KEY, title TEXT)")
    conn.execute("INSERT INTO video (title) VALUES ('kept')")
    conn.commit()
    return conn


def _tool(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SQLITE_TOOL), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_sqlite_tool_backs_up_a_live_wal_database(tmp_path):
    db = tmp_path / "horde.db"
    live = _make_db(db, "0002_integrity")
    # A write still sitting in the WAL (connection open, app "running") must be in the copy.
    live.execute("INSERT INTO video (title) VALUES ('only in wal')")
    live.commit()
    assert (tmp_path / "horde.db-wal").exists()

    dest = tmp_path / "backup" / "horde.db"
    dest.parent.mkdir()
    result = _tool("backup", str(dest), str(db))
    assert result.returncode == 0, result.stderr
    live.close()

    copy = sqlite3.connect(dest)
    titles = [row[0] for row in copy.execute("SELECT title FROM video ORDER BY id")]
    copy.close()
    assert titles == ["kept", "only in wal"]

    assert _tool("revision", str(dest)).stdout.strip() == "0002_integrity"


def test_sqlite_tool_revision_handles_legacy_and_missing_databases(tmp_path):
    legacy = tmp_path / "legacy.db"
    conn = sqlite3.connect(legacy)
    conn.execute("CREATE TABLE video (id INTEGER)")
    conn.commit()
    conn.close()
    # Only the legacy ledger, no alembic_version: a pre-Alembic database.
    conn = sqlite3.connect(legacy)
    conn.execute("CREATE TABLE schema_migrations (id TEXT)")
    conn.commit()
    conn.close()
    assert _tool("revision", str(legacy)).stdout.strip() == "none"

    missing = _tool("revision", str(tmp_path / "nope.db"))
    assert missing.returncode == 3, "exit 3 means 'no database', distinct from failures"
    assert not (tmp_path / "nope.db").exists(), "must not create an empty database"
    assert (
        _tool("backup", str(tmp_path / "out.db"), str(tmp_path / "nope.db")).returncode
        != 0
    )


def test_sqlite_tool_revision_fails_instead_of_guessing_none(tmp_path, monkeypatch):
    """A locked database is not a pre-Alembic one: it must not print "none"."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("sqlite_tool_under_test", SQLITE_TOOL)
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)
    db = tmp_path / "horde.db"
    _make_db(db, "0002_integrity").close()
    real_connect = sqlite3.connect

    class Locked:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, *_a, **_k):
            raise sqlite3.OperationalError("database is locked")

        def close(self):
            self.conn.close()

    monkeypatch.setattr(
        tool.sqlite3, "connect", lambda *a, **k: Locked(real_connect(*a, **k))
    )

    with pytest.raises(sqlite3.OperationalError, match="locked"):
        tool.revision(str(db))


def test_prune_backups_never_deletes_the_protected_folder(tmp_path):
    root = tmp_path / "update-backups"
    for stamp in ("20260101T000000Z", "20260102T000000Z", "20260103T000000Z"):
        (root / stamp).mkdir(parents=True)

    _check(f"horde_prune_backups '{root}' 1 '{root}/20260101T000000Z'")

    assert sorted(p.name for p in root.iterdir()) == [
        "20260101T000000Z",
        "20260103T000000Z",
    ]


def _tag(work: Path, name: str) -> None:
    other = work.parent / "other"
    _git(other, "pull", "--ff-only", "origin", "main")
    _git(other, "tag", name)
    _git(other, "push", "origin", name)


def test_pick_release_takes_the_highest_stable_semver_tag(stack):
    work, push_upstream = stack
    for name in (
        "v1.2.0",
        "v1.10.0",
        "v1.9.9",
        "v2.0.0-rc.1",
        "v1.10.0-rc.1",
        "nightly",
    ):
        _tag(work, name)
    _git(work, "fetch", "--tags", "origin")

    assert _check("horde_pick_release", cwd=work) == "v1.10.0"
    assert _check("horde_pick_release prerelease", cwd=work) == "v2.0.0-rc.1"


def test_pick_release_prefers_the_stable_tag_over_its_own_prerelease(stack):
    work, _ = stack
    for name in ("v1.0.0-rc.1", "v1.0.0"):
        _tag(work, name)
    _git(work, "fetch", "--tags", "origin")
    assert _check("horde_pick_release prerelease", cwd=work) == "v1.0.0"


def test_pick_release_is_empty_without_release_tags(stack):
    work, _ = stack
    _tag(work, "not-a-release")
    _git(work, "fetch", "--tags", "origin")
    assert _check("horde_pick_release", cwd=work) == ""


def test_git_pull_without_release_tags_falls_back_to_main(stack):
    work, push_upstream = stack
    push_upstream("NEWS.txt", "news\n")

    result = _run("horde_git_pull", cwd=work)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "following main until the first release" in result.stderr
    assert (work / "NEWS.txt").is_file()
    assert _git(work, "rev-parse", "--abbrev-ref", "HEAD") == "main"


def test_unknown_channel_is_rejected(stack):
    work, _ = stack
    result = _run("HORDE_UPDATE_CHANNEL=nightly horde_git_pull", cwd=work)
    assert result.returncode == 1
    assert "Unknown HORDE_UPDATE_CHANNEL" in result.stderr

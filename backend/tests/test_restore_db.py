"""scripts/restore_db.sh, the snippet update.sh runs inside a throwaway container."""

from __future__ import annotations

import sqlite3
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "restore_db.sh"
TS = "20260101T000000Z"


def _db(path: Path, title: str) -> None:
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE video (title TEXT)")
    conn.execute("INSERT INTO video VALUES (?)", (title,))
    conn.commit()
    conn.close()


def _titles(path: Path) -> list[str]:
    conn = sqlite3.connect(path)
    try:
        return [r[0] for r in conn.execute("SELECT title FROM video")]
    finally:
        conn.close()


def _run(data: Path, backup: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sh", str(SCRIPT), str(data), str(backup), TS],
        capture_output=True,
        text=True,
        check=False,
    )


def _setup(tmp_path: Path) -> tuple[Path, Path]:
    data = tmp_path / "data"
    data.mkdir()
    _db(data / "horde.db", "newer")
    (data / "horde.db-wal").write_bytes(b"stale wal of the newer database")
    (data / "horde.db-shm").write_bytes(b"stale shm")
    backup = tmp_path / "backup.db"
    _db(backup, "backup")
    return data, backup


def test_good_backup_replaces_the_database_and_keeps_the_newer_one(tmp_path):
    data, backup = _setup(tmp_path)

    result = _run(data, backup)

    assert result.returncode == 0, result.stderr
    assert _titles(data / "horde.db") == ["backup"]
    assert _titles(data / f"horde.db.pre-rollback-{TS}") == ["newer"]
    # The WAL/SHM of the replaced database are moved aside, never left to be
    # applied to the restored file, and nothing is left half done.
    assert not (data / "horde.db-wal").exists()
    assert not (data / "horde.db-shm").exists()
    assert (data / f"horde.db-wal.pre-rollback-{TS}").exists()
    assert not (data / "horde.db.restoring").exists()


def test_corrupt_backup_changes_nothing(tmp_path):
    data, backup = _setup(tmp_path)
    backup.write_bytes(b"SQLite format 3\x00" + b"\xff" * 4096)
    wal_before = (data / "horde.db-wal").read_bytes()

    result = _run(data, backup)

    assert result.returncode != 0
    # Check the sidecars before opening the live database (opening it would
    # make SQLite discard our fake WAL).
    assert (data / "horde.db-wal").read_bytes() == wal_before
    assert (data / "horde.db-shm").exists()
    assert _titles(data / "horde.db") == ["newer"], "live database untouched"
    assert not (data / "horde.db.restoring").exists()
    assert not list(data.glob("*.pre-rollback-*"))


def test_missing_backup_is_a_usage_error(tmp_path):
    data, _ = _setup(tmp_path)
    result = _run(data, tmp_path / "nope.db")
    assert result.returncode == 2
    assert _titles(data / "horde.db") == ["newer"]


def test_restore_works_when_there_is_no_current_database(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    backup = tmp_path / "backup.db"
    _db(backup, "backup")

    result = _run(data, backup)

    assert result.returncode == 0, result.stderr
    assert _titles(data / "horde.db") == ["backup"]

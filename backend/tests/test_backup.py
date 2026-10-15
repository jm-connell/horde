"""Nightly database backups."""

from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import main
from app.services import backup
from app.services.backup import BackupConfig


def _day(y=2026, m=10, d=15, hour=5):
    return datetime(y, m, d, hour, 0).astimezone()


def test_nightly_backup_is_a_consistent_copy_of_the_live_database(add_video, init_db):
    add_video(title="Keep me")
    path = backup.run_nightly_backup(init_db["engine"], now=_day(), keep=7)

    assert path == init_db["data"] / "backups" / "horde-nightly-20261015.db"
    assert not list(path.parent.glob("*.part"))
    with sqlite3.connect(path) as copy:
        assert copy.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert copy.execute("SELECT title FROM videos").fetchall() == [("Keep me",)]


def test_a_second_run_on_the_same_day_replaces_the_file(add_video, init_db):
    first = backup.run_nightly_backup(init_db["engine"], now=_day(), keep=7)
    add_video(title="Added later")
    second = backup.run_nightly_backup(init_db["engine"], now=_day(), keep=7)
    assert first == second
    with sqlite3.connect(second) as copy:
        assert copy.execute("SELECT count(*) FROM videos").fetchone() == (1,)


def test_pruning_keeps_the_newest_nightly_files_and_never_touches_migration_backups(
    init_db,
):
    folder = init_db["data"] / "backups"
    folder.mkdir()
    pre = [
        folder / f"horde-pre-0001-to-0002-2026010{i}T000000Z.db" for i in range(1, 4)
    ]
    for p in pre:
        p.write_bytes(b"pre")
    for day in range(1, 11):
        (folder / f"horde-nightly-202610{day:02d}.db").write_bytes(b"night")
    (folder / "notes.txt").write_text("mine")

    backup.run_nightly_backup(init_db["engine"], now=_day(d=11), keep=3)

    nightly = [p.name for p in backup.list_nightly(folder)]
    assert nightly == [
        "horde-nightly-20261009.db",
        "horde-nightly-20261010.db",
        "horde-nightly-20261011.db",
    ]
    assert all(p.exists() for p in pre)
    assert (folder / "notes.txt").exists()


def test_backup_is_due_after_the_hour_until_todays_file_exists(init_db):
    folder = init_db["data"] / "backups"
    folder.mkdir()
    assert not backup.backup_due(folder, _day(hour=3), hour=4)
    assert backup.backup_due(folder, _day(hour=4), hour=4)
    assert backup.backup_due(folder, _day(hour=22), hour=4)  # catches up after downtime
    backup.nightly_path(folder, _day()).write_bytes(b"x")
    assert not backup.backup_due(folder, _day(hour=22), hour=4)
    assert backup.backup_due(folder, _day(d=16, hour=4), hour=4)


@pytest.mark.parametrize(
    ("env", "hour", "keep", "enabled"),
    [
        ({}, 4, 7, True),
        ({"HORDE_BACKUP_HOUR": "2", "HORDE_BACKUP_KEEP": "30"}, 2, 30, True),
        ({"HORDE_BACKUP_HOUR": "0"}, 0, 7, True),  # midnight is a valid hour
        ({"HORDE_BACKUP_ENABLED": "0"}, 4, 7, False),
        ({"HORDE_BACKUP_ENABLED": "off"}, 4, 7, False),
        ({"HORDE_BACKUP_ENABLED": "1"}, 4, 7, True),
        ({"HORDE_BACKUP_ENABLED": "maybe"}, 4, 7, True),
        ({"HORDE_BACKUP_HOUR": "99", "HORDE_BACKUP_KEEP": "0"}, 23, 1, True),
        ({"HORDE_BACKUP_HOUR": "abc", "HORDE_BACKUP_KEEP": "x"}, 4, 7, True),
    ],
)
def test_config_comes_from_the_environment(monkeypatch, env, hour, keep, enabled):
    for name in ("HORDE_BACKUP_HOUR", "HORDE_BACKUP_KEEP", "HORDE_BACKUP_ENABLED"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    cfg = BackupConfig.from_env()
    assert (cfg.hour, cfg.keep, cfg.enabled) == (hour, keep, enabled)


def test_disabled_config_creates_no_worker(init_db):
    assert (
        backup.create_backup_worker(init_db["engine"], BackupConfig(enabled=False))
        is None
    )


def test_the_worker_writes_a_backup_when_one_is_due_and_stops_promptly(init_db):
    worker = backup.create_backup_worker(
        init_db["engine"],
        BackupConfig(hour=4, keep=2),
        clock=lambda: _day(hour=6),
        startup_delay=0,
        interval=0.05,
    )
    worker.start()
    target = init_db["data"] / "backups" / "horde-nightly-20261015.db"
    deadline = time.monotonic() + 5
    while not target.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    started = time.monotonic()
    assert worker.stop(timeout=5)
    assert time.monotonic() - started < 2
    assert target.exists()


def test_a_failing_backup_is_retried_later_not_in_a_hot_loop(init_db, monkeypatch):
    attempts = []

    def failing(*_a, **_k):
        attempts.append(1)
        raise OSError("disk full")

    monkeypatch.setattr(backup, "run_nightly_backup", failing)
    worker = backup.create_backup_worker(
        init_db["engine"],
        BackupConfig(hour=4),
        clock=lambda: _day(hour=6),
        startup_delay=0,
        interval=0.01,
        retry_after=30,
    )
    worker.start()
    time.sleep(0.3)
    assert worker.stop(timeout=5)
    assert len(attempts) == 1


def test_lifespan_registers_the_backup_worker_unless_disabled(init_db, monkeypatch):
    monkeypatch.setattr("app.services.ytdlp_common.ensure_plugins_loaded", lambda: None)
    monkeypatch.setenv("HORDE_BACKUP_ENABLED", "0")
    with TestClient(main.app) as client:
        names = {w.name for w in client.app.state.workers.workers}
    assert "nightly-backup" not in names
    assert "scanner-poller" in names

    monkeypatch.setenv("HORDE_BACKUP_ENABLED", "1")
    with TestClient(main.app) as client:
        names = {w.name for w in client.app.state.workers.workers}
    assert "nightly-backup" in names


def test_backups_can_run_while_other_threads_write(init_db):
    from sqlmodel import Session

    from app.models import Video

    stop = threading.Event()
    errors: list[BaseException] = []

    def writer() -> None:
        n = 0
        try:
            while not stop.is_set():
                n += 1
                with Session(init_db["engine"]) as session:
                    session.add(
                        Video(title=f"v{n}", channel="C", file_path=f"C/v{n}.mp4")
                    )
                    session.commit()
        except Exception as exc:  # noqa: BLE001 - handed to the main thread below
            errors.append(exc)

    thread = threading.Thread(target=writer)
    thread.start()
    try:
        time.sleep(0.1)
        path = backup.run_nightly_backup(init_db["engine"], now=_day(), keep=7)
    finally:
        stop.set()
        thread.join(10)
    assert not errors
    assert path is not None and path.exists()
    with sqlite3.connect(path) as copy:
        assert copy.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert copy.execute("SELECT count(*) FROM videos").fetchone()[0] > 0


def test_leftover_part_files_from_earlier_runs_are_removed(init_db):
    folder = init_db["data"] / "backups"
    folder.mkdir()
    stale = folder / "horde-nightly-20261001.db.part"
    stale.write_bytes(b"half")
    other = folder / "mine.db.part"
    other.write_bytes(b"not ours")
    backup.run_nightly_backup(init_db["engine"], now=_day(), keep=7)
    assert not stale.exists()
    assert other.exists()

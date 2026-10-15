"""Nightly SQLite backups.

Once a day, from ``HORDE_BACKUP_HOUR`` (0-23, default 4) local time, unless
``HORDE_BACKUP_ENABLED=0``, the database is copied with
``VACUUM INTO`` to ``DATA_DIR/backups/horde-nightly-YYYYMMDD.db``. The copy is a
consistent snapshot taken while Horde keeps running. The newest ``HORDE_BACKUP_KEEP``
nightly files are kept.

The migration runner writes ``horde-pre-*.db`` safety copies into the same folder;
pruning here only ever touches ``horde-nightly-*.db``, and the runner only touches
``horde-pre-*.db``.
"""

from __future__ import annotations

import logging
import os
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy.engine import Engine

from .workers import BackgroundWorker

logger = logging.getLogger(__name__)

NIGHTLY_PREFIX = "horde-nightly-"
NIGHTLY_GLOB = f"{NIGHTLY_PREFIX}*.db"
DEFAULT_HOUR = 4
DEFAULT_KEEP = 7
CHECK_INTERVAL_SEC = 60.0
#: Let startup settle (migrations, first scan) before the first check.
STARTUP_DELAY_SEC = 120.0
#: After a failed attempt (disk full, volume unmounted) wait before trying again.
RETRY_AFTER_FAILURE_SEC = 3600.0


@dataclass(frozen=True)
class BackupConfig:
    #: Local hour of day (0-23) after which the day's backup is taken.
    hour: int = DEFAULT_HOUR
    keep: int = DEFAULT_KEEP
    enabled: bool = True

    @classmethod
    def from_env(cls) -> BackupConfig:
        return cls(
            enabled=_env_flag("HORDE_BACKUP_ENABLED", default=True),
            hour=_env_int("HORDE_BACKUP_HOUR", DEFAULT_HOUR, minimum=0, maximum=23),
            keep=_env_int("HORDE_BACKUP_KEEP", DEFAULT_KEEP, minimum=1, maximum=3650),
        )


def _env_flag(name: str, *, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in {"0", "false", "no", "off"}:
        return False
    if raw in {"1", "true", "yes", "on"}:
        return True
    logger.warning("ignoring %s=%r: use 1 or 0", name, raw)
    return default


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("ignoring %s=%r: not a whole number", name, raw)
        return default
    return min(max(value, minimum), maximum)


def backup_dir(engine: Engine) -> Path | None:
    """``backups/`` next to the database file (the migration runner uses the same)."""
    db_file = engine.url.database
    if not db_file or db_file == ":memory:":
        return None
    return Path(db_file).resolve().parent / "backups"


def nightly_path(directory: Path, day: datetime) -> Path:
    return directory / f"{NIGHTLY_PREFIX}{day:%Y%m%d}.db"


def list_nightly(directory: Path) -> list[Path]:
    """Nightly backups, oldest first (the date in the name sorts lexicographically)."""
    return sorted(p for p in directory.glob(NIGHTLY_GLOB) if p.is_file())


def latest_nightly(engine: Engine) -> Path | None:
    directory = backup_dir(engine)
    if directory is None or not directory.is_dir():
        return None
    found = list_nightly(directory)
    return found[-1] if found else None


def prune_nightly(directory: Path, keep: int) -> list[Path]:
    """Delete all but the newest ``keep`` nightly backups. Returns what was removed."""
    removed = []
    for old in list_nightly(directory)[:-keep] if keep > 0 else []:
        old.unlink(missing_ok=True)
        removed.append(old)
    return removed


def run_nightly_backup(
    engine: Engine, *, now: datetime | None = None, keep: int = DEFAULT_KEEP
) -> Path | None:
    """Write today's backup (replacing a same-day file) and prune old ones."""
    directory = backup_dir(engine)
    if directory is None:
        return None
    directory.mkdir(parents=True, exist_ok=True)
    target = nightly_path(directory, now or datetime.now().astimezone())
    partial = target.with_name(target.name + ".part")
    partial.unlink(missing_ok=True)
    raw = engine.raw_connection()
    try:
        conn: sqlite3.Connection = raw.driver_connection  # type: ignore[assignment]
        # VACUUM INTO refuses to run inside a transaction and needs a path that
        # does not exist yet.
        conn.execute("VACUUM INTO ?", (str(partial),))
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    finally:
        raw.close()
    partial.replace(target)
    removed = prune_nightly(directory, keep)
    logger.info(
        "nightly backup written to %s (%d bytes); removed %d old backup(s)",
        target,
        target.stat().st_size,
        len(removed),
    )
    return target


def backup_due(directory: Path, now: datetime, hour: int) -> bool:
    """True once ``hour`` has passed today and today's backup does not exist yet."""
    return now.hour >= hour and not nightly_path(directory, now).exists()


def create_backup_worker(
    engine: Engine,
    config: BackupConfig | None = None,
    *,
    clock: Callable[[], datetime] = lambda: datetime.now().astimezone(),
    startup_delay: float = STARTUP_DELAY_SEC,
    interval: float = CHECK_INTERVAL_SEC,
    retry_after: float = RETRY_AFTER_FAILURE_SEC,
) -> BackgroundWorker | None:
    """The worker, or None when backups are disabled (``HORDE_BACKUP_ENABLED=0``)."""
    cfg = config or BackupConfig.from_env()
    if not cfg.enabled:
        logger.info("nightly backups are disabled (HORDE_BACKUP_ENABLED=0)")
        return None

    def loop(worker: BackgroundWorker) -> None:
        if worker.sleep(startup_delay):
            return
        while True:
            directory = backup_dir(engine)
            now = clock()
            pause = interval
            if directory is not None and backup_due(directory, now, cfg.hour):
                try:
                    run_nightly_backup(engine, now=now, keep=cfg.keep)
                except Exception:
                    logger.exception("nightly backup failed; will retry later")
                    pause = retry_after
            if worker.sleep(pause):
                return

    return BackgroundWorker("nightly-backup", loop)

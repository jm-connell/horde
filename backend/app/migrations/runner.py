"""Programmatic Alembic entry point used by ``init_db()``.

Startup algorithm (``upgrade_database``):

1. Fresh database (no tables): ``upgrade head``.
2. Tables but no ``alembic_version`` (every install that predates Alembic):
   run the frozen legacy additive migrator, then ``upgrade head``. The
   baseline revision skips tables that already exist, so it adopts the legacy
   schema as ``0001_baseline`` (equivalent to ``stamp``, but it also creates
   any table an old install never had).
3. ``alembic_version`` names a revision this code does not know (a newer app
   ran on this database and the code was then rolled back): refuse to start.
4. Otherwise ``upgrade head``.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError
from sqlalchemy import inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError

logger = logging.getLogger(__name__)

BACKUP_KEEP = 5
# Tables Alembic must not manage: the legacy ledger is left in place after
# adoption (harmless, and an older app would recreate it anyway).
_UNMANAGED_TABLES = frozenset({"schema_migrations"})
_INTERNAL_TABLES = frozenset({"alembic_version", "sqlite_sequence"})


# The FTS5 index is created with raw SQL (a virtual table plus its shadow
# tables ``videos_fts_data`` / ``_idx`` / ``_content`` / ``_docsize`` / ``_config``).
_FTS_TABLE_PREFIX = "videos_fts"


def _include_object(
    obj: Any, name: str | None, type_: str, reflected: bool, compare_to: Any
) -> bool:
    if type_ != "table" or name is None:
        return True
    return name not in _UNMANAGED_TABLES and not name.startswith(_FTS_TABLE_PREFIX)


# Shared by env.py and the schema drift test so both compare the same way.
CONTEXT_OPTIONS: dict[str, Any] = {
    "render_as_batch": True,
    "compare_type": True,
    "include_object": _include_object,
}


class SchemaTooNewError(RuntimeError):
    """The database was migrated by a newer version of Horde than this one."""


def alembic_config(engine: Engine) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parent))
    cfg.attributes["engine"] = engine
    return cfg


def _app_tables(engine: Engine) -> set[str]:
    return set(inspect(engine).get_table_names()) - _INTERNAL_TABLES


def _current_revision(engine: Engine) -> str | None:
    with engine.connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


def head_revision() -> str | None:
    """The newest revision this code ships."""
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parent))
    return ScriptDirectory.from_config(cfg).get_current_head()


def is_at_head(engine: Engine, head: str | None = None) -> bool:
    """True when the database is migrated to ``head`` (default: this code's head)."""
    return _current_revision(engine) == (head or head_revision())


def stored_revision(engine: Engine) -> str | None:
    """The revision in ``alembic_version``, read with one cheap query.

    Unlike ``_current_revision`` this builds no Alembic ``MigrationContext`` (which
    logs two INFO lines per call), so a probe can use it on every request.
    """
    with engine.connect() as conn:
        try:
            row = conn.exec_driver_sql(
                "SELECT version_num FROM alembic_version"
            ).first()
        except OperationalError:  # no such table: not migrated yet
            return None
    return row[0] if row else None


def _backup_database(engine: Engine, label: str) -> Path | None:
    """Copy the database next to itself before it is changed. Keeps the newest few."""
    db_file = engine.url.database
    if not db_file or db_file == ":memory:":
        return None
    backups = Path(db_file).resolve().parent / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    target = backups / f"horde-pre-{label}-{stamp}.db"
    raw = engine.raw_connection()
    try:
        dest = sqlite3.connect(target)
        try:
            raw.driver_connection.backup(dest)  # type: ignore[attr-defined]
        finally:
            dest.close()
    finally:
        raw.close()
    for old in sorted(backups.glob("horde-pre-*.db"))[:-BACKUP_KEEP]:
        old.unlink(missing_ok=True)
    logger.info("Database backed up to %s before migrating", target)
    return target


def upgrade_database(engine: Engine) -> None:
    """Bring ``engine``'s database to the latest revision (see module docstring)."""
    cfg = alembic_config(engine)
    script = ScriptDirectory.from_config(cfg)
    head = script.get_current_head()
    tables = _app_tables(engine)
    current = _current_revision(engine)

    if current is not None:
        try:
            script.get_revision(current)
        except CommandError as exc:
            raise SchemaTooNewError(_too_new_message(current, head)) from exc
        if current == head:
            return
        _backup_database(engine, f"{current}-to-{head}")
        logger.info(
            "Migrating database (%s -> %s); this can take several minutes on "
            "large libraries",
            current,
            head,
        )
        command.upgrade(cfg, "head")
        return

    if not tables:
        command.upgrade(cfg, "head")
        return

    # Existing install that predates Alembic.
    from .. import legacy_migrations

    logger.info("Adopting a pre-Alembic database into the Alembic baseline")
    _backup_database(engine, "alembic-adoption")
    legacy_migrations.run_legacy_migrations(engine)
    logger.info(
        "Migrating database (pre-Alembic -> %s); this can take several minutes "
        "on large libraries",
        head,
    )
    # From "base": 0001 only creates tables that are still missing, which
    # adopts the existing schema as the baseline; later revisions then apply
    # in the same transaction.
    command.upgrade(cfg, "head")


def _too_new_message(found: str, head: str | None) -> str:
    return (
        f"The database schema is at revision {found!r}, which this version of "
        f"Horde does not know (it only knows up to {head!r}). A newer Horde "
        "has migrated this database and the application was then rolled back "
        "or downgraded. Refusing to start so the data is not damaged. Either "
        "update Horde to the newer version again, or roll back the data with "
        "the matching backup: run `./update.sh --rollback --restore-db` (the "
        "update script backs up the database before every update), or restore "
        "horde.db from a backup taken before the upgrade (Horde also writes "
        "copies to DATA_DIR/backups/ before migrating)."
    )

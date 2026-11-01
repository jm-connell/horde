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

After every branch, including "already at head", ``repair_integrity`` checks
``PRAGMA foreign_key_check``. Code that never turns ``PRAGMA foreign_keys`` on
(the pre-Alembic Horde after a rollback, the ``sqlite3`` shell) can delete a
parent row and leave its children behind; those rows are repaired the way
``ON DELETE`` would have (CASCADE children deleted, SET NULL pointers cleared).
The legacy ``video_ai_chat`` table such code recreates is dropped again. A
database that is behind gets the same row repair before its revisions run,
because the migration refuses to commit over foreign key violations.

Anything that changes an existing database writes ``DATA_DIR/backups/
horde-pre-<label>-<stamp>.db`` first: a pending migration, the adoption of a
pre-Alembic database, and an integrity repair that has something to repair.
A clean database already at head is only read.
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
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import OperationalError

from ..database import sqlite_connection

logger = logging.getLogger(__name__)

BACKUP_KEEP = 5
# Tables Alembic must not manage: the legacy ledger is left in place after
# adoption (harmless, and an older app would recreate it anyway).
_UNMANAGED_TABLES = frozenset({"schema_migrations"})
_INTERNAL_TABLES = frozenset({"alembic_version", "sqlite_sequence"})


# The FTS5 indexes are created with raw SQL (a virtual table plus its shadow
# tables ``<name>_data`` / ``_idx`` / ``_content`` / ``_docsize`` / ``_config``).
_FTS_TABLE_PREFIXES = ("videos_fts", "kb_chunks_fts")


def _include_object(
    obj: Any, name: str | None, type_: str, reflected: bool, compare_to: Any
) -> bool:
    if type_ != "table" or name is None:
        return True
    return name not in _UNMANAGED_TABLES and not name.startswith(_FTS_TABLE_PREFIXES)


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


def _backup_stamp(path: Path) -> str:
    """The UTC timestamp a ``horde-pre-<label>-<stamp>.db`` name ends with."""
    return path.stem.rsplit("-", 1)[-1]


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
            sqlite_connection(raw).backup(dest)
        finally:
            dest.close()
    finally:
        raw.close()
    # By timestamp, not name: labels differ (revisions, adoption, repair).
    for old in sorted(backups.glob("horde-pre-*.db"), key=_backup_stamp)[:-BACKUP_KEEP]:
        old.unlink(missing_ok=True)
    logger.info("Database backed up to %s before changing it", target)
    return target


def upgrade_database(engine: Engine) -> None:
    """Bring ``engine``'s database to the latest revision (see module docstring)."""
    _migrate(engine)
    repair_integrity(engine)


def _migrate(engine: Engine) -> None:
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
        # The revisions refuse to commit over violations: repair first.
        with engine.begin() as conn:
            _repair_foreign_keys(conn)
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


# Dropped by 0004_permissions_chat; the pre-Alembic code's create_all recreates it.
_LEGACY_TABLES = ("video_ai_chat",)
# Deleting an orphan can orphan its own children when foreign keys were off.
_REPAIR_ROUNDS = 5
# The ON DELETE actions the repair applies to an orphan; others are left as found.
_REPAIRED_ACTIONS = ("CASCADE", "SET NULL")


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _repair_foreign_key(conn: Connection, table: str, fk_id: int) -> int:
    """Apply the ``ON DELETE`` action of ``table``'s FK ``fk_id`` to its orphans."""
    rows = [
        row
        for row in conn.exec_driver_sql(
            f"PRAGMA foreign_key_list({_quote(table)})"
        ).fetchall()
        if row[0] == fk_id
    ]
    if not rows:
        return 0
    parent, on_delete = rows[0][2], str(rows[0][6]).upper()
    pairs = [(row[3], row[4] or "rowid") for row in rows]
    present = " AND ".join(f"t.{_quote(src)} IS NOT NULL" for src, _ in pairs)
    match = " AND ".join(f"p.{_quote(dst)} = t.{_quote(src)}" for src, dst in pairs)
    orphan = (
        f"{present} AND NOT EXISTS "  # noqa: S608 - identifiers come from sqlite_master and are quoted
        f"(SELECT 1 FROM {_quote(parent)} p WHERE {match})"
    )
    what = f"{table}({', '.join(src for src, _ in pairs)}) -> {parent}"
    if on_delete == "CASCADE":
        sql = f"DELETE FROM {_quote(table)} AS t WHERE {orphan}"  # noqa: S608 - identifiers come from sqlite_master and are quoted
        verb = "deleted orphaned"
    elif on_delete == "SET NULL":
        cleared = ", ".join(f"{_quote(src)} = NULL" for src, _ in pairs)
        sql = f"UPDATE {_quote(table)} AS t SET {cleared} WHERE {orphan}"  # noqa: S608 - identifiers come from sqlite_master and are quoted
        verb = "cleared dangling"
    else:
        logger.warning(
            "Integrity check: %s has rows pointing at missing %s rows and declares "
            "ON DELETE %s; left unchanged",
            table,
            parent,
            on_delete,
        )
        return 0
    count = conn.exec_driver_sql(sql).rowcount
    if count:
        logger.warning("Integrity check: %s %d row(s) of %s", verb, count, what)
    return count


def _needs_repair(engine: Engine) -> tuple[list[str], bool]:
    """The legacy tables present, and whether a foreign-key violation is repairable.

    Only a violation whose key declares ``ON DELETE CASCADE`` or ``SET NULL`` counts:
    the repair leaves the others alone, so a backup for them would repeat on every
    start and push the real pre-migration backups out of the rotation.
    """
    with engine.connect() as conn:
        existing = set(inspect(conn).get_table_names())
        violations = conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
        actions: dict[tuple[str, int], str] = {}
        for table, fk_id in {(row[0], row[3]) for row in violations}:
            for fk in conn.exec_driver_sql(
                f"PRAGMA foreign_key_list({_quote(table)})"
            ).fetchall():
                if fk[0] == fk_id:
                    actions[(table, fk_id)] = str(fk[6]).upper()
    repairable = any(action in _REPAIRED_ACTIONS for action in actions.values())
    return [t for t in _LEGACY_TABLES if t in existing], repairable


def repair_integrity(engine: Engine) -> None:
    """Repair what code running with foreign keys off left behind (database at head).

    A database with nothing to repair is only read. Otherwise it is backed up first,
    like a migration: the repair deletes rows and drops a table.
    """
    legacy, violations = _needs_repair(engine)
    if not legacy and not violations:
        return
    _backup_database(engine, "integrity-repair")
    with engine.begin() as conn:
        for table in legacy:
            logger.warning(
                "Integrity check: dropping the legacy %s table (recreated by an "
                "older Horde)",
                table,
            )
            conn.exec_driver_sql(f"DROP TABLE {_quote(table)}")
        _repair_foreign_keys(conn)


def _repair_foreign_keys(conn: Connection) -> None:
    for _ in range(_REPAIR_ROUNDS):
        violations = conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
        if not violations:
            return
        fixed = sum(
            _repair_foreign_key(conn, table, fk_id)
            for table, fk_id in sorted({(row[0], row[3]) for row in violations})
        )
        if not fixed:
            break
    left = conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
    if left:
        logger.error(
            "Integrity check: %d row(s) still reference missing rows", len(left)
        )


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

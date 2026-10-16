"""SQLite engine and schema initialisation.

Schema changes are Alembic revisions under ``app/migrations``; ``init_db()``
applies them programmatically at startup. Pre-Alembic installs are adopted via
the frozen ``legacy_migrations`` module.

The engine uses WAL + a busy timeout so API threads, scanners, and the AI
worker can overlap. Nested Sessions (OpenRouter cost ledger) still must not
start a second writer while another Session holds an uncommitted write.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any, cast

from sqlalchemy import event
from sqlalchemy.engine import CursorResult, Engine, Result
from sqlalchemy.pool import PoolProxiedConnection
from sqlmodel import create_engine

# SQLite busy timeout (seconds) — also set as PRAGMA so pooled reconnects match.
SQLITE_BUSY_TIMEOUT_MS = 15_000
SQLITE_CONNECT_ARGS: dict[str, Any] = {
    "check_same_thread": False,
    "timeout": SQLITE_BUSY_TIMEOUT_MS / 1000.0,
}


def sqlite_connection(raw: PoolProxiedConnection) -> sqlite3.Connection:
    """The ``sqlite3`` connection under a pooled one (for backup and VACUUM INTO)."""
    conn = raw.driver_connection
    if not isinstance(conn, sqlite3.Connection):
        raise TypeError(f"expected a sqlite3 connection, got {type(conn).__name__}")
    return conn


def rowcount(result: Result[Any]) -> int:
    """Rows matched by an UPDATE/DELETE/INSERT (``Session.execute`` types it as Result)."""
    return cast(CursorResult[Any], result).rowcount or 0


def _sqlite_regexp(pattern: Any, value: Any) -> int:
    """SQLite ``X REGEXP Y`` callback (pattern is Y, value is X)."""
    if pattern is None or value is None:
        return 0
    try:
        return 1 if re.search(str(pattern), str(value)) is not None else 0
    except re.error:
        return 0


def _configure_sqlite_connection(dbapi_conn: Any, _connection_record: Any) -> None:
    cursor = dbapi_conn.cursor()
    try:
        cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        # Enforce the ON DELETE rules declared in models.py. Alembic switches
        # this off for the duration of a migration (see migrations/env.py).
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        cursor.close()
    dbapi_conn.create_function("REGEXP", 2, _sqlite_regexp, deterministic=True)


def create_sqlite_engine(url: str) -> Engine:
    """File-backed SQLite engine with WAL and a busy timeout."""
    eng = create_engine(url, connect_args=SQLITE_CONNECT_ARGS)
    if str(url).startswith("sqlite"):
        event.listen(eng, "connect", _configure_sqlite_connection)
    return eng


def init_db(eng: Engine | None = None) -> None:
    """Create or upgrade the schema to the latest Alembic revision.

    See ``app/migrations/runner.py`` for the startup algorithm. ``eng``
    defaults to the active context's engine.
    """
    # Import models so SQLModel registers tables for Alembic's metadata.
    from . import models  # noqa: F401 - import registers the tables with SQLModel metadata
    from .context import get_engine
    from .migrations.runner import upgrade_database

    upgrade_database(eng if eng is not None else get_engine())

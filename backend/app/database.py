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
from collections.abc import Generator
from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlmodel import Session, create_engine

from .config import DATABASE_URL

# SQLite busy timeout (seconds) — also set as PRAGMA so pooled reconnects match.
SQLITE_BUSY_TIMEOUT_MS = 15_000
SQLITE_CONNECT_ARGS: dict[str, Any] = {
    "check_same_thread": False,
    "timeout": SQLITE_BUSY_TIMEOUT_MS / 1000.0,
}


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


engine = create_sqlite_engine(DATABASE_URL)


def init_db(eng: Engine | None = None) -> None:
    """Create or upgrade the schema to the latest Alembic revision.

    See ``app/migrations/runner.py`` for the startup algorithm. ``eng``
    defaults to the module engine (looked up at call time so tests can
    rebind it).
    """
    # Import models so SQLModel registers tables for Alembic's metadata.
    from . import models  # noqa: F401 - import registers the tables with SQLModel metadata
    from .migrations.runner import upgrade_database

    upgrade_database(eng if eng is not None else engine)


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session

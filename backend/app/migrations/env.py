"""Alembic environment: runs against the app engine, batch mode for SQLite."""

from __future__ import annotations

import logging
from logging.config import fileConfig

from alembic import context
from sqlalchemy.engine import Connection, Engine
from sqlmodel import SQLModel

from app import models  # noqa: F401 - registers tables on SQLModel.metadata
from app.migrations.runner import CONTEXT_OPTIONS

config = context.config
# Only the developer CLI has an ini file; the app configures its own logging.
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

logger = logging.getLogger("alembic.env")
target_metadata = SQLModel.metadata


def _run_migrations(connection: Connection) -> None:
    """Run all pending revisions on one SQLite connection, all-or-nothing.

    SQLite batch operations rebuild tables (create new, copy, drop old, rename).
    With ``PRAGMA foreign_keys=ON`` the drop would cascade into child rows, so
    enforcement is switched off first (the pragma is a no-op inside a
    transaction) and a violation check runs before commit. The explicit BEGIN
    makes DDL transactional, which pysqlite does not do on its own: a failing
    revision leaves the database untouched instead of half rebuilt.
    """
    connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
    connection.exec_driver_sql("BEGIN IMMEDIATE")
    try:
        context.configure(
            connection=connection, target_metadata=target_metadata, **CONTEXT_OPTIONS
        )
        with context.begin_transaction():
            context.run_migrations()
        violations = connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError(
                "Migration left foreign key violations "
                f"(table, rowid, parent, fk): {violations[:10]}"
            )
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        connection.commit()


def run_migrations_online() -> None:
    engine: Engine | None = config.attributes.get("engine")
    if engine is None:
        from app.database import engine as app_engine

        engine = app_engine
    with engine.connect() as connection:
        _run_migrations(connection)


def run_migrations_offline() -> None:
    from app.config import DATABASE_URL

    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        **CONTEXT_OPTIONS,
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

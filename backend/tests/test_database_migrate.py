"""Tests for additive SQLite migrations and verify_schema."""

import pytest
from sqlalchemy import inspect, text
from sqlmodel import SQLModel


def test_migrate_adds_missing_column(tmp_dirs, monkeypatch):
    from app import models  # noqa: F401
    from app import database

    engine = tmp_dirs["engine"]
    # Minimal videos table missing a known migrated column.
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE videos ("
                "id INTEGER PRIMARY KEY, "
                "title VARCHAR NOT NULL, "
                "tags VARCHAR DEFAULT '[]', "
                "file_path VARCHAR NOT NULL UNIQUE"
                ")"
            )
        )

    database._migrate_columns()
    cols = {c["name"] for c in inspect(engine).get_columns("videos")}
    assert "notes" in cols
    assert "channel_url" in cols
    database.verify_schema()
    assert "2026_07_additive_columns" in database.applied_migrations()


def test_migrate_is_idempotent(tmp_dirs):
    from app.database import _migrate_columns, applied_migrations, init_db

    init_db()
    first = applied_migrations()
    _migrate_columns()
    assert applied_migrations() == first


def test_verify_schema_fails_on_drift(tmp_dirs):
    from app import models  # noqa: F401
    from app import database

    engine = tmp_dirs["engine"]
    SQLModel.metadata.create_all(engine)
    database._migrate_columns()
    database.verify_schema()

    # Simulate drift: drop a migrated column is awkward on SQLite; instead
    # temporarily lie about expected columns.
    original = list(database._VIDEO_COLUMNS)
    try:
        database._VIDEO_COLUMNS.append(("definitely_missing_col", "VARCHAR"))
        with pytest.raises(RuntimeError, match="definitely_missing_col"):
            database.verify_schema()
    finally:
        database._VIDEO_COLUMNS[:] = original


def test_init_db_on_fresh_temp(tmp_dirs):
    from app.database import init_db, verify_schema

    init_db()
    verify_schema()


def test_engine_enables_wal(init_db):
    from sqlalchemy import text

    from app.database import engine

    with engine.connect() as conn:
        mode = conn.execute(text("PRAGMA journal_mode")).scalar()
    assert str(mode).lower() == "wal"


def test_engine_registers_regexp(init_db):
    from sqlalchemy import text

    from app.database import engine

    with engine.connect() as conn:
        hit = conn.execute(
            text(
                "SELECT 'a used car' REGEXP '(?i)(?<![a-z0-9])car(?![a-z0-9])'"
            )
        ).scalar()
        miss = conn.execute(
            text(
                "SELECT 'graphics card' REGEXP '(?i)(?<![a-z0-9])car(?![a-z0-9])'"
            )
        ).scalar()
    assert hit == 1
    assert miss == 0

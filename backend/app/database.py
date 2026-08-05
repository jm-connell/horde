"""SQLite engine, additive migrations, and schema verification.

Migrations are recorded in ``schema_migrations`` so order is explicit and tests
can assert idempotency. New columns still use ``ALTER TABLE … ADD COLUMN``;
destructive one-shots can be added as numbered Python steps later.
"""

from __future__ import annotations

from collections.abc import Callable, Generator
from datetime import datetime, timezone

from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

from .config import DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)

# Columns added after the initial schema. SQLite lacks rich migrations, so we
# add any that are missing on startup. Each entry is (column, SQL definition).
_VIDEO_COLUMNS = [
    ("channel_url", "VARCHAR"),
    ("notes", "VARCHAR"),
    ("subtitles", "VARCHAR DEFAULT '[]'"),
    ("width_px", "INTEGER"),
    ("height_px", "INTEGER"),
    ("last_position_sec", "FLOAT DEFAULT 0"),
    ("last_watched_at", "VARCHAR"),
    ("view_count", "INTEGER"),
    ("channel_subscriber_count", "INTEGER"),
    ("frame_rate", "FLOAT"),
    ("metadata_synced_at", "VARCHAR"),
    ("source_title", "VARCHAR"),
    ("source_description", "VARCHAR"),
    ("title_is_custom", "BOOLEAN DEFAULT 0"),
    ("description_is_custom", "BOOLEAN DEFAULT 0"),
    ("subtitles_pending", "BOOLEAN DEFAULT 0"),
    ("sprite_path", "VARCHAR"),
]

_DOWNLOAD_JOB_COLUMNS = [
    ("title_override", "VARCHAR"),
    ("channel_override", "VARCHAR"),
    ("channel", "VARCHAR"),
    ("thumbnail_url", "VARCHAR"),
    ("notes_pending", "VARCHAR"),
    ("paused", "BOOLEAN DEFAULT 0"),
    ("normalize_volume", "BOOLEAN DEFAULT 0"),
    ("destination", "VARCHAR DEFAULT 'library'"),
    ("device_file_path", "VARCHAR"),
    ("replace_video_id", "INTEGER"),
    ("file_size", "INTEGER"),
    ("error_kind", "VARCHAR"),
]

_VIDEO_AI_META_COLUMNS = [
    ("ai_tags", "VARCHAR DEFAULT '[]'"),
    ("user_tags", "VARCHAR DEFAULT '[]'"),
    ("summary", "VARCHAR"),
    ("summary_length", "VARCHAR"),
    ("summary_cost", "FLOAT"),
    ("summary_model", "VARCHAR"),
    ("embed_error", "VARCHAR"),
]

_VIDEO_AI_CHAT_MESSAGE_COLUMNS = [
    ("cost", "FLOAT"),
    ("model", "VARCHAR"),
]

_AI_JOB_COLUMNS = [
    ("catalog_video_id", "INTEGER"),
]

_CHANNEL_CATALOG_COLUMNS = [
    ("phase", "VARCHAR"),
    ("channel_total", "INTEGER"),
    ("complete", "BOOLEAN DEFAULT 0"),
]

_AI_CATEGORY_COLUMNS = [
    ("blurb", "VARCHAR"),
]


def _migrate_table(table: str, columns: list[tuple[str, str]]) -> None:
    inspector = inspect(engine)
    if table not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns(table)}
    with engine.begin() as conn:
        for name, definition in columns:
            if name not in existing:
                conn.execute(
                    text(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
                )


def _ensure_schema_migrations_table() -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "id VARCHAR PRIMARY KEY, "
                "applied_at VARCHAR NOT NULL"
                ")"
            )
        )


def _applied_migration_ids() -> set[str]:
    inspector = inspect(engine)
    if "schema_migrations" not in inspector.get_table_names():
        return set()
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT id FROM schema_migrations")).fetchall()
    return {str(row[0]) for row in rows}


def _record_migration(step_id: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT OR IGNORE INTO schema_migrations (id, applied_at) "
                "VALUES (:id, :applied_at)"
            ),
            {"id": step_id, "applied_at": now},
        )


def _step_add_columns() -> None:
    """Idempotent additive ALTER TABLE pass (safe to re-run)."""
    _migrate_table("videos", _VIDEO_COLUMNS)
    _migrate_table("download_jobs", _DOWNLOAD_JOB_COLUMNS)
    _migrate_table("video_ai_meta", _VIDEO_AI_META_COLUMNS)
    _migrate_table("video_ai_chat_messages", _VIDEO_AI_CHAT_MESSAGE_COLUMNS)
    _migrate_table("ai_jobs", _AI_JOB_COLUMNS)
    _migrate_table("channel_catalogs", _CHANNEL_CATALOG_COLUMNS)
    _migrate_table("ai_categories", _AI_CATEGORY_COLUMNS)


# Ordered migration ledger. Additive column sync is always re-applied for safety
# on older DBs; the step id is recorded so future destructive migrations can
# follow the same pattern without Alembic.
MIGRATION_STEPS: list[tuple[str, Callable[[], None]]] = [
    ("2026_07_additive_columns", _step_add_columns),
]


def _migrate_columns() -> None:
    """Apply pending ledger steps, then always re-run additive column sync."""
    _ensure_schema_migrations_table()
    applied = _applied_migration_ids()
    for step_id, fn in MIGRATION_STEPS:
        if step_id in applied:
            continue
        fn()
        _record_migration(step_id)
    # Keep ALTER ADD COLUMN idempotent for DBs created before the ledger and
    # for columns appended to the lists after a step was already recorded.
    _step_add_columns()


def applied_migrations() -> list[str]:
    """Return applied migration ids in ledger order (for tests / health)."""
    applied = _applied_migration_ids()
    return [step_id for step_id, _ in MIGRATION_STEPS if step_id in applied]


def verify_schema() -> None:
    """Fail fast at startup if expected columns are still missing after migration."""
    inspector = inspect(engine)
    for table, columns in (
        ("videos", _VIDEO_COLUMNS),
        ("download_jobs", _DOWNLOAD_JOB_COLUMNS),
        ("video_ai_meta", _VIDEO_AI_META_COLUMNS),
        ("video_ai_chat_messages", _VIDEO_AI_CHAT_MESSAGE_COLUMNS),
        ("ai_jobs", _AI_JOB_COLUMNS),
        ("channel_catalogs", _CHANNEL_CATALOG_COLUMNS),
        ("ai_categories", _AI_CATEGORY_COLUMNS),
    ):
        if table not in inspector.get_table_names():
            continue
        existing = {col["name"] for col in inspector.get_columns(table)}
        missing = [name for name, _ in columns if name not in existing]
        if missing:
            raise RuntimeError(
                f"Database table {table!r} is missing columns {missing}. "
                "Delete data/horde.db to start fresh, or restart the backend "
                "so migrations can run."
            )


def init_db() -> None:
    # Import models so SQLModel registers tables before create_all.
    from . import models  # noqa: F401

    SQLModel.metadata.create_all(engine)
    _migrate_columns()
    verify_schema()


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session

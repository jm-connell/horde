from collections.abc import Generator

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
]

_DOWNLOAD_JOB_COLUMNS = [
    ("title_override", "VARCHAR"),
    ("channel_override", "VARCHAR"),
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


def _migrate_columns() -> None:
    _migrate_table("videos", _VIDEO_COLUMNS)
    _migrate_table("download_jobs", _DOWNLOAD_JOB_COLUMNS)


def verify_schema() -> None:
    """Fail fast at startup if expected columns are still missing after migration."""
    inspector = inspect(engine)
    for table, columns in (
        ("videos", _VIDEO_COLUMNS),
        ("download_jobs", _DOWNLOAD_JOB_COLUMNS),
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

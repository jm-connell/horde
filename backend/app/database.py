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
]


def _migrate_columns() -> None:
    inspector = inspect(engine)
    if "videos" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("videos")}
    with engine.begin() as conn:
        for name, definition in _VIDEO_COLUMNS:
            if name not in existing:
                conn.execute(text(f"ALTER TABLE videos ADD COLUMN {name} {definition}"))


def init_db() -> None:
    # Import models so SQLModel registers tables before create_all.
    from . import models  # noqa: F401

    SQLModel.metadata.create_all(engine)
    _migrate_columns()


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session

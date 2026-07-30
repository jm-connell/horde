"""Shared fixtures: isolate DATA_DIR / DOWNLOADS_DIR / SQLite from the real tree."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, create_engine

# backend/ is the import root (package name: app)
_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))


@pytest.fixture
def tmp_dirs(tmp_path, monkeypatch):
    """Point config paths at a fresh temp tree and rebind the DB engine."""
    data = (tmp_path / "data").resolve()
    downloads = (tmp_path / "downloads").resolve()
    data.mkdir()
    downloads.mkdir()
    db_path = data / "horde.db"
    database_url = f"sqlite:///{db_path}"

    monkeypatch.setenv("DATA_DIR", str(data))
    monkeypatch.setenv("DOWNLOADS_DIR", str(downloads))

    import app.config as cfg

    monkeypatch.setattr(cfg, "DATA_DIR", data)
    monkeypatch.setattr(cfg, "DOWNLOADS_DIR", downloads)
    monkeypatch.setattr(cfg, "THUMBNAILS_DIR", data / "thumbnails")
    monkeypatch.setattr(cfg, "SPRITES_DIR", data / "sprites")
    monkeypatch.setattr(cfg, "BACKGROUNDS_DIR", data / "backgrounds")
    monkeypatch.setattr(cfg, "FONTS_DIR", data / "fonts")
    monkeypatch.setattr(cfg, "DB_PATH", db_path)
    monkeypatch.setattr(cfg, "DATABASE_URL", database_url)

    import app.database as database

    new_engine = create_engine(
        database_url,
        connect_args={"check_same_thread": False},
    )
    monkeypatch.setattr(database, "engine", new_engine)

    # Modules that imported engine / DOWNLOADS_DIR at load time.
    for mod_name in (
        "app.services.downloader",
        "app.services.paths",
        "app.services.scanner",
        "app.services.app_settings",
    ):
        mod = sys.modules.get(mod_name)
        if mod is None:
            continue
        if hasattr(mod, "engine"):
            monkeypatch.setattr(mod, "engine", new_engine)
        if hasattr(mod, "DOWNLOADS_DIR"):
            monkeypatch.setattr(mod, "DOWNLOADS_DIR", downloads)

    return {"data": data, "downloads": downloads, "engine": new_engine, "db_path": db_path}


@pytest.fixture
def init_db(tmp_dirs):
    """Create all tables + run additive migrations on the temp engine."""
    from app import models  # noqa: F401
    from app.database import _migrate_columns, engine, verify_schema

    SQLModel.metadata.create_all(engine)
    _migrate_columns()
    verify_schema()
    return tmp_dirs


@pytest.fixture
def session(init_db):
    from app.database import engine

    with Session(engine) as s:
        yield s

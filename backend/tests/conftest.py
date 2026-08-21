"""Shared fixtures: isolate DATA_DIR / DOWNLOADS_DIR / SQLite from the real tree."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

import pytest
from sqlmodel import Session, SQLModel, create_engine

# backend/ is the import root (package name: app)
_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

_DIR_ATTRS = (
    "DOWNLOADS_DIR",
    "THUMBNAILS_DIR",
    "SPRITES_DIR",
    "BACKGROUNDS_DIR",
    "FONTS_DIR",
    "DATA_DIR",
    "DB_PATH",
    "DATABASE_URL",
)


def _rebind_imported_app_modules(monkeypatch, *, engine, dirs: dict[str, Any]) -> None:
    """Modules that `from app.config/database import X` keep a stale binding."""
    for name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if name != "app" and not name.startswith("app."):
            continue
        if hasattr(mod, "engine"):
            monkeypatch.setattr(mod, "engine", engine)
        for attr in _DIR_ATTRS:
            if hasattr(mod, attr) and attr in dirs:
                monkeypatch.setattr(mod, attr, dirs[attr])


@pytest.fixture
def tmp_dirs(tmp_path, monkeypatch):
    """Point config paths at a fresh temp tree and rebind the DB engine."""
    data = (tmp_path / "data").resolve()
    downloads = (tmp_path / "downloads").resolve()
    data.mkdir()
    downloads.mkdir()
    db_path = data / "horde.db"
    database_url = f"sqlite:///{db_path}"
    thumbnails = data / "thumbnails"
    sprites = data / "sprites"
    backgrounds = data / "backgrounds"
    fonts = data / "fonts"

    monkeypatch.setenv("DATA_DIR", str(data))
    monkeypatch.setenv("DOWNLOADS_DIR", str(downloads))

    import app.config as cfg

    monkeypatch.setattr(cfg, "DATA_DIR", data)
    monkeypatch.setattr(cfg, "DOWNLOADS_DIR", downloads)
    monkeypatch.setattr(cfg, "THUMBNAILS_DIR", thumbnails)
    monkeypatch.setattr(cfg, "SPRITES_DIR", sprites)
    monkeypatch.setattr(cfg, "BACKGROUNDS_DIR", backgrounds)
    monkeypatch.setattr(cfg, "FONTS_DIR", fonts)
    monkeypatch.setattr(cfg, "DB_PATH", db_path)
    monkeypatch.setattr(cfg, "DATABASE_URL", database_url)

    import app.database as database

    new_engine = create_engine(
        database_url,
        connect_args={"check_same_thread": False},
    )
    monkeypatch.setattr(database, "engine", new_engine)

    _rebind_imported_app_modules(
        monkeypatch,
        engine=new_engine,
        dirs={
            "DOWNLOADS_DIR": downloads,
            "THUMBNAILS_DIR": thumbnails,
            "SPRITES_DIR": sprites,
            "BACKGROUNDS_DIR": backgrounds,
            "FONTS_DIR": fonts,
            "DATA_DIR": data,
            "DB_PATH": db_path,
            "DATABASE_URL": database_url,
        },
    )

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


@pytest.fixture
def add_video(session, init_db) -> Callable[..., Any]:
    """Insert a Video row; optionally write a dummy media file under DOWNLOADS_DIR."""
    from app.models import Video, VideoStatus

    counter = {"n": 0}

    def _add(
        *,
        write_file: bool = False,
        file_bytes: bytes = b"\x00" * 256,
        tags: list[str] | str | None = None,
        **fields: Any,
    ) -> Video:
        counter["n"] += 1
        n = counter["n"]
        yt_id = fields.pop("yt_id", f"aaaaaaaaa{n:02d}")
        if "file_path" not in fields:
            channel = fields.get("channel") or "Alpha"
            title = fields.get("title") or f"Video {n}"
            fields["file_path"] = f"{channel}/2024/{title} [{yt_id}].mp4"
        if "title" not in fields:
            fields["title"] = f"Video {n}"
        if "channel" not in fields:
            fields["channel"] = "Alpha"
        if tags is None:
            raw_tags = fields.pop("tags", "[]")
        elif isinstance(tags, list):
            raw_tags = json.dumps(tags)
            fields.pop("tags", None)
        else:
            raw_tags = tags
            fields.pop("tags", None)
        video = Video(
            tags=raw_tags,
            status=fields.pop("status", VideoStatus.ready),
            duration_sec=fields.pop("duration_sec", 120.0),
            file_size=fields.pop("file_size", len(file_bytes) if write_file else 1024),
            **fields,
        )
        session.add(video)
        session.commit()
        session.refresh(video)
        if write_file:
            dest = init_db["downloads"] / video.file_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(file_bytes)
        return video

    return _add


@pytest.fixture
def app(init_db, monkeypatch):
    """FastAPI app with the real routers but no production lifespan/workers."""
    from fastapi import FastAPI
    from sqlmodel import Session as DBSession

    from app.api import (
        ai,
        app_settings,
        backgrounds,
        channels,
        downloads,
        fonts,
        playlists,
        preview,
        review,
        system,
        videos,
    )
    from app.database import get_session
    from app.main import health
    from app.services import downloader

    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    downloader.download_queue._global_paused = False
    monkeypatch.setattr(
        "app.services.ai.worker.enqueue_for_video",
        lambda *a, **k: None,
    )
    monkeypatch.setattr(
        "app.services.ai.provider.get_llm_provider",
        lambda: None,
    )

    test_app = FastAPI(title="Horde test")
    test_app.include_router(videos.router)
    test_app.include_router(channels.router)
    test_app.include_router(downloads.router)
    test_app.include_router(preview.router)
    test_app.include_router(review.router)
    test_app.include_router(playlists.router)
    test_app.include_router(app_settings.router)
    test_app.include_router(ai.router)
    test_app.include_router(system.router)
    test_app.include_router(backgrounds.router)
    test_app.include_router(fonts.router)
    test_app.add_api_route("/api/health", health, methods=["GET"])

    def _override_session():
        with DBSession(init_db["engine"]) as s:
            yield s

    test_app.dependency_overrides[get_session] = _override_session
    return test_app


@pytest.fixture
def client(app):
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


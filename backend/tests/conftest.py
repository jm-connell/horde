"""Shared fixtures: isolate DATA_DIR / DOWNLOADS_DIR / SQLite from the real tree."""

from __future__ import annotations

import json
import shutil
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session

# backend/ is the import root (package name: app)
_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

# Configure logging once up front: importing app.main inside a test would otherwise
# reset the root handlers that pytest's caplog installed for that test.
from app.logging_config import configure_logging  # noqa: E402 - needs the sys.path entry above

configure_logging()

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


@pytest.fixture(autouse=True)
def _join_background_workers():
    """Do not let sprite threads outlive the test that started them.

    Importing/scanning a library enqueues sprite builds on the process-wide pool.
    A build still running when the next test starts would keep using a torn-down
    engine, so wait for the backlog to drain and stop the pool's threads here (while
    the test's ``monkeypatch`` still points the modules at its engine and tmp
    dirs). The pool reopens for the next test.
    """
    from app.services import downloader, ffmpeg_progress
    from app.services.channel_catalog import runtime as catalog_runtime
    from app.services.sprites import sprite_pool

    # Lifespan tests shut these process-wide objects down; reopen them for the next test.
    sprite_pool.start()
    downloader.download_queue.start()
    ffmpeg_progress.children.reopen()
    catalog_runtime._stop.clear()
    yield
    assert sprite_pool.wait_idle(30), "sprite builds still running after test"
    assert sprite_pool.stop(timeout=30), "sprite threads still running after test"


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

    new_engine = database.create_sqlite_engine(database_url)
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

    return {
        "data": data,
        "downloads": downloads,
        "engine": new_engine,
        "db_path": db_path,
    }


@pytest.fixture(scope="session")
def _migrated_template_db(tmp_path_factory) -> Path:
    """A fully migrated database, built once through the real ``init_db`` path.

    Running every Alembic revision per test would dominate the suite; tests copy
    this file instead. Tests that exercise migrations call ``init_db`` themselves.
    """
    from app.database import create_sqlite_engine, init_db

    path = tmp_path_factory.mktemp("template-db") / "horde.db"
    template_engine = create_sqlite_engine(f"sqlite:///{path}")
    init_db(template_engine)
    with template_engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    template_engine.dispose()
    return path


@pytest.fixture
def init_db(tmp_dirs, _migrated_template_db):
    """Temp database at the latest schema (copy of the migrated template)."""
    shutil.copyfile(_migrated_template_db, tmp_dirs["db_path"])
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
        compat,
        downloads,
        fonts,
        playlists,
        preview,
        review,
        setup,
        system,
        videos,
    )
    from app.database import get_session
    from app.main import health, ping, ready
    from app.security import install_security
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
    test_app.include_router(compat.router)
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
    test_app.include_router(setup.router)
    test_app.add_api_route("/api/health", health, methods=["GET"])
    test_app.add_api_route("/api/ready", ready, methods=["GET"])
    test_app.add_api_route("/api/ping", ping, methods=["GET"])
    install_security(test_app)

    def _override_session():
        with DBSession(init_db["engine"]) as s:
            yield s

    test_app.dependency_overrides[get_session] = _override_session
    return test_app


@pytest.fixture
def client(app):
    """Test client that sends the CSRF header the SPA's api.ts adds to every mutation."""
    from fastapi.testclient import TestClient

    with TestClient(app, headers={"X-Horde-Request": "1"}) as c:
        yield c


@pytest.fixture
def raw_client(app):
    """Test client without the CSRF header: for negative tests of app/security.py."""
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _stub_dns(monkeypatch):
    """Keep url_safety hermetic: IP literals resolve to themselves, names to a public IP.

    Tests that need another answer monkeypatch ``url_safety._resolve`` themselves.
    """
    import ipaddress

    from app.services import url_safety

    def fake_resolve(host: str, port: int):
        try:
            return [ipaddress.ip_address(host)]
        except ValueError:
            pass
        if host == "localhost":
            return [ipaddress.ip_address("127.0.0.1")]
        return [ipaddress.ip_address("93.184.216.34")]

    monkeypatch.setattr(url_safety, "_resolve", fake_resolve)
    monkeypatch.delenv("HORDE_ALLOW_PRIVATE_URLS", raising=False)

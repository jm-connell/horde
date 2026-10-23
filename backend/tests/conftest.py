"""Shared fixtures: isolate DATA_DIR / DOWNLOADS_DIR / SQLite from the real tree."""

from __future__ import annotations

import json
import os
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


# pytest can be started by git itself (a hook, ``git rebase --exec``), which exports
# GIT_DIR and friends. The update-script tests run ``git init`` / ``git clone``; with
# those variables set they would act on the surrounding repository instead of their
# own. Strip every GIT_* variable so each subprocess starts clean.
for _name in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_name]


@pytest.fixture(autouse=True)
def _no_inherited_git_env(monkeypatch):
    """Keep GIT_* out of every test, even if a plugin or hook sets them later."""
    for name in [k for k in os.environ if k.startswith("GIT_")]:
        monkeypatch.delenv(name)


@pytest.fixture(autouse=True)
def _no_env_context(monkeypatch):
    """Tests build their context explicitly; none may fall back to ``./data``."""
    from app import context

    monkeypatch.setattr(context, "env_fallback_allowed", False)


@pytest.fixture(autouse=True)
def _cheap_password_hashing(monkeypatch):
    """scrypt at production cost takes ~100 ms; tests only need the same code path."""
    from app.services.auth import passwords

    monkeypatch.setattr(passwords, "CURRENT_PARAMS", passwords.ScryptParams(n=2**4))


@pytest.fixture(autouse=True)
def _join_background_workers():
    """Do not let sprite threads outlive the test that started them.

    Importing/scanning a library enqueues sprite builds on the process-wide pool.
    A build still running when the next test starts would keep using a torn-down
    engine, so wait for the backlog to drain and stop the pool's threads here (while
    the test's ``monkeypatch`` still points the modules at its engine and tmp
    dirs). The pool reopens for the next test.
    """
    from app.services import ffmpeg_progress
    from app.services.channel_catalog import runtime as catalog_runtime
    from app.services.downloads.queue import download_queue
    from app.services.sprites import sprite_pool

    # Lifespan tests shut these process-wide objects down; reopen them for the next test.
    sprite_pool.start()
    download_queue.start()
    ffmpeg_progress.children.reopen()
    catalog_runtime._stop.clear()
    yield
    assert sprite_pool.wait_idle(30), "sprite builds still running after test"
    assert sprite_pool.stop(timeout=30), "sprite threads still running after test"


@pytest.fixture(autouse=True)
def _no_free_space_floor(monkeypatch):
    """The machine running the tests may be short of disk; tests that care set their own floor."""
    from app import config

    monkeypatch.setattr(config, "MIN_FREE_GB", 0.0)


@pytest.fixture(autouse=True)
def _trash_off(monkeypatch):
    """Deletes are immediate unless a test turns the trash on (tests/test_trash.py)."""
    from app import config

    monkeypatch.setattr(config, "TRASH_DAYS", 0)


@pytest.fixture
def tmp_dirs(tmp_path, monkeypatch):
    """A fresh AppContext over a temp tree, active for the length of the test."""
    from app import context

    data = (tmp_path / "data").resolve()
    downloads = (tmp_path / "downloads").resolve()
    data.mkdir()
    downloads.mkdir()
    monkeypatch.setenv("DATA_DIR", str(data))
    monkeypatch.setenv("DOWNLOADS_DIR", str(downloads))

    ctx = context.build_context(
        context.Paths(downloads=downloads, data=data), e2e=False
    )
    previous = context.activate(ctx)
    yield {
        "data": data,
        "downloads": downloads,
        "engine": ctx.engine,
        "db_path": ctx.paths.db_path,
        "ctx": ctx,
    }
    context.deactivate(previous)
    ctx.engine.dispose()


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
    with Session(init_db["engine"]) as s:
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
def set_watch(session) -> Callable[..., Any]:
    """Record a user's watch state for a video (their place and when they were there)."""
    from datetime import UTC, datetime

    from app.models import UserVideoState

    def _set(user, video, position_sec: float, watched_at=None) -> None:
        session.add(
            UserVideoState(
                user_id=user.id,
                video_id=video.id,
                position_sec=position_sec,
                last_watched_at=watched_at or datetime.now(UTC),
            )
        )
        session.commit()

    return _set


@pytest.fixture
def app(init_db, monkeypatch):
    """FastAPI app with the real routers but no production lifespan/workers."""
    from fastapi import FastAPI

    from app.context import install_context
    from app.main import include_api, install_caches
    from app.security import install_security
    from app.services.auth.runtime import AuthConfig
    from app.services.downloads.queue import DownloadQueue, download_queue

    monkeypatch.setattr(DownloadQueue, "_dispatch", lambda self: None)
    download_queue.reset()
    monkeypatch.setattr(
        "app.services.ai.worker.enqueue_for_video",
        lambda *a, **k: None,
    )
    monkeypatch.setattr(
        "app.services.ai.provider.get_llm_provider",
        lambda: None,
    )

    test_app = FastAPI(title="Horde test")
    include_api(test_app)
    # Explicit config so a developer's HORDE_AUTH_DISABLED never leaks into tests.
    install_security(test_app, auth_config=AuthConfig())

    install_context(test_app, init_db["ctx"])
    install_caches(test_app, init_db["ctx"])
    return test_app


ADMIN_PASSWORD = "admin-password"
MEMBER_PASSWORD = "member-password"
CSRF = {"X-Horde-Request": "1"}


def _make_user(init_db, username: str, password: str, *, is_admin: bool):
    from app.services.auth import accounts

    with Session(init_db["engine"]) as s:
        return accounts.create_user(s, username, password, is_admin=is_admin)


def _session_cookie(init_db, user) -> dict[str, str]:
    from app.services.auth import accounts

    with Session(init_db["engine"]) as s:
        return {accounts.SESSION_COOKIE: accounts.start_session(s, user)}


@pytest.fixture
def admin_user(init_db):
    """The administrator: the first user created, so legacy history would be theirs."""
    return _make_user(init_db, "admin", ADMIN_PASSWORD, is_admin=True)


@pytest.fixture
def member_user(init_db, admin_user):
    return _make_user(init_db, "member", MEMBER_PASSWORD, is_admin=False)


def _client(app, *, cookies=None, csrf=True):
    from fastapi.testclient import TestClient

    return TestClient(app, headers=CSRF if csrf else {}, cookies=cookies or {})


@pytest.fixture
def client(app, init_db, admin_user):
    """Signed in as the administrator, sending the CSRF header the SPA's api.ts adds."""
    with _client(app, cookies=_session_cookie(init_db, admin_user)) as c:
        yield c


@pytest.fixture
def member_client(app, init_db, member_user):
    """Signed in as a non-administrator."""
    with _client(app, cookies=_session_cookie(init_db, member_user)) as c:
        yield c


@pytest.fixture
def anon_client(app, init_db):
    """Not signed in (users exist, as on any installed server)."""
    with _client(app) as c:
        yield c


@pytest.fixture
def raw_client(app, init_db, admin_user):
    """Signed in but without the CSRF header: for negative tests of app/security.py."""
    with _client(app, cookies=_session_cookie(init_db, admin_user), csrf=False) as c:
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

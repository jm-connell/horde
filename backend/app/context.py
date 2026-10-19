"""The application context: everything one running Horde instance owns.

An ``AppContext`` holds the paths, the database engine, the download queues, the
worker registry and the auth runtime. ``lifespan`` builds one and stores it on
``app.state.ctx``; request handlers get it with ``Depends(get_ctx)`` and a database
session with ``Depends(get_session)``.

Background threads and plain service functions have no request to read it from, so
exactly one context is *active* per process (see ``activate``). Services reach the
directories and the engine through ``get_paths()`` / ``get_engine()`` instead of
importing frozen module constants. That is the single seam tests use too: a fixture
builds a fresh context over a temp directory and activates it, so no module has to
be patched one by one.

Nothing outside this module holds a path or an engine.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Generator
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import Depends, Request
from sqlalchemy.engine import Engine
from sqlmodel import Session

if TYPE_CHECKING:
    from .services.ai.state import AiRuntimeState
    from .services.auth.runtime import AuthRuntime
    from .services.downloads.ffmpeg_queue import FfmpegQueue
    from .services.downloads.queue import DownloadQueue
    from .services.live.runtime import LiveRuntime
    from .services.workers import WorkerRegistry

logger = logging.getLogger(__name__)

DOWNLOADS_DIR_ENV = "DOWNLOADS_DIR"
DATA_DIR_ENV = "DATA_DIR"


def _env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).resolve()


@dataclass(frozen=True)
class Paths:
    """Where an instance keeps the library (``downloads``) and its own data."""

    downloads: Path
    data: Path

    @classmethod
    def from_env(cls) -> Paths:
        """``DOWNLOADS_DIR`` and ``DATA_DIR``, read when called (not at import)."""
        return cls(
            downloads=_env_path(DOWNLOADS_DIR_ENV, "./downloads"),
            data=_env_path(DATA_DIR_ENV, "./data"),
        )

    @property
    def thumbnails(self) -> Path:
        return self.data / "thumbnails"

    @property
    def sprites(self) -> Path:
        return self.data / "sprites"

    @property
    def backgrounds(self) -> Path:
        return self.data / "backgrounds"

    @property
    def fonts(self) -> Path:
        return self.data / "fonts"

    @property
    def avatars(self) -> Path:
        return self.data / "avatars"

    @property
    def db_path(self) -> Path:
        return self.data / "horde.db"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path}"

    def ensure(self) -> None:
        """Create every directory the app writes to."""
        for directory in (
            self.downloads,
            self.data,
            self.thumbnails,
            self.sprites,
            self.backgrounds,
            self.fonts,
            self.avatars,
        ):
            directory.mkdir(parents=True, exist_ok=True)


@dataclass
class AppContext:
    """The objects one Horde instance runs on. Build with ``build_context``."""

    paths: Paths
    engine: Engine
    download_queue: DownloadQueue
    ffmpeg_queue: FfmpegQueue
    #: True only for the Playwright suite (``HORDE_E2E``): workers that would reach
    #: the network or spawn yt-dlp stay off and ``/api/e2e/reset`` exists.
    e2e: bool = False
    workers: WorkerRegistry = field(default_factory=lambda: _new_registry())
    shutdown_event: threading.Event = field(default_factory=threading.Event)
    ai: AiRuntimeState = field(default_factory=lambda: _new_ai_state())
    #: Who is live and the open live HLS sessions (services/live).
    live: LiveRuntime = field(default_factory=lambda: _new_live_runtime())
    #: The app's ``AuthRuntime`` (``install_context`` copies it from ``app.state``).
    auth: AuthRuntime | None = None
    #: Request-path caches (search results, duplicate groups); filled by whoever
    #: builds them so tests start from empty ones.
    caches: dict[str, Any] = field(default_factory=dict)

    def session(self) -> Session:
        """A new database session; the caller closes it."""
        return Session(self.engine)


def _new_ai_state() -> AiRuntimeState:
    from .services.ai.state import AiRuntimeState

    return AiRuntimeState()


def _new_live_runtime() -> LiveRuntime:
    from .services.live.runtime import LiveRuntime

    return LiveRuntime()


def _new_registry() -> WorkerRegistry:
    from .services.workers import WorkerRegistry

    return WorkerRegistry()


def build_context(
    paths: Paths | None = None,
    *,
    engine: Engine | None = None,
    e2e: bool | None = None,
) -> AppContext:
    """Assemble a context. Defaults come from the environment.

    The download queue's job runner is bound here rather than at import time, so
    importing the pipeline modules has no side effects and every context starts
    with its queues wired the same way.
    """
    from . import database
    from .e2e_mode import enabled
    from .services.downloads import runner
    from .services.downloads.ffmpeg_queue import ffmpeg_queue
    from .services.downloads.queue import download_queue

    paths = paths or Paths.from_env()
    is_e2e = enabled() if e2e is None else e2e
    ctx = AppContext(
        paths=paths,
        engine=engine or database.create_sqlite_engine(paths.database_url),
        download_queue=download_queue,
        ffmpeg_queue=ffmpeg_queue,
        e2e=is_e2e,
    )
    download_queue.runner = runner.run_download
    # Browser tests seed a queued job; never start yt-dlp from that process.
    download_queue.dispatch_enabled = not is_e2e
    return ctx


# --- The active context -------------------------------------------------------

# The one process-wide slot. Threads that serve no request (scanner, AI worker,
# download pool) read the context from here; lifespan and the test fixtures are the
# only writers. ``lifespan`` restores the previous value on shutdown.
_active: AppContext | None = None
_active_lock = threading.Lock()


def activate(ctx: AppContext) -> AppContext | None:
    """Make ``ctx`` the process's context; returns the one it replaced."""
    global _active
    with _active_lock:
        previous, _active = _active, ctx
    return previous


def deactivate(previous: AppContext | None) -> None:
    """Put back what ``activate`` returned."""
    global _active
    with _active_lock:
        _active = previous


#: Scripts and the CLI may call ``current()`` without ``lifespan``. The test suite
#: switches the fallback off, so a stray thread after teardown fails loudly instead
#: of creating ``./data`` in the working directory.
env_fallback_allowed = True


def current() -> AppContext:
    """The active context. Scripts that never ran ``lifespan`` get one from the env."""
    global _active
    ctx = _active
    if ctx is None:
        if not env_fallback_allowed:
            raise RuntimeError("no active AppContext (activate one before use)")
        with _active_lock:
            if _active is None:
                logger.debug("no active context; building one from the environment")
                _active = build_context()
            ctx = _active
    return ctx


def get_paths() -> Paths:
    return current().paths


def get_engine() -> Engine:
    return current().engine


def new_session() -> Session:
    """A session on the active engine: ``with new_session() as session:``."""
    return Session(current().engine)


# --- FastAPI dependencies -----------------------------------------------------


def install_context(app: Any, ctx: AppContext) -> None:
    """Publish ``ctx`` on ``app.state``.

    The worker registry and the shutdown event stay readable at their long-standing
    ``app.state`` names (the readiness probe, metrics and the SSE streams read
    them); both names point at the context's objects.
    """
    app.state.ctx = ctx
    app.state.workers = ctx.workers
    app.state.shutdown_event = ctx.shutdown_event
    ctx.auth = getattr(app.state, "auth", ctx.auth)


def ctx_for_app(app: Any) -> AppContext:
    """The context installed on ``app`` (the active one when none was installed)."""
    ctx = getattr(app.state, "ctx", None)
    return ctx if ctx is not None else current()


def get_ctx(request: Request) -> AppContext:
    """The context of the app serving this request."""
    return ctx_for_app(request.app)


def get_session(ctx: AppContext = Depends(get_ctx)) -> Generator[Session]:
    with Session(ctx.engine) as session:
        yield session

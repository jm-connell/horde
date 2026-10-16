import asyncio
import logging
import os
import shutil
import signal
import threading
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.engine import Engine

from .api import (
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
    users,
    videos,
)
from .api import (
    auth as auth_api,
)
from .auth import current_user, ensure_admin, require_admin
from .config import DATA_DIR, DOWNLOADS_DIR, ensure_dirs, short_git_sha
from .database import engine, init_db
from .errors import error_response
from .logging_config import configure_logging
from .openapi_responses import PROMETHEUS_TEXT
from .response_schemas import (
    ErrorResponse,
    HealthFull,
    HealthPublic,
    OkResponse,
    PingResponse,
    UpdateCheckRead,
)
from .schemas import ReadyResponse
from .security import install_security
from .services import app_settings as app_settings_svc
from .services import downloader, ffmpeg_progress
from .services.ai.worker import recover_ai_jobs
from .services.auth.accounts import AuthUser
from .services.backup import create_backup_worker
from .services.channel_catalog import recover_catalog_jobs
from .services.duplicate_groups import DuplicateGroupCache
from .services.health import HealthCache, build_readiness
from .services.metrics import CONTENT_TYPE as metrics_content_type
from .services.metrics import render_metrics
from .services.scanner import cleanup_orphans, create_scanner_workers
from .services.search_cache import SearchCache
from .services.storage_check import network_storage_warning
from .services.workers import WorkerRegistry

logger = logging.getLogger(__name__)

configure_logging()

logger = logging.getLogger(__name__)


def _frontend_dir() -> Path:
    """Production image uses backend/static. Browser e2e points at frontend/dist."""
    override = os.environ.get("HORDE_FRONTEND_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parent.parent / "static"


# Static frontend build copied next to the backend in the Docker image.
FRONTEND_DIR = _frontend_dir()
WIKI_DIR = FRONTEND_DIR / "wiki"


def _e2e_browser() -> bool:
    from .e2e_mode import enabled

    return enabled()


def _install_shutdown_signals(event: threading.Event) -> Callable[[], None]:
    """Set ``event`` the moment SIGINT/SIGTERM arrives, then defer to the old handler.

    Uvicorn waits for open connections before it runs the lifespan shutdown, so a
    stream that only watched a lifespan-set flag would hold the shutdown until the
    graceful timeout. Wrapping the handler lets streams end as soon as the signal
    lands. Only the main thread may install handlers (not true under TestClient).

    A signal that is ignored (``SIG_IGN``) or has no Python handler is left alone:
    the process will not shut down because of it, so the event must not be set.
    """
    if threading.current_thread() is not threading.main_thread():
        return lambda: None
    previous: dict[int, Any] = {}

    def make_handler(signum: int) -> Callable[[int, Any], None]:
        chained = previous[signum]

        def handler(received: int, frame: Any) -> None:
            event.set()
            if callable(chained):
                chained(received, frame)
            elif chained == signal.SIG_DFL:
                signal.signal(received, signal.SIG_DFL)
                signal.raise_signal(received)

        return handler

    for signum in (signal.SIGINT, signal.SIGTERM):
        old = signal.getsignal(signum)
        if not (callable(old) or old == signal.SIG_DFL):
            continue
        previous[signum] = old
        signal.signal(signum, make_handler(signum))

    def restore() -> None:
        for signum, old in previous.items():
            if old is not None:
                signal.signal(signum, old)

    return restore


def _start_workers(app_: FastAPI, registry: WorkerRegistry) -> None:
    """Recover interrupted work, then start every background worker.

    Workers stop in the reverse of this order, so what others depend on comes first.
    """
    from .services import (
        channel_autodownload,
        channel_catalog,
        compat_rendition,
        job_metadata,
        subtitle_retry,
    )
    from .services.ai import worker as ai_worker
    from .services.metadata_sync import create_sync_worker
    from .services.sprites import sprite_pool

    registry.start(ffmpeg_progress.children_worker())
    health = _health_cache(app_)
    if health.pot_base_url:
        registry.start(health.create_pot_worker())
    registry.start(downloader.download_queue)
    registry.start(downloader.ffmpeg_queue)
    registry.start(downloader.download_queue.create_reaper())
    downloader.download_queue.recover()
    downloader.gc_orphaned_device_dirs()
    from .services.temp_sweep import run_boot_cleanup

    run_boot_cleanup()
    recover_ai_jobs()
    recover_catalog_jobs()
    registry.start(sprite_pool)
    for worker in create_scanner_workers():
        registry.start(worker)
    settings = app_settings_svc.load()
    registry.start(create_sync_worker(settings.get("metadata_sync_interval_hours", 24)))
    for worker in ai_worker.create_workers():
        registry.start(worker)
    registry.start(channel_catalog.create_catalog_worker())
    registry.start(channel_autodownload.create_worker())
    registry.start(subtitle_retry.create_worker())
    registry.start(job_metadata.create_worker())
    job_metadata.rehydrate_pending()
    registry.start(compat_rendition.create_probe_backfill_worker())
    backup_worker = create_backup_worker(engine)
    if backup_worker is not None:
        registry.start(backup_worker)


def install_caches(app_: FastAPI, bind: Engine) -> None:
    """Build the request-path caches. ``lifespan`` and the test app both call this."""
    app_.state.search_cache = SearchCache()
    app_.state.search_cache.attach(bind)
    app_.state.duplicate_groups = DuplicateGroupCache()


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    if app.state.auth.config.disabled:
        logger.warning(
            "HORDE_AUTH_DISABLED is set: Horde is NOT asking anyone to sign in. "
            "Every request that reaches it acts as an administrator%s. Only use "
            "this behind a reverse proxy that authenticates users and is the only "
            "way to reach this port.",
            " (or the user named in the trusted header)"
            if app.state.auth.config.trusted_user_header
            else "",
        )
    shutdown_event = threading.Event()
    registry = WorkerRegistry()
    app.state.shutdown_event = shutdown_event
    app.state.workers = registry
    install_caches(app, engine)
    restore_signals = _install_shutdown_signals(shutdown_event)
    try:
        if _e2e_browser():
            from .e2e_seed import prepare

            prepare(os.environ.get("HORDE_E2E_MODE", "app"))
            yield
            return
        warning = network_storage_warning(DATA_DIR)
        app.state.storage_warning = warning
        if warning:
            logger.error("Storage problem: %s", warning)
        cleanup_orphans()
        from .services.ytdlp_common import ensure_plugins_loaded

        ensure_plugins_loaded()
        await preview.init_preview_client()
        _start_workers(app, registry)
        yield
    finally:
        shutdown_event.set()
        # Join in a thread: a worker mid-write must not block the event loop that
        # still has to finish closing the connections.
        stuck = await asyncio.to_thread(registry.stop_all)
        if stuck:
            logger.error("shutdown left running: %s", ", ".join(stuck))
        await preview.close_preview_client()
        restore_signals()


app = FastAPI(
    title="Horde",
    lifespan=lifespan,
    # Every route can fail with the envelope in app/errors.py; say so in the schema.
    responses={
        "default": {"model": ErrorResponse, "description": "Error"},
        422: {"model": ErrorResponse, "description": "Validation error"},
    },
)

# Host allowlist, CSRF, media-only CORS, security headers (see app/security.py).
install_security(app)


def _health_cache(app_: FastAPI) -> HealthCache:
    """The app's startup-computed health values (built on first use if absent)."""
    cache = getattr(app_.state, "health_cache", None)
    if cache is None:
        cache = app_.state.health_cache = HealthCache()
    return cache


def ping():
    """Liveness probe for the PWA: no DB or disk work, never cached."""
    return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})


def ready(request: Request):
    """Readiness probe: database reachable, migrations at head, workers alive."""
    report = build_readiness(
        request.app, engine, _health_cache(request.app).head_revision
    )
    return JSONResponse(report.model_dump(), status_code=200 if report.ready else 503)


def build_health_payload(app_: FastAPI) -> dict[str, Any]:
    """Everything ``GET /api/health`` returns, built from memory plus three COUNTs.

    Kept in one function so a caller can trim or wrap it (the unauthenticated view
    shows less than the signed-in one).
    """
    from sqlmodel import Session, func, select

    from .models import DownloadJob, JobStatus, Video

    cache = _health_cache(app_)
    with Session(engine) as session:
        video_count = session.scalar(select(func.count(Video.id))) or 0
        review_count = (
            session.scalar(
                select(func.count(Video.id)).where(Video.needs_review == True)  # noqa: E712 - SQL column comparison, not a Python truth test
            )
            or 0
        )
        active_downloads = (
            session.scalar(
                select(func.count(DownloadJob.id)).where(
                    DownloadJob.status.in_([JobStatus.downloading, JobStatus.queued])  # type: ignore[attr-defined]
                )
            )
            or 0
        )

    disk = None
    try:
        usage = shutil.disk_usage(DOWNLOADS_DIR)
        disk = {
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
        }
    except OSError:
        logger.debug("disk usage unavailable for %s", DOWNLOADS_DIR, exc_info=True)

    ollama = None
    openrouter = None
    # Health is polled every few seconds: failures below log at debug, not warning.
    try:
        from .services import app_settings as settings_svc
        from .services.ai.provider import (
            last_error,
            openrouter_api_key_set,
            openrouter_configured,
            pulling_models,
            resolve_base_url,
            resolve_openrouter_api_key,
        )

        # Keep health cheap for readiness probes (dev.bat Wait-ForBackend).
        # Full model status lives on GET /api/ai/status.
        ai = settings_svc.ai_settings()
        enabled = bool(ai.get("enabled", True))
        url = resolve_base_url() if enabled else None
        ollama = {
            "enabled": enabled,
            "ready": bool(url),
            "reachable": bool(url),
            "base_url": url,
            "pulling": pulling_models(),
            "last_error": last_error(),
        }
        or_enabled = bool(ai.get("openrouter_enabled"))
        key_set = openrouter_api_key_set(str(ai.get("openrouter_api_key") or ""))
        openrouter = {
            "enabled": or_enabled,
            "configured": openrouter_configured(),
            "api_key_set": key_set,
            "model": str(ai.get("openrouter_model") or ""),
            "scope": str(ai.get("openrouter_scope") or "specialized"),
            # Avoid remote ping on /health; presence of a key is enough here.
            "reachable": bool(or_enabled and resolve_openrouter_api_key()),
        }
    except Exception:
        logger.debug("AI status unavailable for health", exc_info=True)
        ollama = {"enabled": False, "ready": False, "reachable": False}
        openrouter = {"enabled": False, "configured": False, "reachable": False}

    sha = cache.git_sha

    downloads_paused = False
    cookies_ok = False
    last_extract = None
    ai_queue_depth = 0
    ai_running = 0
    ai_error_count = 0
    ai_blocked_reason = None
    catalog_queue_depth = 0
    catalog_indexing = False
    try:
        from .services import app_settings as settings_svc
        from .services.ai.worker import (
            blocked_reason,
            error_count,
            queue_breakdown,
            queue_depth,
        )
        from .services.channel_catalog import get_runtime_status
        from .services.ytdlp_common import (
            cookie_configured,
            get_last_extract_failure,
        )

        downloads_paused = bool(
            downloader.download_queue.is_paused()
            or settings_svc.load().get("download_queue_paused", False)
        )
        cookies_ok = cookie_configured()
        last_extract = get_last_extract_failure()
        ai_queue_depth = queue_depth()
        breakdown = queue_breakdown()
        ai_running = int(breakdown.get("running") or 0)
        ai_error_count = error_count()
        ai_blocked_reason = blocked_reason()
        cat = get_runtime_status()
        catalog_queue_depth = int(cat.get("queue_depth") or 0)
        catalog_indexing = bool(cat.get("running"))
    except Exception:
        logger.debug("worker status unavailable for health", exc_info=True)

    return {
        "status": "ok",
        "horde_sha": sha,
        "horde_version": short_git_sha(sha),
        "yt_dlp_version": cache.ytdlp_version,
        "ffmpeg": cache.ffmpeg(),
        "pot_provider": cache.pot_status(),
        "ollama": ollama,
        "openrouter": openrouter,
        "disk": disk,
        "storage_warning": getattr(app_.state, "storage_warning", None),
        "library_video_count": video_count,
        "review_pending_count": review_count,
        "active_downloads": active_downloads,
        "wiki_available": WIKI_DIR.is_dir(),
        "downloads": {
            "active": active_downloads,
            "paused": downloads_paused,
        },
        "workers": {
            "ai_queue_depth": ai_queue_depth,
            "ai_running": ai_running,
            "ai_error_count": ai_error_count,
            "ai_blocked_reason": ai_blocked_reason,
            "catalog_queue_depth": catalog_queue_depth,
            "catalog_indexing": catalog_indexing,
        },
        "youtube": {
            "cookies_configured": cookies_ok,
            "last_extract_failure": last_extract,
        },
    }


def _public_health(request: Request) -> dict[str, Any]:
    """All an anonymous caller (a load balancer, the sign-in page) gets to see."""
    from sqlmodel import Session

    from .services.auth import accounts

    with Session(engine) as session:
        users = accounts.count_users(session)
    return {
        "status": "ok",
        "setup_required": users == 0
        or not app_settings_svc.load().get("setup_completed"),
        "auth_required": not request.app.state.auth.config.disabled,
    }


def health(request: Request):
    """The full payload for a signed-in user; the bare minimum for anyone else."""
    if getattr(request.state, "user", None) is None:
        return _public_health(request)
    return build_health_payload(request.app)


def metrics(request: Request) -> PlainTextResponse:
    """Prometheus text format: queues, workers, database size, disk, request counts."""
    return PlainTextResponse(
        render_metrics(request.app, engine), media_type=metrics_content_type
    )


def updates(refresh: bool = False, user: AuthUser = Depends(current_user)):
    """Compare baked-in git SHA to GitHub main (24h cache). Soft-fails offline.

    Forcing a fresh check (``refresh``) is for administrators.
    """
    if refresh:
        ensure_admin(user)
    from .services.updates import check_for_updates

    return check_for_updates(refresh=refresh)


def include_api(target: FastAPI) -> None:
    """Mount every API router and the status routes on ``target``.

    One list for the production app and the tests' app, so a route added here is
    exercised (and introspected by the contract tests) exactly as it ships.
    """
    for module in (
        videos,
        compat,
        channels,
        downloads,
        preview,
        review,
        playlists,
        app_settings,
        ai,
        system,
        backgrounds,
        fonts,
        setup,
        auth_api,
        users,
    ):
        target.include_router(module.router)
    target.add_api_route(
        "/api/ping", ping, methods=["GET"], response_model=PingResponse
    )
    target.add_api_route(
        "/api/ready", ready, methods=["GET"], response_model=ReadyResponse
    )
    target.add_api_route(
        "/api/health",
        health,
        methods=["GET"],
        response_model=HealthFull | HealthPublic,
    )
    target.add_api_route(
        "/api/metrics",
        metrics,
        methods=["GET"],
        response_class=PlainTextResponse,
        responses=PROMETHEUS_TEXT,
        dependencies=[Depends(require_admin)],
    )
    target.add_api_route(
        "/api/updates", updates, methods=["GET"], response_model=UpdateCheckRead
    )


include_api(app)


if _e2e_browser():

    @app.post("/api/e2e/reset", response_model=OkResponse)
    def e2e_reset():
        """Restore browser-test data. Not mounted unless HORDE_E2E=1."""
        from .e2e_seed import prepare

        prepare(os.environ.get("HORDE_E2E_MODE", "app"))
        return {"ok": True}


class _ImmutableStaticFiles(StaticFiles):
    """Vite emits content-hashed asset names, so they never change in place."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code in (200, 206, 304):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


# Files the browser / service worker must revalidate on every load so app
# updates are picked up promptly. Everything else at the root (icons) may be
# cached briefly.
_REVALIDATE_FILES = {"index.html", "sw.js", "manifest.json"}


def _spa_file_response(path: Path) -> FileResponse:
    response = FileResponse(path)
    if path.name in _REVALIDATE_FILES:
        response.headers["Cache-Control"] = "no-cache"
    else:
        response.headers["Cache-Control"] = "public, max-age=86400"
    return response


def mount_frontend(target: FastAPI, frontend_dir: Path, wiki_dir: Path) -> None:
    """Serve the built React app (and wiki) from ``frontend_dir``."""
    target.mount(
        "/assets",
        _ImmutableStaticFiles(directory=frontend_dir / "assets"),
        name="assets",
    )

    # Mount before the SPA catch-all so /wiki/ is not swallowed by index.html.
    if wiki_dir.is_dir():
        target.mount(
            "/wiki",
            StaticFiles(directory=wiki_dir, html=True),
            name="wiki",
        )

    root = frontend_dir.resolve()

    @target.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        # Serve real files when present, otherwise fall back to the SPA entry.
        candidate = (frontend_dir / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(root):
            return _spa_file_response(candidate)
        if full_path.startswith("api/") or full_path == "sw.js":
            # Unknown API routes / missing worker must not look like a page:
            # the service worker would cache index.html as JSON or a script.
            return error_response(404, "Not Found", "not_found")
        return _spa_file_response(frontend_dir / "index.html")


if FRONTEND_DIR.exists():
    mount_frontend(app, FRONTEND_DIR, WIKI_DIR)

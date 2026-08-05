import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import (
    DOWNLOADS_DIR,
    YTDLP_POT_BASE_URL,
    ensure_dirs,
    resolve_git_sha,
    short_git_sha,
)
from .database import engine, init_db
from .api import (
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
from .services.scanner import cleanup_orphans, start_scanner
from .services import downloader, app_settings as app_settings_svc
from .services.ai import start_ai_worker, stop_ai_worker
from .services.ai.worker import recover_ai_jobs
from .services.channel_catalog import (
    recover_catalog_jobs,
    start_catalog_worker,
    stop_catalog_worker,
)

# Static frontend build copied next to the backend in the Docker image.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "static"
WIKI_DIR = FRONTEND_DIR / "wiki"


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    cleanup_orphans()
    from .services.ytdlp_common import ensure_plugins_loaded

    ensure_plugins_loaded()
    await preview.init_preview_client()
    downloader.download_queue.recover()
    downloader.gc_orphaned_device_dirs()
    recover_ai_jobs()
    recover_catalog_jobs()
    observer = start_scanner()

    from .services.metadata_sync import start_sync_worker
    settings = app_settings_svc.load()
    start_sync_worker(interval_hours=settings.get("metadata_sync_interval_hours", 24))
    start_ai_worker()
    start_catalog_worker()

    try:
        yield
    finally:
        stop_catalog_worker()
        stop_ai_worker()
        observer.stop()
        observer.join(timeout=5)
        await preview.close_preview_client()


app = FastAPI(title="Horde", lifespan=lifespan)

# Cast receivers fetch media/subtitle URLs cross-origin from the sender page.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "HEAD", "OPTIONS"],
    allow_headers=["Range", "Content-Type"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)

app.include_router(videos.router)
app.include_router(channels.router)
app.include_router(downloads.router)
app.include_router(preview.router)
app.include_router(review.router)
app.include_router(playlists.router)
app.include_router(app_settings.router)
app.include_router(ai.router)
app.include_router(system.router)
app.include_router(backgrounds.router)
app.include_router(fonts.router)


def _yt_dlp_version() -> str:
    try:
        result = subprocess.run(
            ["yt-dlp", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def _pot_provider_status() -> Optional[dict[str, Any]]:
    if not YTDLP_POT_BASE_URL:
        return None
    try:
        import httpx

        url = f"{YTDLP_POT_BASE_URL.rstrip('/')}/ping"
        response = httpx.get(url, timeout=2.0)
        if response.is_success:
            data = response.json()
            return {
                "status": "ok",
                "url": YTDLP_POT_BASE_URL,
                "version": data.get("version"),
            }
        return {
            "status": "error",
            "url": YTDLP_POT_BASE_URL,
            "detail": f"HTTP {response.status_code}",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "error",
            "url": YTDLP_POT_BASE_URL,
            "detail": str(exc),
        }


@app.get("/api/health")
def health():
    from .models import DownloadJob, JobStatus, Video
    from sqlmodel import Session, func, select

    with Session(engine) as session:
        video_count = session.scalar(select(func.count(Video.id))) or 0
        review_count = session.scalar(
            select(func.count(Video.id)).where(Video.needs_review == True)  # noqa: E712
        ) or 0
        active_downloads = session.scalar(
            select(func.count(DownloadJob.id)).where(
                DownloadJob.status.in_([JobStatus.downloading, JobStatus.queued])  # type: ignore[attr-defined]
            )
        ) or 0

    disk = None
    try:
        usage = shutil.disk_usage(DOWNLOADS_DIR)
        disk = {
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
        }
    except OSError:
        pass

    ollama = None
    openrouter = None
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
    except Exception:  # noqa: BLE001
        ollama = {"enabled": False, "ready": False, "reachable": False}
        openrouter = {"enabled": False, "configured": False, "reachable": False}

    sha = resolve_git_sha()

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
        from .services.ytdlp_common import (
            cookie_configured,
            get_last_extract_failure,
        )
        from .services.ai.worker import blocked_reason, error_count, queue_breakdown, queue_depth
        from .services.channel_catalog import get_runtime_status

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
    except Exception:  # noqa: BLE001
        pass

    return {
        "status": "ok",
        "horde_sha": sha,
        "horde_version": short_git_sha(sha),
        "yt_dlp_version": _yt_dlp_version(),
        "pot_provider": _pot_provider_status(),
        "ollama": ollama,
        "openrouter": openrouter,
        "disk": disk,
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


@app.get("/api/updates")
def updates(refresh: bool = False):
    """Compare baked-in git SHA to GitHub main (24h cache). Soft-fails offline."""
    from .services.updates import check_for_updates

    return check_for_updates(refresh=refresh)


if FRONTEND_DIR.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIR / "assets"),
        name="assets",
    )

    # Mount before the SPA catch-all so /wiki/ is not swallowed by index.html.
    if WIKI_DIR.is_dir():
        app.mount(
            "/wiki",
            StaticFiles(directory=WIKI_DIR, html=True),
            name="wiki",
        )

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        # Serve real files when present, otherwise fall back to the SPA entry.
        candidate = FRONTEND_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIR / "index.html")

import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import DOWNLOADS_DIR, YTDLP_POT_BASE_URL, ensure_dirs
from .database import engine, init_db
from .api import ai, app_settings, backgrounds, downloads, playlists, review, system, videos
from .services.scanner import cleanup_orphans, start_scanner
from .services import downloader, app_settings as app_settings_svc
from .services.ai import start_ai_worker, stop_ai_worker

# Static frontend build copied next to the backend in the Docker image.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    cleanup_orphans()
    from .services.ytdlp_common import ensure_plugins_loaded

    ensure_plugins_loaded()
    downloader.download_queue.recover()
    observer = start_scanner()

    from .services.metadata_sync import start_sync_worker
    settings = app_settings_svc.load()
    start_sync_worker(interval_hours=settings.get("metadata_sync_interval_hours", 24))
    start_ai_worker()

    try:
        yield
    finally:
        stop_ai_worker()
        observer.stop()
        observer.join(timeout=5)


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
app.include_router(downloads.router)
app.include_router(review.router)
app.include_router(playlists.router)
app.include_router(app_settings.router)
app.include_router(ai.router)
app.include_router(system.router)
app.include_router(backgrounds.router)


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
    try:
        from .services import app_settings as settings_svc
        from .services.ai.provider import (
            last_error,
            pulling_models,
            resolve_base_url,
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
    except Exception:  # noqa: BLE001
        ollama = {"enabled": False, "ready": False, "reachable": False}

    return {
        "status": "ok",
        "yt_dlp_version": _yt_dlp_version(),
        "pot_provider": _pot_provider_status(),
        "ollama": ollama,
        "disk": disk,
        "library_video_count": video_count,
        "review_pending_count": review_count,
        "active_downloads": active_downloads,
    }


if FRONTEND_DIR.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIR / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        # Serve real files when present, otherwise fall back to the SPA entry.
        candidate = FRONTEND_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIR / "index.html")

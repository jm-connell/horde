import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import DOWNLOADS_DIR, ensure_dirs
from .database import engine, init_db
from .api import app_settings, downloads, playlists, review, videos
from .services.scanner import cleanup_orphans, start_scanner
from .services import downloader, app_settings as app_settings_svc

# Static frontend build copied next to the backend in the Docker image.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    cleanup_orphans()
    downloader.download_queue.recover()
    observer = start_scanner()

    from .services.metadata_sync import start_sync_worker
    settings = app_settings_svc.load()
    start_sync_worker(interval_hours=settings.get("metadata_sync_interval_hours", 24))

    try:
        yield
    finally:
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

    return {
        "status": "ok",
        "yt_dlp_version": _yt_dlp_version(),
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

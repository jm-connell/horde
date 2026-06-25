import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from sqlmodel import Session

from ..config import DOWNLOADS_DIR, THUMBNAILS_DIR
from ..database import engine
from ..models import DownloadJob, JobStatus, Video, VideoStatus
from .metadata import probe_duration
from .paths import find_video_by_path, to_rel_path

# Live progress snapshots keyed by job id, consumed by the SSE endpoint.
progress_store: dict[int, dict[str, Any]] = {}

# bv*+ba/b = best video+audio merge, falling back to a single progressive file.
QUALITY_FORMATS = {
    "best": "bv*+ba/b",
    "1080p": "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
    "720p": "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
    "480p": "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b",
    "audio": "ba/b",
}

OUTPUT_TEMPLATE = str(
    DOWNLOADS_DIR / "%(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s].%(ext)s"
)


def _update_job(job_id: int, **fields: Any) -> None:
    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is None:
            return
        for key, value in fields.items():
            setattr(job, key, value)
        session.add(job)
        session.commit()


def _make_progress_hook(job_id: int):
    def hook(d: dict[str, Any]) -> None:
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            downloaded = d.get("downloaded_bytes", 0)
            percent = (downloaded / total * 100) if total else 0.0
            progress_store[job_id] = {
                "status": "downloading",
                "progress": round(percent, 1),
                "title": d.get("info_dict", {}).get("title"),
            }
        elif status == "finished":
            progress_store[job_id] = {"status": "processing", "progress": 99.0}

    return hook


def _save_thumbnail(url: Optional[str], video_id: int) -> Optional[str]:
    if not url:
        return None
    dest = THUMBNAILS_DIR / f"{video_id}.jpg"
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
        return str(dest)
    except (httpx.HTTPError, OSError):
        return None


def _published_at(info: dict[str, Any]) -> Optional[datetime]:
    raw = info.get("upload_date")  # YYYYMMDD
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y%m%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _run_download(job_id: int, url: str, quality_preset: str) -> None:
    import yt_dlp

    _update_job(job_id, status=JobStatus.downloading)
    progress_store[job_id] = {"status": "downloading", "progress": 0.0}

    ydl_opts = {
        "format": QUALITY_FORMATS.get(quality_preset, QUALITY_FORMATS["best"]),
        "outtmpl": OUTPUT_TEMPLATE,
        "progress_hooks": [_make_progress_hook(job_id)],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "merge_output_format": "mp4",
        # YouTube often breaks older clients; try multiple player APIs.
        "extractor_args": {
            "youtube": {
                "player_client": ["android_vr", "web", "ios"],
            },
        },
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            # merge_output_format can change the final extension.
            final_path = Path(filename)
            if not final_path.exists():
                mp4_candidate = final_path.with_suffix(".mp4")
                if mp4_candidate.exists():
                    final_path = mp4_candidate

        rel_path = to_rel_path(final_path)
        file_size = final_path.stat().st_size if final_path.exists() else None
        duration = info.get("duration") or probe_duration(final_path)

        with Session(engine) as session:
            video = find_video_by_path(session, rel_path)
            if video is None:
                video = Video(file_path=rel_path)
                session.add(video)

            video.title = info.get("title") or final_path.stem
            video.channel = info.get("uploader") or info.get("channel")
            video.description = info.get("description")
            video.source_url = info.get("webpage_url") or url
            video.duration_sec = duration
            video.file_size = file_size
            video.published_at = _published_at(info)
            video.needs_review = False
            video.platform = info.get("extractor_key")
            video.status = VideoStatus.ready
            # Normalize legacy backslash paths on re-import.
            video.file_path = rel_path

            session.commit()
            session.refresh(video)

            thumb = _save_thumbnail(info.get("thumbnail"), video.id)
            if thumb:
                video.thumbnail_path = thumb
                session.add(video)
                session.commit()

            video_id = video.id

        _update_job(
            job_id,
            status=JobStatus.completed,
            progress=100.0,
            title=info.get("title"),
            video_id=video_id,
        )
        progress_store[job_id] = {
            "status": "completed",
            "progress": 100.0,
            "video_id": video_id,
            "title": info.get("title"),
        }
    except Exception as exc:  # noqa: BLE001 - surface any yt-dlp failure to the UI
        _update_job(job_id, status=JobStatus.error, error=str(exc))
        progress_store[job_id] = {"status": "error", "error": str(exc)}


def start_download(job_id: int, url: str, quality_preset: str) -> None:
    thread = threading.Thread(
        target=_run_download,
        args=(job_id, url, quality_preset),
        daemon=True,
    )
    thread.start()

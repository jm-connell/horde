"""Fill title/thumbnail/presets for cheap-enqueued download jobs."""

from __future__ import annotations

import logging
import queue
import threading
from typing import Optional

from sqlmodel import Session

from ..database import engine
from ..models import DownloadJob, JobStatus
from .url_clean import youtube_video_id, youtube_thumbnail_url
from .ytdlp_common import EXTRACT_PRIORITY_BACKGROUND
from .ytdlp_extract import extract_preview, is_youtube_short_entry, is_youtube_short_url
from .ytdlp_formats import quality_from_preview

logger = logging.getLogger(__name__)

_pending: queue.Queue[int] = queue.Queue()
_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def request_job_metadata(job_id: Optional[int]) -> None:
    if job_id is None:
        return
    _pending.put(job_id)


def start_job_metadata_worker() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(
        target=_loop, name="job-metadata", daemon=True
    )
    _thread.start()


def stop_job_metadata_worker() -> None:
    _stop.set()
    _pending.put(-1)
    thread = _thread
    if thread is not None:
        thread.join(timeout=2)


def _loop() -> None:
    while not _stop.is_set():
        try:
            job_id = _pending.get(timeout=1.0)
        except queue.Empty:
            continue
        if job_id < 0 or _stop.is_set():
            continue
        try:
            _fill_job(job_id)
        except Exception:  # noqa: BLE001
            logger.debug("job metadata fill failed for %s", job_id, exc_info=True)


def _fill_job(job_id: int) -> None:
    from . import downloader

    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is None or job.status not in (JobStatus.queued, JobStatus.downloading):
            return
        url = job.url
        has_title = bool((job.title or "").strip())
        has_presets = bool(job.available_presets_json)
        requested = job.quality_preset or "best"

    if is_youtube_short_url(url):
        _drop_short(job_id, url)
        return

    if has_title and has_presets:
        return

    try:
        preview = extract_preview(url, priority=EXTRACT_PRIORITY_BACKGROUND)
    except Exception:  # noqa: BLE001
        logger.debug("job metadata extract failed for %s", job_id, exc_info=True)
        return

    if is_youtube_short_entry(
        {**(preview if isinstance(preview, dict) else {}), "url": url, "webpage_url": url}
    ):
        _drop_short(job_id, url)
        return

    if not isinstance(preview, dict) or preview.get("is_playlist"):
        return

    resolved, presets_json = quality_from_preview(requested, preview)
    yt_id = preview.get("id") or youtube_video_id(url)
    thumb = preview.get("thumbnail_url")
    if not thumb and yt_id:
        thumb = youtube_thumbnail_url(str(yt_id))

    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is None or job.status not in (JobStatus.queued, JobStatus.downloading):
            return
        if not (job.title or "").strip():
            job.title = preview.get("title") or job.title
        if not (job.channel or "").strip():
            job.channel = preview.get("channel") or job.channel
        if not job.thumbnail_url and thumb:
            job.thumbnail_url = thumb
        if presets_json:
            job.available_presets_json = presets_json
        if (job.quality_preset or "best") == "best" and resolved != "best":
            job.quality_preset = resolved
        session.add(job)
        session.commit()
        session.refresh(job)
        snap_title = job.title_override or job.title
        snap_channel = job.channel_override or job.channel
        snap_thumb = job.thumbnail_url
        snap_preset = job.quality_preset

    prev = downloader.progress_store.get(job_id, {})
    downloader.progress_store[job_id] = {
        **prev,
        "title": snap_title,
        "channel": snap_channel,
        "thumbnail_url": snap_thumb,
        "quality_preset": snap_preset,
        "available_presets": preview.get("available_presets") or [],
    }


def _drop_short(job_id: int, url: str) -> None:
    from . import downloader

    downloader.download_queue.cancel_job(job_id)
    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is None:
            downloader.progress_store[job_id] = {
                "status": "skipped",
                "reason": "shorts",
            }
            return
        if job.status in (JobStatus.queued, JobStatus.cancelled):
            session.delete(job)
            session.commit()
    downloader.progress_store[job_id] = {
        "status": "skipped",
        "reason": "shorts",
        "url": url,
    }

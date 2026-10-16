"""Creating, retrying and re-qualifying download jobs, and finding duplicates."""

import threading
import time
from typing import Any

from sqlmodel import Session, col, select

from ...models import DownloadDestination, DownloadJob, JobStatus, Video, require_id
from .. import library
from ..url_clean import clean_url, youtube_video_id
from ..ytdlp_formats import (
    QUALITY_FORMATS,
    decode_available_presets,
    resolve_quality_preset,
)
from .progress import progress_store
from .queue import download_queue
from .staging import cleanup_device_job_files

DUPLICATE_QUEUED = "already_queued"


DUPLICATE_DOWNLOADING = "already_downloading"


DUPLICATE_LIBRARY = "already_in_library"


DUPLICATE_MESSAGES = {
    DUPLICATE_QUEUED: "Already queued",
    DUPLICATE_DOWNLOADING: "Already downloading",
    DUPLICATE_LIBRARY: "Already in library",
}


def enqueue_download(job_id: int) -> None:
    download_queue.enqueue(job_id)


# Serialize create/retry so two clicks cannot insert two active rows.
job_mutate_lock = threading.Lock()


ACTIVE_JOB_STATUSES = (JobStatus.queued, JobStatus.downloading)


def find_active_job_for_identity(session: Session, url: str) -> DownloadJob | None:
    """Queued/downloading job for the same YouTube id (or cleaned URL)."""
    yt_id = youtube_video_id(url)
    cleaned = clean_url(url, keep_playlist=False) or url
    jobs = session.exec(
        select(DownloadJob)
        .where(col(DownloadJob.status).in_(list(ACTIVE_JOB_STATUSES)))
        .order_by(col(DownloadJob.id).asc())
    ).all()
    for job in jobs:
        other = job.url or ""
        if yt_id and youtube_video_id(other) == yt_id:
            return job
        if not yt_id and (clean_url(other, keep_playlist=False) or other) == cleaned:
            return job
    return None


def library_video_for_url(session: Session, url: str) -> Video | None:
    yt_id = youtube_video_id(url)
    if yt_id:
        return library.find_video_by_youtube_id(session, yt_id)
    cleaned = clean_url(url, keep_playlist=False)
    if not cleaned:
        return None
    return session.exec(select(Video).where(Video.source_url == cleaned)).first()


def classify_enqueue_duplicate(
    session: Session, url: str
) -> tuple[str, int | None] | None:
    """Return (code, existing_job_id) when this video must not be queued again."""
    active = find_active_job_for_identity(session, url)
    if active is not None:
        code = (
            DUPLICATE_DOWNLOADING
            if active.status == JobStatus.downloading
            else DUPLICATE_QUEUED
        )
        return code, active.id
    if library_video_for_url(session, url) is not None:
        return DUPLICATE_LIBRARY, None
    return None


def find_active_job(
    session: Session,
    url: str,
    destination: str,
    quality_preset: str,
) -> DownloadJob | None:
    """Return an already-queued/downloading job for the same video."""
    return find_active_job_for_identity(session, url)


def prepare_job_retry(job: DownloadJob) -> None:
    """Reset a failed/cancelled job so it can run again. Caller must commit."""
    if job.destination == DownloadDestination.device.value and job.id is not None:
        cleanup_device_job_files(job.id, job.device_file_path)
    job.status = JobStatus.queued
    job.progress = 0.0
    job.error = None
    job.error_kind = None
    job.paused = download_queue.is_paused()
    job.device_file_path = None
    job.file_size = None
    if job.id is not None:
        progress_store[job.id] = _queued_snapshot(job)


def wait_until_job_not_running(job_id: int, timeout: float = 30.0) -> bool:
    """Block until the worker thread for job_id has exited."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not download_queue.is_running(job_id):
            return True
        time.sleep(0.1)
    return not download_queue.is_running(job_id)


def _queued_snapshot(job: DownloadJob) -> dict[str, Any]:
    return {
        "status": "queued",
        "progress": 0.0,
        "title": job.title_override or job.title,
        "channel": job.channel_override or job.channel,
        "destination": job.destination,
    }


def _changeable_job(session: Session, job_id: int) -> DownloadJob:
    job = session.get(DownloadJob, job_id)
    if job is None:
        raise KeyError("Job not found")
    if job.status not in (JobStatus.queued, JobStatus.downloading):
        raise PermissionError("Job already finished")
    return job


def _save(session: Session, job: DownloadJob) -> DownloadJob:
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def _begin_restart(session: Session, job: DownloadJob, resolved: str) -> None:
    """Abort the running attempt and hold the job until the new preset is in place."""
    assert job.id is not None  # noqa: S101 - type narrowing; the row was committed above
    download_queue.request_quality_restart(job.id)
    job.quality_preset = resolved
    job.progress = 0.0
    job.error = None
    job.error_kind = None
    session.add(job)
    session.commit()
    progress_store[job.id] = _queued_snapshot(job)


def _abort_restart(session: Session, job_id: int, previous_preset: str) -> None:
    """The old attempt would not stop: put the previous preset back and release the job."""
    with job_mutate_lock:
        session.expire_all()
        job = session.get(DownloadJob, job_id)
        if job is not None and job.status == JobStatus.downloading:
            job.quality_preset = previous_preset
            _save(session, job)
        download_queue.release_job(job_id)


def _finish_restart(
    session: Session, job_id: int, resolved: str, previous_preset: str
) -> DownloadJob:
    """The old attempt has stopped: settle the row and queue the job again."""
    with job_mutate_lock:
        session.expire_all()
        job = session.get(DownloadJob, job_id)
        if job is None:
            download_queue.release_job(job_id)
            raise KeyError("Job not found")
        try:
            if job.status == JobStatus.completed:
                job.quality_preset = previous_preset
                return _save(session, job)
            job.quality_preset = resolved
            if job.status in (JobStatus.cancelled, JobStatus.error):
                prepare_job_retry(job)
            else:
                job.progress = 0.0
            _save(session, job)
        finally:
            download_queue.release_job(job_id)
        enqueue_download(require_id(job))
        return job


def change_job_quality(
    session: Session, job_id: int, requested_preset: str
) -> DownloadJob:
    """Change quality on a queued/downloading job. Restarts in-flight work silently."""
    preset = (requested_preset or "").strip()
    if preset not in QUALITY_FORMATS:
        raise ValueError("Unknown quality preset")

    with job_mutate_lock:
        job = _changeable_job(session, job_id)
        available = decode_available_presets(job.available_presets_json)
        resolved = resolve_quality_preset(preset, available)
        if resolved == job.quality_preset:
            return job

        other = find_active_job(
            session,
            job.url,
            job.destination or DownloadDestination.library.value,
            resolved,
        )
        if other is not None and other.id != job.id:
            raise FileExistsError("Another download at that quality is already active")

        previous_preset = job.quality_preset
        running = download_queue.is_running(job.id) if job.id is not None else False
        if not (running or job.status == JobStatus.downloading):
            job.quality_preset = resolved
            return _save(session, job)
        _begin_restart(session, job, resolved)

    if not wait_until_job_not_running(job_id):
        _abort_restart(session, job_id, previous_preset)
        raise TimeoutError("Could not restart download")
    return _finish_restart(session, job_id, resolved, previous_preset)

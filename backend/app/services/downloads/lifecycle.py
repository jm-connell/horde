"""How a job leaves the pipeline when it is stopped, requeued or fails.

These functions read the scheduler's state (paused, shutting down, quality
restart) through ``QueueState`` so they do not depend on the queue module.
"""

import logging
import threading
from typing import Protocol

from sqlmodel import Session

from ...database import engine
from ...models import DownloadDestination, DownloadJob, JobStatus
from ..ffmpeg_progress import FfmpegCancelled
from ..ytdlp_common import ERROR_KIND_CANCELLED, classify_ytdlp_error
from . import dbwrite
from .errors import DownloadCancelled
from .progress import progress_store
from .staging import cleanup_device_job_files, discard_staging_unless_requeued

logger = logging.getLogger(__name__)


class QueueState(Protocol):
    """What ending a job needs to know about the download queue."""

    def is_paused(self) -> bool: ...

    def is_shutting_down(self) -> bool: ...

    def take_quality_restart(self, job_id: int) -> bool: ...

    def cancel_event(self, job_id: int) -> threading.Event | None: ...


def force_job_error(job_id: int, exc: BaseException) -> None:
    """Last resort for a worker that died: end the job in ``error``, never stuck."""
    kind, message = classify_ytdlp_error(exc)
    try:
        dbwrite.update_job(
            job_id, status=JobStatus.error, error=message, error_kind=kind
        )
    except Exception:
        # The reaper requeues it if even this write cannot land.
        logger.exception("could not record failure of download job %s", job_id)
    progress_store[job_id] = {
        "status": "error",
        "error": message,
        "error_kind": kind,
    }
    try:
        discard_staging_unless_requeued(job_id)
    except Exception:
        logger.exception("could not clean staging for job %s", job_id)


def mark_job_cancelled(
    queue: QueueState,
    job_id: int,
    destination: str,
    *,
    requeue: bool = False,
) -> None:
    """End a job that was stopped. ``requeue`` puts it back in the queue instead."""
    if destination == DownloadDestination.device.value:
        cleanup_device_job_files(job_id)
    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is None:
            progress_store[job_id] = {
                "status": "cancelled",
                "error": "Cancelled",
                "error_kind": ERROR_KIND_CANCELLED,
            }
            return
        restarting = queue.take_quality_restart(job_id)
        pausing = queue.is_paused()
        # A job interrupted by shutdown goes back to the queue, like a pause, and
        # resumes from its staged .part files on the next boot.
        if restarting or pausing or requeue or queue.is_shutting_down():
            job.status = JobStatus.queued
            job.paused = pausing
            job.progress = 0.0
            job.error = None
            job.error_kind = None
            progress_store[job_id] = {
                "status": "queued",
                "progress": 0.0,
                "title": job.title_override or job.title,
                "channel": job.channel_override or job.channel,
                "destination": destination,
            }
        else:
            job.status = JobStatus.cancelled
            job.error = "Cancelled"
            job.error_kind = ERROR_KIND_CANCELLED
            job.progress = 0.0
            job.device_file_path = None
            progress_store[job_id] = {
                "status": "cancelled",
                "error": "Cancelled",
                "error_kind": ERROR_KIND_CANCELLED,
                "destination": destination,
            }
        session.add(job)
        session.commit()


def fail_postprocess_job(
    queue: QueueState, job_id: int, destination: str, exc: BaseException
) -> None:
    event = queue.cancel_event(job_id)
    if isinstance(exc, (FfmpegCancelled, DownloadCancelled)) or (
        event is not None and event.is_set()
    ):
        mark_job_cancelled(queue, job_id, destination)
        return
    kind, message = classify_ytdlp_error(exc)
    dbwrite.update_job(
        job_id,
        status=JobStatus.error,
        error=message,
        error_kind=kind,
    )
    progress_store[job_id] = {
        "status": "error",
        "error": message,
        "error_kind": kind,
        "destination": destination,
    }

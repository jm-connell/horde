"""Bounded postprocess stage, so a slow encode does not hold a download slot."""

import logging
import threading
import time

from ...logging_config import job_context
from .. import scanner
from . import lifecycle
from .errors import DownloadCancelled
from .finalize import complete_download
from .postprocess import PostprocessTask
from .queue import DownloadQueue, download_queue
from .staging import discard_staging_unless_requeued

logger = logging.getLogger(__name__)


def ffmpeg_slot_limit() -> int:
    from ...config import MAX_FFMPEG_CONCURRENCY

    if MAX_FFMPEG_CONCURRENCY is not None:
        return MAX_FFMPEG_CONCURRENCY
    try:
        from ..encode_probe import probe_encode_capabilities

        caps = probe_encode_capabilities()
        return 2 if caps.ffmpeg_has_hw_encoder else 1
    except Exception:
        logger.debug("encoder probe failed; using one ffmpeg slot", exc_info=True)
        return 1


class FfmpegQueue:
    """Bounded remux/transcode/loudnorm so a slow encode does not hold a download slot."""

    name = "ffmpeg-queue"
    stop_timeout = 10.0

    def __init__(self, downloads: DownloadQueue) -> None:
        self._downloads = downloads
        self._lock = threading.Lock()
        self._pending: list[PostprocessTask] = []
        self._running: set[int] = set()
        self._threads: set[threading.Thread] = set()

    # -- ManagedWorker protocol (registered by lifespan) -----------------------
    # Shutdown cancels in-flight encodes through the shared per-job cancel events
    # (set by ``DownloadQueue.signal_stop``); this queue drops what has not started.

    def start(self) -> None:
        return

    @property
    def is_alive(self) -> bool:
        return not self._downloads.is_shutting_down()

    @property
    def healthy(self) -> bool:
        return self.is_alive

    def signal_stop(self) -> None:
        with self._lock:
            pending, self._pending = self._pending, []
        for task in pending:
            self._abandon(task)

    def stop(self, timeout: float | None = None) -> bool:
        self.signal_stop()
        deadline = time.monotonic() + (10.0 if timeout is None else timeout)
        with self._lock:
            threads = list(self._threads)
        for thread in threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        with self._lock:
            return not any(t.is_alive() for t in self._threads)

    def _abandon(self, task: PostprocessTask) -> None:
        """Requeue a postprocess task that never started (shutdown)."""
        try:
            # Explicit: the download queue may not have been told to stop yet
            # (workers are signalled newest first), and a cancel would delete the
            # finished download that is waiting for its remux.
            lifecycle.mark_job_cancelled(
                self._downloads, task.job_id, task.destination, requeue=True
            )
        except Exception:
            logger.exception("could not requeue job %s at shutdown", task.job_id)
        for lib in task.active_marks:
            scanner.unmark_active(lib)
        try:
            discard_staging_unless_requeued(task.job_id)
        except Exception:
            logger.exception("could not clean staging for job %s", task.job_id)
        self._downloads.release_ffmpeg(task.job_id)

    def enqueue(self, task: PostprocessTask) -> None:
        self._downloads.claim_ffmpeg(task.job_id)
        with self._lock:
            self._pending.append(task)
        self._dispatch()

    def _dispatch(self) -> None:
        if self._downloads.is_shutting_down():
            self.signal_stop()
            return
        cap = ffmpeg_slot_limit()
        with self._lock:
            while self._pending and len(self._running) < cap:
                task = self._pending.pop(0)
                self._running.add(task.job_id)
                thread = threading.Thread(
                    target=self._worker,
                    args=(task,),
                    daemon=True,
                    name=f"ffmpeg-{task.job_id}",
                )
                self._threads.add(thread)
                thread.start()

    def _worker(self, task: PostprocessTask) -> None:
        with job_context(f"download-{task.job_id}"):
            self._run_task(task)

    def _run_task(self, task: PostprocessTask) -> None:
        try:
            complete_download(task)
        except DownloadCancelled:
            lifecycle.mark_job_cancelled(self._downloads, task.job_id, task.destination)
        except Exception as exc:
            logger.warning("postprocess of job %s failed", task.job_id, exc_info=True)
            lifecycle.fail_postprocess_job(
                self._downloads, task.job_id, task.destination, exc
            )
        finally:
            for lib in task.active_marks:
                scanner.unmark_active(lib)
            discard_staging_unless_requeued(task.job_id)
            with self._lock:
                self._running.discard(task.job_id)
                self._threads.discard(threading.current_thread())
            self._downloads.release_ffmpeg(task.job_id)
            # A finished video changes the library size the next job is checked against.
            self._downloads.library_changed()
            self._dispatch()


ffmpeg_queue = FfmpegQueue(download_queue)

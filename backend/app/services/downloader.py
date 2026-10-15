import contextlib
import logging
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR, MAX_DOWNLOAD_CONCURRENCY
from ..database import engine
from ..logging_config import FailureLog, job_context
from ..models import (
    DownloadDestination,
    DownloadJob,
    JobStatus,
    Playlist,
    PlaylistItem,
    Video,
    VideoStatus,
)
from . import activity, compat_rendition, library, scanner
from .downloads import artifacts, dbwrite
from .downloads.artifacts import (
    cleanup_partial_files,
    is_intermediate_media,
    reject_unplayable,
    resolve_merged_video,
)
from .downloads.errors import (
    DownloadCancelled,
    YtdlpLogger,
    is_recoverable_download_error,
    purge_members_only_url,
)
from .downloads.infodict import as_info, collect_tags, merge_info, published_at

# Facade: public names that moved to ``services/downloads`` (see the end of the
# import block); importers outside the package keep working through them.
from .downloads.staging import DEVICE_STAGING_DIR as DEVICE_STAGING_DIR
from .downloads.staging import (
    cleanup_device_job_files,
    device_job_dir,
    discard_staging_unless_requeued,
    download_outtmpl,
    library_rel,
    promote_from_staging,
    rollback_or_log,
)
from .downloads.staging import device_outtmpl as device_outtmpl
from .downloads.staging import gc_orphaned_device_dirs as gc_orphaned_device_dirs
from .downloads.staging import is_device_staging_path as is_device_staging_path
from .downloads.staging import remove_staging_dir as remove_staging_dir
from .ffmpeg_bin import ffmpeg_available, ffmpeg_bin
from .ffmpeg_progress import FfmpegCancelled, run_ffmpeg
from .fsutil import (
    MoveJournal,
    replace_with_retries,
    safe_rel,
    safe_unlink,
)
from .media_info import apply_stream_info, needs_compat, probe_stream_info
from .metadata import probe_dimensions, probe_duration
from .mp4_compat import CompatPlan, compat_plan, ensure_safari_mp4, probe_media
from .outtmpl import (
    windows_filenames_ok,
)
from .paths import (
    belongs_to_stem,
    find_video_by_path,
    resolve_compat_path,
    staging_dir,
    to_rel_path,
)
from .thumbnails import save_from_url as _save_thumbnail
from .url_clean import clean_url, youtube_thumbnail_url, youtube_video_id
from .url_safety import UnsafeUrlError, validate_public_url
from .video_delete import delete_video_cascade, remove_files
from .video_transcode import encode_target, transcode_video
from .workers import BackgroundWorker
from .ytdlp_common import (
    ERROR_KIND_CANCELLED,
    ERROR_KIND_MEMBERS,
    ERROR_KIND_UNKNOWN,
    EXTRACT_PRIORITY_DOWNLOAD,
    MembersOnlyError,
    QuietYtdlpLogger,
    apply_cookie_opts,
    classify_ytdlp_error,
    extract_has_media,
    extract_info_gated,
    extract_used_cookies,
    is_members_only_entry,
    is_members_only_error,
    record_extract_failure,
    remember_cookie_required,
    should_retry_with_cookies,
    url_cookie_required,
    youtube_extractor_args,
)
from .ytdlp_extract import (
    _list_thumbnail_url,
    is_youtube_short_entry,
    is_youtube_short_url,
)

# Facade: API routers and tests reach these through ``downloader.<name>`` (tests
# monkeypatch them here), so they are re-exported explicitly (``x as x``).
from .ytdlp_extract import estimate_playlist_sizes as estimate_playlist_sizes
from .ytdlp_extract import extract_playlist as extract_playlist
from .ytdlp_extract import extract_playlist_entries as extract_playlist_entries
from .ytdlp_extract import extract_preview as extract_preview
from .ytdlp_extract import fetch_channel_feed as fetch_channel_feed
from .ytdlp_extract import search_youtube_channels as search_youtube_channels
from .ytdlp_formats import (
    QUALITY_FORMATS,
    _format_chain,
    apply_audio_format_id,
    compat_copy_cap,
    decode_available_presets,
    default_download_video_codec,
    effective_max_height,
    format_sort_for,
    is_audio_preset,
    normalize_video_codec,
    pick_original_audio_format,
    resolve_quality_preset,
)
from .ytdlp_formats import _available_presets as _available_presets
from .ytdlp_formats import _has_audio as _has_audio
from .ytdlp_formats import _height_to_tier as _height_to_tier

logger = logging.getLogger(__name__)

_TERMINAL_PROGRESS = frozenset({"completed", "error", "cancelled", "skipped"})
PROGRESS_TTL_SECONDS = 600.0


class ProgressStore:
    """Live progress snapshots keyed by job id, consumed by the SSE endpoints.

    Dict-like, but thread-safe: ``merge`` is an atomic read-modify-write (workers,
    the metadata thread and ffmpeg callbacks all update the same job), and
    snapshots of finished jobs are pruned after a TTL so the map cannot grow
    without bound (the DB row is the source of truth afterwards).
    """

    def __init__(self, ttl: float = PROGRESS_TTL_SECONDS) -> None:
        self._lock = threading.RLock()
        self._data: dict[int, dict[str, Any]] = {}
        self._finished_at: dict[int, float] = {}
        self._ttl = ttl

    def __getitem__(self, job_id: int) -> dict[str, Any]:
        with self._lock:
            return self._data[job_id]

    def __setitem__(self, job_id: int, snapshot: dict[str, Any]) -> None:
        with self._lock:
            self._data[job_id] = snapshot
            if snapshot.get("status") in _TERMINAL_PROGRESS:
                self._finished_at[job_id] = time.monotonic()
            else:
                self._finished_at.pop(job_id, None)

    def __contains__(self, job_id: object) -> bool:
        with self._lock:
            return job_id in self._data

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def get(self, job_id: int, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(job_id, default)

    def pop(self, job_id: int, *default: Any) -> Any:
        with self._lock:
            self._finished_at.pop(job_id, None)
            return self._data.pop(job_id, *default)

    def items(self) -> list[tuple[int, dict[str, Any]]]:
        with self._lock:
            return list(self._data.items())

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
            self._finished_at.clear()

    def merge(self, job_id: int, fields: dict[str, Any]) -> dict[str, Any]:
        """Atomically overlay ``fields`` on the job's snapshot and return it."""
        with self._lock:
            snap = {**self._data.get(job_id, {}), **fields}
            self[job_id] = snap
            return snap

    def prune(self, now: float | None = None) -> int:
        """Drop snapshots of jobs that finished more than the TTL ago."""
        cutoff = (time.monotonic() if now is None else now) - self._ttl
        with self._lock:
            stale = [j for j, t in self._finished_at.items() if t <= cutoff]
            for job_id in stale:
                self._data.pop(job_id, None)
                self._finished_at.pop(job_id, None)
            return len(stale)


progress_store = ProgressStore()

DUPLICATE_QUEUED = "already_queued"
DUPLICATE_DOWNLOADING = "already_downloading"
DUPLICATE_LIBRARY = "already_in_library"
DUPLICATE_MESSAGES = {
    DUPLICATE_QUEUED: "Already queued",
    DUPLICATE_DOWNLOADING: "Already downloading",
    DUPLICATE_LIBRARY: "Already in library",
}

# SSE `stage` tokens while status is `processing` (download card / watch indicator).
STAGE_MERGING = "merging"
STAGE_ENCODING_AUDIO = "encoding_audio"
STAGE_REMUXING = "remuxing"
STAGE_TRANSCODING = "transcoding"
STAGE_NORMALIZING = "normalizing"

_STAGE_ACTIVITY_DETAIL = {
    STAGE_MERGING: "Merging streams",
    STAGE_ENCODING_AUDIO: "Encoding audio to AAC",
    STAGE_REMUXING: "Remuxing MP4",
    STAGE_TRANSCODING: "Transcoding video",
    STAGE_NORMALIZING: "Normalizing volume",
}

# QUALITY_FORMATS / PRESET_MAX_HEIGHT / STANDARD_HEIGHTS / _format_chain: see ytdlp_formats


# yt-dlp per-format fragments (e.g. ".f401.mp4") — not the final merged file.


# Fall through: leave other errors to raised exceptions / default silence.


class _SubtitleYtdlpLogger:
    """Capture timedtext errors without printing them to stderr."""

    def __init__(self) -> None:
        self.messages: list[str] = []

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        if msg:
            self.messages.append(str(msg))

    def error(self, msg: str) -> None:
        if msg:
            self.messages.append(str(msg))


# A `downloading` job nobody owns for this long goes back to `queued`.
STUCK_JOB_GRACE_SECONDS = 180.0
REAPER_INTERVAL_SECONDS = 60.0


class DownloadQueue:
    """FIFO download scheduler with global pause and bounded concurrency."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._global_paused = False
        self._running: set[int] = set()
        self._ffmpeg_running: set[int] = set()
        self._cancel_events: dict[int, threading.Event] = {}
        # Quality-change restart: skip dispatch until the API releases the job.
        self._held: set[int] = set()
        self._restart_ids: set[int] = set()
        self._orphan_seen: dict[int, float] = {}
        # Shutdown: stop dispatching, cancel in-flight work and requeue it (see
        # ``_mark_job_cancelled``) so the next boot resumes it.
        self._shutting_down = False
        self._threads: set[threading.Thread] = set()

    # -- ManagedWorker protocol (registered by lifespan) -----------------------

    name = "download-queue"
    #: Seconds the registry waits for in-flight downloads to cancel and requeue.
    stop_timeout = 10.0

    def start(self) -> None:
        with self._lock:
            self._shutting_down = False

    @property
    def is_alive(self) -> bool:
        """True while the queue accepts and dispatches jobs."""
        with self._lock:
            return not self._shutting_down

    @property
    def healthy(self) -> bool:
        return self.is_alive

    def is_shutting_down(self) -> bool:
        with self._lock:
            return self._shutting_down

    def signal_stop(self) -> None:
        """Stop dispatching and cancel every in-flight job (they requeue)."""
        with self._lock:
            self._shutting_down = True
            events = list(self._cancel_events.values())
        for event in events:
            event.set()

    def stop(self, timeout: float | None = None) -> bool:
        """Signal, then wait for the download threads. True when all have ended."""
        self.signal_stop()
        deadline = time.monotonic() + (10.0 if timeout is None else timeout)
        with self._lock:
            threads = list(self._threads)
        for thread in threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        with self._lock:
            return not any(t.is_alive() for t in self._threads)

    def is_paused(self) -> bool:
        with self._lock:
            return self._global_paused

    def enqueue(self, job_id: int) -> None:
        self._dispatch()

    def recover(self) -> None:
        """Resume dispatching jobs left mid-download from a previous server run."""
        from . import app_settings as settings_svc

        paused = bool(settings_svc.load().get("download_queue_paused", False))
        with self._lock:
            self._global_paused = paused

        with Session(engine) as session:
            for job in session.exec(
                select(DownloadJob).where(DownloadJob.status == JobStatus.downloading)
            ).all():
                if job.id not in self._running:
                    job.status = JobStatus.queued
                    job.progress = 0.0
                    if paused:
                        job.paused = True
                    session.add(job)

            if paused:
                for job in session.exec(
                    select(DownloadJob).where(
                        DownloadJob.status == JobStatus.queued,
                        DownloadJob.paused == False,  # noqa: E712 - SQL column comparison, not a Python truth test
                    )
                ).all():
                    job.paused = True
                    session.add(job)
            else:
                for job in session.exec(
                    select(DownloadJob).where(
                        DownloadJob.status == JobStatus.queued,
                        DownloadJob.paused == True,  # noqa: E712 - SQL column comparison, not a Python truth test
                    )
                ).all():
                    job.paused = False
                    session.add(job)
            session.commit()

        if not paused:
            self._dispatch()

    def pause_all(self) -> None:
        from . import app_settings as settings_svc

        with self._lock:
            self._global_paused = True
            download_ids = set(self._running)
            ffmpeg_ids = set(self._ffmpeg_running)
            events = [
                self._cancel_events[jid]
                for jid in download_ids
                if jid in self._cancel_events
            ]
        settings_svc.save({"download_queue_paused": True})
        for event in events:
            event.set()
        with Session(engine) as session:
            for job in session.exec(
                select(DownloadJob).where(
                    DownloadJob.status.in_([JobStatus.queued, JobStatus.downloading])
                )
            ).all():
                if job.id in ffmpeg_ids:
                    continue
                job.paused = True
                if job.status == JobStatus.downloading:
                    job.status = JobStatus.queued
                    job.progress = 0.0
                session.add(job)
            session.commit()

    def resume_all(self) -> None:
        from . import app_settings as settings_svc

        with self._lock:
            self._global_paused = False
        settings_svc.save({"download_queue_paused": False})
        with Session(engine) as session:
            for job in session.exec(
                select(DownloadJob).where(
                    DownloadJob.status == JobStatus.queued,
                    DownloadJob.paused == True,  # noqa: E712 - SQL column comparison, not a Python truth test
                )
            ).all():
                job.paused = False
                session.add(job)
            session.commit()
        self._dispatch()

    def cancel_job(self, job_id: int) -> bool:
        with self._lock:
            event = self._cancel_events.get(job_id)
        if event is not None:
            event.set()
        with Session(engine) as session:
            job = session.get(DownloadJob, job_id)
            if job is None:
                return False
            if job.status in (JobStatus.completed, JobStatus.cancelled):
                return False
            if job.status == JobStatus.queued:
                job.status = JobStatus.cancelled
                job.error = "Cancelled"
                job.error_kind = ERROR_KIND_CANCELLED
                session.add(job)
                session.commit()
                progress_store[job_id] = {
                    "status": "cancelled",
                    "error": "Cancelled",
                    "error_kind": ERROR_KIND_CANCELLED,
                }
                return True
            if event is None and job.status == JobStatus.downloading:
                # Orphaned job — no worker thread to signal.
                job.status = JobStatus.cancelled
                job.error = "Cancelled"
                job.error_kind = ERROR_KIND_CANCELLED
                job.progress = 0.0
                session.add(job)
                session.commit()
                progress_store[job_id] = {
                    "status": "cancelled",
                    "error": "Cancelled",
                    "error_kind": ERROR_KIND_CANCELLED,
                }
                return True
            # downloading — hook will mark cancelled when thread exits
            return True

    def is_running(self, job_id: int) -> bool:
        with self._lock:
            return job_id in self._running or job_id in self._ffmpeg_running

    def claim_ffmpeg(self, job_id: int) -> None:
        with self._lock:
            self._ffmpeg_running.add(job_id)

    def release_ffmpeg(self, job_id: int) -> None:
        with self._lock:
            self._ffmpeg_running.discard(job_id)
            if job_id not in self._running:
                self._cancel_events.pop(job_id, None)

    def cancel_event(self, job_id: int) -> threading.Event | None:
        with self._lock:
            return self._cancel_events.get(job_id)

    def request_quality_restart(self, job_id: int) -> None:
        """Abort the current attempt and keep the job from dispatching until released."""
        with self._lock:
            self._held.add(job_id)
            self._restart_ids.add(job_id)
            event = self._cancel_events.get(job_id)
        if event is not None:
            event.set()

    def take_quality_restart(self, job_id: int) -> bool:
        with self._lock:
            if job_id not in self._restart_ids:
                return False
            self._restart_ids.discard(job_id)
            return True

    def is_quality_restart(self, job_id: int) -> bool:
        with self._lock:
            return job_id in self._restart_ids

    def release_job(self, job_id: int) -> None:
        with self._lock:
            self._held.discard(job_id)
            self._restart_ids.discard(job_id)

    def active_count(self) -> int:
        with Session(engine) as session:
            return int(
                session.exec(
                    select(func.count())
                    .select_from(DownloadJob)
                    .where(
                        DownloadJob.status.in_(
                            [JobStatus.queued, JobStatus.downloading]
                        )
                    )
                ).one()
            )

    def queued_count(self) -> int:
        with Session(engine) as session:
            return int(
                session.exec(
                    select(func.count())
                    .select_from(DownloadJob)
                    .where(DownloadJob.status == JobStatus.queued)
                ).one()
            )

    def _dispatch(self) -> None:
        from ..e2e_mode import enabled as e2e_browser

        # Browser tests seed a queued job. Never start yt-dlp from that process.
        if e2e_browser():
            return
        while True:
            with self._lock:
                if (
                    self._shutting_down
                    or self._global_paused
                    or len(self._running) >= MAX_DOWNLOAD_CONCURRENCY
                ):
                    return
            # The DB query runs outside the lock; the claim below re-checks.
            job_id = self._next_job_id()
            if job_id is None:
                return
            with self._lock:
                if (
                    self._shutting_down
                    or self._global_paused
                    or len(self._running) >= MAX_DOWNLOAD_CONCURRENCY
                ):
                    return
                if job_id in self._running or job_id in self._held:
                    continue
                self._running.add(job_id)
                cancel_event = threading.Event()
                self._cancel_events[job_id] = cancel_event
                thread = threading.Thread(
                    target=self._worker,
                    args=(job_id, cancel_event),
                    daemon=True,
                    name=f"download-{job_id}",
                )
                self._threads.add(thread)
            thread.start()

    def _next_job_id(self) -> int | None:
        """Oldest queued, unpaused job that is neither running nor held."""
        with self._lock:
            excluded = list(self._running | self._held)
        with Session(engine) as session:
            query = select(DownloadJob.id).where(
                DownloadJob.status == JobStatus.queued,
                DownloadJob.paused == False,  # noqa: E712 - SQL column comparison, not a Python truth test
            )
            if excluded:
                query = query.where(DownloadJob.id.notin_(excluded))  # type: ignore[union-attr]
            return session.exec(
                query.order_by(
                    DownloadJob.created_at.asc(), DownloadJob.id.asc()
                ).limit(1)
            ).first()

    # -- stuck-job reaper ------------------------------------------------

    def reap_stuck_jobs(
        self, *, now: float | None = None, grace: float = STUCK_JOB_GRACE_SECONDS
    ) -> list[int]:
        """Requeue ``downloading`` jobs that no worker or ffmpeg stage owns.

        A job is only reaped after it has been seen orphaned for ``grace``
        seconds, which covers the hand-off windows between stages.
        """
        clock = time.monotonic() if now is None else now
        with self._lock:
            owned = self._running | self._ffmpeg_running
        with Session(engine) as session:
            rows = session.exec(
                select(DownloadJob).where(DownloadJob.status == JobStatus.downloading)
            ).all()
            orphans = {j.id for j in rows if j.id is not None and j.id not in owned}
            self._orphan_seen = {
                jid: t for jid, t in self._orphan_seen.items() if jid in orphans
            }
            reaped: list[int] = []
            for job in rows:
                if job.id not in orphans:
                    continue
                first = self._orphan_seen.setdefault(job.id, clock)
                if clock - first < grace:
                    continue
                job.status = JobStatus.queued
                job.progress = 0.0
                job.paused = self.is_paused()
                session.add(job)
                reaped.append(job.id)
                self._orphan_seen.pop(job.id, None)
                logger.warning(
                    "requeued stuck download job %s (no worker for %.0fs)",
                    job.id,
                    clock - first,
                )
            if reaped:
                session.commit()
        for job_id in reaped:
            progress_store.merge(job_id, {"status": "queued", "progress": 0.0})
        if reaped:
            self._dispatch()
        return reaped

    def create_reaper(
        self, interval: float = REAPER_INTERVAL_SECONDS
    ) -> BackgroundWorker:
        """The worker that requeues orphaned jobs and prunes finished progress."""

        def loop(worker: BackgroundWorker) -> None:
            failures = FailureLog(logger, "stuck-job reaper pass failed")
            while not worker.sleep(interval):
                try:
                    self.reap_stuck_jobs()
                    progress_store.prune()
                    failures.ok()
                except Exception:  # noqa: BLE001 - FailureLog logs the traceback
                    failures.failed()

        return BackgroundWorker("download-reaper", loop)

    def _worker(self, job_id: int, cancel_event: threading.Event) -> None:
        """Run one job. Total: whatever happens, the job leaves ``downloading``."""
        with job_context(f"download-{job_id}"):
            self._run_job(job_id, cancel_event)

    def _run_job(self, job_id: int, cancel_event: threading.Event) -> None:
        try:
            with Session(engine) as session:
                job = session.get(DownloadJob, job_id)
                if job is None or job.status != JobStatus.queued:
                    return
                destination = job.destination or DownloadDestination.library.value
                job_url = job.url
            # The API checks URLs on the way in, but playlist sync, channel
            # autodownload and rows from before this check reach the queue too.
            try:
                validate_public_url(job_url)
            except UnsafeUrlError as exc:
                logger.warning("Refusing download job %s: %s", job_id, exc)
                dbwrite.update_job(job_id, status=JobStatus.error, error=str(exc))
                progress_store[job_id] = {"status": "error", "error": str(exc)}
                return
            try:
                _run_download(job_id, cancel_event=cancel_event)
            except DownloadCancelled:
                _mark_job_cancelled(job_id, destination)
        except Exception as exc:
            logger.exception("download worker for job %s crashed", job_id)
            _force_job_error(job_id, exc)
        finally:
            with self._lock:
                self._running.discard(job_id)
                self._threads.discard(threading.current_thread())
                if job_id not in self._ffmpeg_running:
                    self._cancel_events.pop(job_id, None)
            self._dispatch()


download_queue = DownloadQueue()


def ffmpeg_slot_limit() -> int:
    from ..config import MAX_FFMPEG_CONCURRENCY

    if MAX_FFMPEG_CONCURRENCY is not None:
        return MAX_FFMPEG_CONCURRENCY
    try:
        from .encode_probe import probe_encode_capabilities

        caps = probe_encode_capabilities()
        return 2 if caps.ffmpeg_has_hw_encoder else 1
    except Exception:
        logger.debug("encoder probe failed; using one ffmpeg slot", exc_info=True)
        return 1


@dataclass
class _PostprocessTask:
    job_id: int
    final_path: Path
    info: dict[str, Any]
    url: str
    quality_preset: str
    title_override: str | None
    channel_override: str | None
    normalize_volume: bool
    replace_video_id: int | None
    notes_pending: str | None
    cancel_event: threading.Event
    destination: str
    video_codec: str
    # Library downloads: per-job staging dir the media is promoted out of, and
    # the scanner marks to release once the postprocess stage is over.
    staging_dir: Path | None = None
    active_marks: set[str] = field(default_factory=set)


class FfmpegQueue:
    """Bounded remux/transcode/loudnorm so a slow encode does not hold a download slot."""

    name = "ffmpeg-queue"
    stop_timeout = 10.0

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: list[_PostprocessTask] = []
        self._running: set[int] = set()
        self._threads: set[threading.Thread] = set()

    # -- ManagedWorker protocol (registered by lifespan) -----------------------
    # Shutdown cancels in-flight encodes through the shared per-job cancel events
    # (set by ``DownloadQueue.signal_stop``); this queue drops what has not started.

    def start(self) -> None:
        return

    @property
    def is_alive(self) -> bool:
        return not download_queue.is_shutting_down()

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

    def _abandon(self, task: _PostprocessTask) -> None:
        """Requeue a postprocess task that never started (shutdown)."""
        try:
            # Explicit: the download queue may not have been told to stop yet
            # (workers are signalled newest first), and a cancel would delete the
            # finished download that is waiting for its remux.
            _mark_job_cancelled(
                task.job_id, task.destination, task.final_path, requeue=True
            )
        except Exception:
            logger.exception("could not requeue job %s at shutdown", task.job_id)
        for lib in task.active_marks:
            scanner.unmark_active(lib)
        try:
            discard_staging_unless_requeued(task.job_id)
        except Exception:
            logger.exception("could not clean staging for job %s", task.job_id)
        download_queue.release_ffmpeg(task.job_id)

    def enqueue(self, task: _PostprocessTask) -> None:
        download_queue.claim_ffmpeg(task.job_id)
        with self._lock:
            self._pending.append(task)
        self._dispatch()

    def _dispatch(self) -> None:
        if download_queue.is_shutting_down():
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

    def _worker(self, task: _PostprocessTask) -> None:
        with job_context(f"download-{task.job_id}"):
            self._run_task(task)

    def _run_task(self, task: _PostprocessTask) -> None:
        try:
            _complete_download(
                task.job_id,
                task.final_path,
                task.info,
                task.url,
                task.quality_preset,
                task.title_override,
                task.channel_override,
                task.normalize_volume,
                task.replace_video_id,
                task.notes_pending,
                cancel_event=task.cancel_event,
                destination=task.destination,
                video_codec=task.video_codec,
                staging_dir=task.staging_dir,
            )
        except DownloadCancelled:
            _mark_job_cancelled(
                task.job_id,
                task.destination,
                task.final_path,
            )
        except Exception as exc:
            logger.warning("postprocess of job %s failed", task.job_id, exc_info=True)
            _fail_postprocess_job(task.job_id, task.destination, exc)
        finally:
            for lib in task.active_marks:
                scanner.unmark_active(lib)
            discard_staging_unless_requeued(task.job_id)
            with self._lock:
                self._running.discard(task.job_id)
                self._threads.discard(threading.current_thread())
            download_queue.release_ffmpeg(task.job_id)
            self._dispatch()


ffmpeg_queue = FfmpegQueue()


def _force_job_error(job_id: int, exc: BaseException) -> None:
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


def _mark_job_cancelled(
    job_id: int,
    destination: str,
    final_path: Path | None = None,
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
        restarting = download_queue.take_quality_restart(job_id)
        pausing = download_queue.is_paused()
        # A job interrupted by shutdown goes back to the queue, like a pause, and
        # resumes from its staged .part files on the next boot.
        if restarting or pausing or requeue or download_queue.is_shutting_down():
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


def _fail_postprocess_job(job_id: int, destination: str, exc: BaseException) -> None:
    event = download_queue.cancel_event(job_id)
    if isinstance(exc, (FfmpegCancelled, DownloadCancelled)) or (
        event is not None and event.is_set()
    ):
        _mark_job_cancelled(job_id, destination)
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


def _handoff_postprocess(
    job_id: int,
    final_path: Path,
    info: dict[str, Any],
    url: str,
    quality_preset: str,
    title_override: str | None,
    channel_override: str | None,
    normalize_volume: bool,
    replace_video_id: int | None,
    notes_pending: str | None,
    cancel_event: threading.Event,
    destination: str,
    video_codec: str,
    staging_dir: Path | None = None,
    active_marks: set[str] | None = None,
) -> None:
    _set_processing_stage(job_id, STAGE_REMUXING, progress=0.0)
    ffmpeg_queue.enqueue(
        _PostprocessTask(
            job_id=job_id,
            final_path=final_path,
            info=info,
            url=url,
            quality_preset=quality_preset,
            title_override=title_override,
            channel_override=channel_override,
            normalize_volume=normalize_volume,
            replace_video_id=replace_video_id,
            notes_pending=notes_pending,
            cancel_event=cancel_event,
            destination=destination,
            video_codec=video_codec,
            staging_dir=staging_dir,
            active_marks=set(active_marks or ()),
        )
    )


_STREAM_SWITCH_SLOP = 512 * 1024


def _positive_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _progress_stream_total(d: dict[str, Any]) -> int | None:
    """Whole-file size for the current stream, not the current HTTP Range."""
    info = as_info(d.get("info_dict"))
    hint = _positive_int(info.get("filesize")) or _positive_int(
        info.get("filesize_approx")
    )
    hook = _positive_int(d.get("total_bytes")) or _positive_int(
        d.get("total_bytes_estimate")
    )
    if hint and hook:
        # YouTube HTTPS uses ~10MB Range chunks; hook total is often the chunk.
        return max(hint, hook)
    return hint or hook


def _progress_filename(d: dict[str, Any]) -> str:
    raw = d.get("filename") or ""
    try:
        return Path(str(raw)).name
    except (TypeError, ValueError):
        return str(raw)


class _DownloadProgress:
    """Turn yt-dlp hook events into UI snapshots with consistent bytes/percent.

    Chunked HTTP and video-then-audio resets make hook `total_bytes` a poor
    denominator; this accumulates across streams and prefers format filesize.
    """

    def __init__(self) -> None:
        self.accumulated_bytes = 0
        self.last_stream_downloaded = 0
        self.accumulated_total = 0
        self.last_stream_total = 0
        self.max_displayed_bytes = 0

    def _note_stream_switch(self, downloaded: int) -> None:
        if downloaded < self.last_stream_downloaded - _STREAM_SWITCH_SLOP:
            self.accumulated_bytes += self.last_stream_downloaded
            self.accumulated_total += self.last_stream_total
            self.last_stream_downloaded = 0
            self.last_stream_total = 0

    def _apply_downloaded(self, downloaded: int, stream_total: int | None) -> None:
        self.last_stream_downloaded = max(self.last_stream_downloaded, downloaded)
        if stream_total:
            self.last_stream_total = max(self.last_stream_total, stream_total)
        combined = self.accumulated_bytes + self.last_stream_downloaded
        self.max_displayed_bytes = max(self.max_displayed_bytes, combined)

    def _combined_total(self) -> int | None:
        if self.last_stream_total:
            return self.accumulated_total + self.last_stream_total
        if self.accumulated_total:
            return self.accumulated_total + self.last_stream_downloaded
        return None

    def _ratio(self) -> float:
        total = self._combined_total()
        if not total:
            return 0.0
        return min(100.0, self.max_displayed_bytes / total * 100)

    def _downloading_snapshot(self, info: dict[str, Any]) -> dict[str, Any]:
        snap: dict[str, Any] = {
            "status": "downloading",
            "progress": round(self._ratio(), 1),
            "title": info.get("title"),
            "channel": info.get("uploader") or info.get("channel"),
            "downloaded_bytes": self.max_displayed_bytes,
        }
        total = self._combined_total()
        if total:
            snap["total_bytes"] = total
        return snap

    def _is_final_finished(self, d: dict[str, Any], downloaded: int) -> bool:
        name = _progress_filename(d)
        if name and is_intermediate_media(name):
            return False
        info = as_info(d.get("info_dict"))
        hint = _positive_int(info.get("filesize")) or _positive_int(
            info.get("filesize_approx")
        )
        if hint and downloaded and downloaded < int(hint * 0.95):
            return False
        return bool(name)

    def apply(self, d: dict[str, Any]) -> dict[str, Any] | None:
        status = d.get("status")
        info = as_info(d.get("info_dict"))
        if status == "downloading":
            downloaded = int(d.get("downloaded_bytes", 0) or 0)
            self._note_stream_switch(downloaded)
            self._apply_downloaded(downloaded, _progress_stream_total(d))
            return self._downloading_snapshot(info)
        if status == "finished":
            downloaded = (
                _positive_int(d.get("downloaded_bytes")) or self.last_stream_downloaded
            )
            if downloaded:
                self._note_stream_switch(downloaded)
                self._apply_downloaded(downloaded, _progress_stream_total(d))
            if not self._is_final_finished(d, downloaded or 0):
                return self._downloading_snapshot(info)
            snap: dict[str, Any] = {
                "status": "processing",
                "progress": min(100.0, max(self._ratio(), 99.0)),
                "downloaded_bytes": self.max_displayed_bytes,
            }
            total = self._combined_total()
            if total:
                snap["total_bytes"] = total
            title = info.get("title")
            if title:
                snap["title"] = title
            return snap
        return None


def processing_stage_for_compat(plan: CompatPlan) -> str | None:
    """Label the Safari MP4 pass: AAC encode when needed, otherwise remux."""
    if not plan.needed:
        return None
    if plan.transcode_audio:
        return STAGE_ENCODING_AUDIO
    return STAGE_REMUXING


def processing_stage_for_postprocessor(name: str | None) -> str | None:
    key = (name or "").lower().replace("ffmpeg", "")
    if "merger" in key:
        return STAGE_MERGING
    if "remux" in key:
        return STAGE_REMUXING
    return None


def _publish_job_progress(job_id: int, fields: dict[str, Any]) -> dict[str, Any]:
    snap = progress_store.merge(job_id, fields)
    if snap.get("status") != "processing" and "stage" in snap:
        snap = {k: v for k, v in snap.items() if k != "stage"}
        progress_store[job_id] = snap
    return snap


def _set_processing_stage(
    job_id: int, stage: str, progress: float | None = None
) -> dict[str, Any]:
    if progress is None:
        progress_n = 0.0
    else:
        try:
            progress_n = min(100.0, max(0.0, float(progress)))
        except (TypeError, ValueError):
            progress_n = 0.0
    return _publish_job_progress(
        job_id,
        {
            "status": "processing",
            "stage": stage,
            "progress": progress_n,
        },
    )


def _processing_activity_detail(stage: str | None) -> str:
    if not stage:
        return "Processing"
    return _STAGE_ACTIVITY_DETAIL.get(str(stage), "Processing")


def _make_progress_hook(
    job_id: int,
    cancel_event: threading.Event,
    activity_handle: activity.ActivityHandle | None = None,
):
    tracker = _DownloadProgress()
    last_activity_at = 0.0
    last_activity_pct = -1.0

    def hook(d: dict[str, Any]) -> None:
        nonlocal last_activity_at, last_activity_pct
        if cancel_event.is_set():
            raise DownloadCancelled()
        if not isinstance(d, dict):
            return
        try:
            snap = tracker.apply(d)
            if not snap:
                return
            merged = _publish_job_progress(job_id, snap)
            if activity_handle is None:
                return
            if merged.get("status") == "processing":
                activity_handle.update(
                    done=99,
                    total=100,
                    detail=_processing_activity_detail(merged.get("stage")),
                    engine="ffmpeg",
                )
                return
            now = time.time()
            pct_i = int(merged.get("progress") or 0)
            if now - last_activity_at >= 1.0 or pct_i >= last_activity_pct + 5:
                last_activity_at = now
                last_activity_pct = pct_i
                activity_handle.update(
                    done=pct_i,
                    total=100,
                    detail=merged.get("title") or None,
                )
        except DownloadCancelled:
            raise
        except Exception:
            logger.debug("download progress update failed", exc_info=True)
            return

    return hook


def _make_postprocessor_hook(
    job_id: int,
    cancel_event: threading.Event,
    activity_handle: activity.ActivityHandle | None = None,
):
    def hook(d: dict[str, Any]) -> None:
        if cancel_event.is_set():
            raise DownloadCancelled()
        if not isinstance(d, dict):
            return
        if d.get("status") not in ("started", "processing"):
            return
        stage = processing_stage_for_postprocessor(d.get("postprocessor"))
        if not stage:
            return
        try:
            _set_processing_stage(job_id, stage)
            if activity_handle is not None:
                activity_handle.update(
                    done=99,
                    total=100,
                    detail=_processing_activity_detail(stage),
                    engine="ffmpeg",
                )
        except DownloadCancelled:
            raise
        except Exception:
            logger.debug("download progress update failed", exc_info=True)
            return

    return hook


# Language token between the media stem and ``.vtt`` (``en``, ``en-US``, ``zh-Hans``).
_SUBTITLE_LANG_RE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*")


def _normalize_lang(lang: str) -> str:
    return lang.split("-")[0].lower()


def _collect_subtitles(final_path: Path) -> list[dict[str, Any]]:
    stem = final_path.stem
    parent = final_path.parent
    by_lang: dict[str, dict[str, Any]] = {}
    if not parent.is_dir():
        return []
    for entry in parent.iterdir():
        if not entry.is_file() or entry.suffix.lower() != ".vtt":
            continue
        if not belongs_to_stem(entry.name, stem):
            continue
        raw_lang = entry.name[len(stem) + 1 : -len(".vtt")]
        rel = safe_rel(entry)
        if not _SUBTITLE_LANG_RE.fullmatch(raw_lang) or not rel:
            continue
        lang = _normalize_lang(raw_lang)
        if lang not in by_lang or raw_lang.lower() == lang:
            by_lang[lang] = {"lang": lang, "path": rel, "auto": False}
    return list(by_lang.values())


def _cleanup_subtitle_partials(parent: Path, stem: str) -> None:
    if not parent.is_dir():
        return
    for entry in parent.iterdir():
        if (
            entry.is_file()
            and belongs_to_stem(entry.name, stem)
            and entry.suffix.lower() == ".part"
        ):
            safe_unlink(entry)


def _subtitle_ydl_opts(
    outtmpl: str,
    *,
    with_cookies: bool = False,
    ytdlp_logger: _SubtitleYtdlpLogger | None = None,
) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en"],
        "subtitlesformat": "vtt/best",
        "outtmpl": outtmpl,
        "postprocessors": [{"key": "FFmpegSubtitlesConvertor", "format": "vtt"}],
        "extractor_args": youtube_extractor_args(),
        "logger": ytdlp_logger or _SubtitleYtdlpLogger(),
    }
    return apply_cookie_opts(opts) if with_cookies else opts


def download_subtitles(media: Path, source_url: str):
    """Best-effort subtitle fetch; never raises. Uses a temp dir to avoid Windows locks.

    Returns a ``SubtitleFetchOutcome``: tracks when VTT landed, or ``retryable``
    when timedtext should be tried again later.
    """
    import tempfile

    import yt_dlp

    from .subtitle_retry import SubtitleFetchOutcome, outcome_from_fetch

    if not media.exists():
        return SubtitleFetchOutcome(tracks=[], retryable=True)

    parent = media.parent
    stem = media.stem
    _cleanup_subtitle_partials(parent, stem)
    ytdlp_logger = _SubtitleYtdlpLogger()
    last_exc: BaseException | None = None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            outtmpl = str(Path(tmpdir) / f"{stem}.%(ext)s")
            with_cookies = url_cookie_required(source_url)
            try:
                with yt_dlp.YoutubeDL(
                    _subtitle_ydl_opts(
                        outtmpl,
                        with_cookies=with_cookies,
                        ytdlp_logger=ytdlp_logger,
                    )
                ) as ydl:
                    ydl.download([source_url])
            except Exception as exc:
                if with_cookies or not should_retry_with_cookies({}, exc):
                    raise
                with yt_dlp.YoutubeDL(
                    _subtitle_ydl_opts(
                        outtmpl,
                        with_cookies=True,
                        ytdlp_logger=ytdlp_logger,
                    )
                ) as ydl:
                    ydl.download([source_url])

            for entry in Path(tmpdir).iterdir():
                if not entry.is_file() or entry.suffix.lower() != ".vtt":
                    continue
                dest = parent / entry.name
                try:
                    shutil.copy2(entry, dest)
                except OSError:
                    safe_unlink(dest)
                    with contextlib.suppress(OSError):
                        shutil.copy2(entry, dest)
    except Exception as exc:
        logger.debug("subtitle fetch attempt failed", exc_info=True)
        last_exc = exc

    return outcome_from_fetch(
        _collect_subtitles(media),
        messages=ytdlp_logger.messages,
        exc=last_exc,
    )


def _remove_review_duplicates(
    session: Session, video_id: str | None, keep_id: int | None
) -> None:
    if not video_id:
        return
    token = f"[{video_id}]"
    rows = session.exec(
        select(Video).where(Video.needs_review == True)  # noqa: E712 - SQL column comparison, not a Python truth test
    ).all()
    doomed: list[Path] = []
    for row in rows:
        if row.id == keep_id or token not in row.file_path:
            continue
        doomed += delete_video_cascade(session, row, False, commit=False)
    session.commit()
    remove_files(doomed)


def _check_quality(
    preset: str, height: int | None, video_codec: str = "av1"
) -> str | None:
    """Return a warning string if actual height is below the requested cap tier."""
    # H.264-native mode caps 1440p/4K presets at 1080p by design — not a warning.
    max_h = effective_max_height(preset, video_codec)
    if max_h is None or height is None:
        return None
    # Allow a few pixels of encoder/probe variance (e.g. 1078 vs 1080).
    if height + 8 < max_h:
        return (
            f"Requested {preset} but file is {height}p — "
            "source may not offer that quality."
        )
    return None


def _apply_loudnorm(
    path: Path,
    *,
    cancel_event: threading.Event | None = None,
    on_progress: Any | None = None,
    duration: float | None = None,
) -> str | None:
    """Normalize loudness via ffmpeg; returns warning if skipped."""
    if not ffmpeg_available():
        return "Volume normalization skipped: ffmpeg not found"
    # Unique sidecar so concurrent workers / scanner never share one .norm.mp4.
    tmp = path.with_name(f"{path.stem}.norm.{threading.get_ident()}.mp4")
    tmp_rel = safe_rel(tmp)
    if tmp_rel:
        scanner.mark_active(tmp_rel)
    cmd = [
        ffmpeg_bin(),
        "-y",
        "-i",
        str(path),
        "-af",
        "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        str(tmp),
    ]
    try:
        with activity.track(
            "loudnorm",
            "Normalizing volume",
            reason="Volume normalization enabled for this download",
            engine="ffmpeg",
            detail=path.name,
        ):
            run_ffmpeg(
                cmd,
                duration=duration,
                on_progress=on_progress,
                cancel_event=cancel_event,
                timeout=3600,
            )
            replace_with_retries(tmp, path)
        return None
    except FfmpegCancelled:
        safe_unlink(tmp)
        raise
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        safe_unlink(tmp)
        return "Volume normalization failed"
    finally:
        if tmp_rel:
            scanner.unmark_active(tmp_rel)
        if tmp.exists():
            safe_unlink(tmp)


def _finalize_in_background(
    video_id: int,
    final_path: Path,
    source_url: str,
    thumbnail_url: str | None,
    list_thumbnail_url: str | None = None,
) -> None:
    """Fetch subtitles and thumbnail without blocking watchability."""

    def run() -> None:
        title: str | None = None
        with Session(engine) as session:
            video = session.get(Video, video_id)
            if video is not None:
                title = video.title
        with activity.track(
            "finalize",
            "Fetching subtitles and thumbnail",
            reason="Download finished",
            engine="yt-dlp",
            detail=title,
            video_id=video_id,
        ):
            outcome = None
            thumb: str | None = None
            try:
                from .subtitle_retry import apply_subtitle_outcome, outcome_from_fetch

                try:
                    outcome = download_subtitles(final_path, source_url)
                except Exception as exc:
                    logger.debug(
                        "subtitle fetch failed for video %s", video_id, exc_info=True
                    )
                    outcome = outcome_from_fetch([], exc=exc)
                apply_subtitle_outcome(video_id, outcome)
            except Exception:
                logger.warning(
                    "could not fetch subtitles for video %s", video_id, exc_info=True
                )
            try:
                thumb = _save_thumbnail(
                    thumbnail_url, video_id, list_url=list_thumbnail_url
                )
            except Exception:
                logger.warning(
                    "could not save the thumbnail for video %s", video_id, exc_info=True
                )
                thumb = None
            if thumb:
                with Session(engine) as session:
                    video = session.get(Video, video_id)
                    if video is None:
                        return
                    video.thumbnail_path = thumb
                    session.add(video)
                    session.commit()
            # Re-embed even if captions are still pending (hash updates later).
            try:
                from .ai import enqueue_for_video

                enqueue_for_video(video_id, include_tags=False, force=False)
            except Exception:
                logger.warning(
                    "could not queue AI indexing for video %s",
                    video_id,
                    exc_info=True,
                )
            try:
                from .sprites import enqueue_sprite_generation

                enqueue_sprite_generation(
                    video_id,
                    reason="Download finished",
                )
            except Exception:
                logger.warning(
                    "could not queue sprite generation for video %s",
                    video_id,
                    exc_info=True,
                )

    threading.Thread(target=run, daemon=True, name=f"finalize-{video_id}").start()


def _complete_download(
    job_id: int,
    final_path: Path,
    info: dict[str, Any],
    url: str,
    quality_preset: str,
    title_override: str | None,
    channel_override: str | None,
    normalize_volume: bool,
    replace_video_id: int | None,
    notes_pending: str | None,
    cancel_event: threading.Event | None = None,
    destination: str = DownloadDestination.library.value,
    video_codec: str = "av1",
    staging_dir: Path | None = None,
) -> int | None:
    if cancel_event is not None and cancel_event.is_set():
        raise DownloadCancelled()

    video_codec = normalize_video_codec(video_codec)
    info = as_info(info)
    source_url = info.get("webpage_url") or url
    duration = probe_duration(final_path) or info.get("duration")
    try:
        duration_f = float(duration) if duration else None
    except (TypeError, ValueError):
        duration_f = None

    def _on_ffmpeg_progress(pct: float) -> None:
        prev = progress_store.get(job_id, {})
        stage = str(prev.get("stage") or STAGE_TRANSCODING)
        _set_processing_stage(job_id, stage, progress=pct)

    try:
        if final_path.exists():
            probe = probe_media(final_path)
            if probe is not None:
                stage = processing_stage_for_compat(compat_plan(probe))
                if stage:
                    _set_processing_stage(job_id, stage, progress=0.0)
            final_path = ensure_safari_mp4(
                final_path,
                cancel_event=cancel_event,
                on_progress=_on_ffmpeg_progress,
                duration=duration_f,
            )

        if (
            video_codec != "av1"
            and final_path.exists()
            and not is_audio_preset(quality_preset)
        ):
            probe = probe_media(final_path)
            dims = probe_dimensions(final_path)
            height_now = dims[1] if dims else None
            if height_now is None:
                raw_h = info.get("height")
                height_now = int(raw_h) if raw_h else None
            target = encode_target(
                video_codec,
                probe.video_codec if probe else None,
                height_now,
                preset=quality_preset,
            )
            if target:
                _set_processing_stage(job_id, STAGE_TRANSCODING, progress=0.0)
                final_path = transcode_video(
                    final_path,
                    target,
                    cancel_event=cancel_event,
                    on_progress=_on_ffmpeg_progress,
                    duration=duration_f,
                )

        volume_warning: str | None = None
        if normalize_volume and final_path.exists():
            _set_processing_stage(job_id, STAGE_NORMALIZING, progress=0.0)
            volume_warning = _apply_loudnorm(
                final_path,
                cancel_event=cancel_event,
                on_progress=_on_ffmpeg_progress,
                duration=duration_f,
            )
    except FfmpegCancelled as exc:
        raise DownloadCancelled() from exc

    if cancel_event is not None and cancel_event.is_set():
        raise DownloadCancelled()

    rel_path = to_rel_path(final_path)
    # Everything slow (ffprobe, stat) happens before any database write, so the
    # write transaction below is only a handful of statements.
    file_size = final_path.stat().st_size if final_path.exists() else None
    duration = probe_duration(final_path) or info.get("duration")
    width: int | None = None
    height: int | None = None
    dims = probe_dimensions(final_path)
    if dims:
        width, height = dims
    else:
        raw_w = info.get("width")
        raw_h = info.get("height")
        width = int(raw_w) if raw_w else None
        height = int(raw_h) if raw_h else None
    is_device = destination == DownloadDestination.device.value
    stream_info = None if is_device else probe_stream_info(final_path)

    quality_warning = _check_quality(
        quality_preset, int(height) if height else None, video_codec
    )

    journal: MoveJournal | None = None
    if staging_dir is not None and not is_device:
        # Validate the processed file, then move it into the library. A failed
        # move or commit puts everything back (see the except below).
        if not artifacts.validate_playable(final_path):
            raise RuntimeError("Processed file is not playable")
        journal = MoveJournal(DOWNLOADS_DIR)
        try:
            final_path = promote_from_staging(journal, final_path, staging_dir)
        except BaseException:
            rollback_or_log(journal)
            raise
        rel_path = to_rel_path(final_path)
        scanner.mark_active(rel_path)

    # Ephemeral "to this device" — no library row, sprites, or AI.
    if is_device:
        with Session(engine) as session:
            job = session.get(DownloadJob, job_id)
            effective_title = (
                (job.title_override if job else None)
                or title_override
                or info.get("title")
                or final_path.stem
            )
            effective_channel = (
                (job.channel_override if job else None)
                or channel_override
                or (job.channel if job else None)
                or info.get("uploader")
                or info.get("channel")
            )
        snapshot: dict[str, Any] = {
            "status": "completed",
            "progress": 100.0,
            "destination": DownloadDestination.device.value,
            "title": effective_title,
            "channel": effective_channel,
            "file_size": file_size,
        }
        if quality_warning:
            snapshot["quality_warning"] = quality_warning
        if volume_warning:
            snapshot["volume_warning"] = volume_warning

        dbwrite.update_job(
            job_id,
            status=JobStatus.completed,
            progress=100.0,
            title=effective_title,
            device_file_path=rel_path,
            file_size=file_size,
            height_px=height,
            video_id=None,
            error=None,
            error_kind=None,
        )
        progress_store[job_id] = snapshot
        return None

    try:
        committed = dbwrite.retry_db_locked(
            lambda: _commit_library_video(
                job_id=job_id,
                final_path=final_path,
                rel_path=rel_path,
                info=info,
                source_url=source_url,
                video_codec=video_codec,
                quality_preset=quality_preset,
                title_override=title_override,
                channel_override=channel_override,
                replace_video_id=replace_video_id,
                notes_pending=notes_pending,
                file_size=file_size,
                duration=duration,
                width=width,
                height=height,
                stream_info=stream_info,
            ),
            what=f"library row for job {job_id}",
        )
    except BaseException:
        if journal is not None:
            rollback_or_log(journal)
        raise
    else:
        if journal is not None:
            journal.commit()
        if staging_dir is not None:
            scanner.unmark_active(rel_path)
    video_id = committed.video_id

    # The new row is durable: only now remove what it replaced (old media,
    # subtitles, stale H.264 sidecar). Done before the finalize thread starts so
    # it cannot delete freshly fetched subtitles that share a name.
    for stale in committed.stale_paths:
        if not safe_unlink(stale):
            logger.warning(
                "could not remove the replaced file %s after commit; "
                "delete it manually if it is still there",
                stale,
            )

    _remove_review_duplicates_for(info.get("id"), video_id)

    # Queue metadata embed + tag enrich (subtitles re-embed after finalize).
    try:
        from .ai import enqueue_for_video

        enqueue_for_video(video_id, include_tags=True, force=False)
    except Exception:
        logger.warning(
            "could not queue AI enrichment for video %s",
            video_id,
            exc_info=True,
        )

    # Index channel library in the background on first download from a channel.
    try:
        if committed.channel_url:
            from . import channel_catalog

            channel_catalog.enqueue_channel(
                committed.channel_url,
                channel_name=committed.channel_name,
                force=False,
            )
    except Exception:
        logger.warning(
            "could not refresh the catalog after downloading video %s",
            video_id,
            exc_info=True,
        )

    _finalize_in_background(
        video_id,
        final_path,
        source_url,
        info.get("thumbnail"),
        _list_thumbnail_url(info, info.get("id")),
    )

    if committed.want_sidecar:
        try:
            compat_rendition.enqueue(
                video_id,
                prefer_download=True,
                reason="Sidecar mode: H.264 copy for older devices",
            )
        except Exception:
            logger.exception("could not queue H.264 sidecar for video %s", video_id)

    snapshot = {
        "status": "completed",
        "progress": 100.0,
        "destination": DownloadDestination.library.value,
        "video_id": video_id,
        "title": info.get("title"),
        "file_size": file_size,
    }
    if quality_warning:
        snapshot["quality_warning"] = quality_warning
    if volume_warning:
        snapshot["volume_warning"] = volume_warning

    dbwrite.update_job(
        job_id,
        status=JobStatus.completed,
        progress=100.0,
        title=info.get("title"),
        video_id=video_id,
        file_size=file_size,
        height_px=height,
        error=None,
        error_kind=None,
    )
    _attach_download_to_playlist(job_id, video_id)
    progress_store[job_id] = snapshot
    return video_id


@dataclass
class _CommittedVideo:
    video_id: int
    channel_url: str | None
    channel_name: str | None
    want_sidecar: bool
    # Files the previous version of a replaced video owned; delete after commit.
    stale_paths: list[Path]


def _commit_library_video(
    *,
    job_id: int,
    final_path: Path,
    rel_path: str,
    info: dict[str, Any],
    source_url: str,
    video_codec: str,
    quality_preset: str,
    title_override: str | None,
    channel_override: str | None,
    replace_video_id: int | None,
    notes_pending: str | None,
    file_size: int | None,
    duration: Any,
    width: int | None,
    height: int | None,
    stream_info: Any,
) -> _CommittedVideo:
    """Write the library row for a finished download. Database work only.

    Runs in one short transaction with no file I/O. Anything that has to be
    deleted for a replaced video is returned, not deleted: the caller removes it
    once this commit succeeded, so a failed commit never costs the user the
    previous copy.
    """
    stale: list[Path] = []
    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        effective_title = (job.title_override if job else None) or title_override
        effective_channel = (
            (job.channel_override if job else None)
            or channel_override
            or (job.channel if job else None)
        )

        if replace_video_id is None:
            # Same YouTube id already in library → replace in place (avoids duplicates).
            yt_id = info.get("id")
            if isinstance(yt_id, str) and yt_id:
                existing = library.find_video_by_youtube_id(session, yt_id)
                if existing is not None:
                    replace_video_id = existing.id

        video = session.get(Video, replace_video_id) if replace_video_id else None
        if replace_video_id and video is None:
            # The row was deleted while the download ran (its job FK is now
            # SET NULL): keep the download as a new library video.
            logger.warning(
                "video %s to replace is gone; importing job %s as new",
                replace_video_id,
                job_id,
            )
            replace_video_id = None
        if replace_video_id and video is not None:
            old_path = DOWNLOADS_DIR / video.file_path
            if old_path.resolve() != final_path.resolve():
                stale.append(old_path)
            for track in library.parse_subtitles(video.subtitles):
                if track.get("path"):
                    stale.append(DOWNLOADS_DIR / track["path"])
            # New original → any previous H.264 sidecar is stale.
            old_compat = resolve_compat_path(video)
            if old_compat is not None:
                stale.append(old_compat)
        else:
            video = find_video_by_path(session, rel_path)
            if video is None:
                video = Video(file_path=rel_path)
                session.add(video)

        remote_title = info.get("title") or final_path.stem
        remote_description = info.get("description")
        is_replace = replace_video_id is not None and video.id is not None

        # Always keep last-known remote copy for drift banners / sync.
        if remote_title:
            video.source_title = remote_title
        if remote_description is not None:
            video.source_description = remote_description

        if is_replace and video.title_is_custom:
            # Keep curated display title; title_override only applies when not custom.
            pass
        elif effective_title:
            video.title = effective_title
            if effective_title != remote_title:
                video.title_is_custom = True
        else:
            video.title = remote_title

        video.channel = effective_channel or info.get("uploader") or info.get("channel")
        video.channel_url = info.get("uploader_url") or info.get("channel_url")

        if not (is_replace and video.description_is_custom):
            video.description = remote_description

        from .chapters import apply_source_chapters

        apply_source_chapters(video, info)

        tags_locked = False
        if is_replace and video.id is not None:
            from ..models import VideoAiMeta

            meta = session.get(VideoAiMeta, video.id)
            tags_locked = bool(meta is not None and meta.tags_locked)
        if not tags_locked:
            video.tags = library.dump_tags(collect_tags(info))

        video.source_url = source_url
        video.duration_sec = duration
        video.file_size = file_size
        video.width_px = width
        video.height_px = height
        video.published_at = published_at(info)
        video.view_count = info.get("view_count")
        video.channel_subscriber_count = info.get("channel_follower_count")
        video.subtitles = library.dump_subtitles([])
        video.subtitles_pending = True
        video.needs_review = False
        video.platform = info.get("extractor_key")
        video.status = VideoStatus.ready
        video.file_path = rel_path
        if notes_pending:
            video.notes = notes_pending
        apply_stream_info(video, stream_info)
        video.compat_path = None
        video.compat_size = None
        video.compat_source = None
        video.compat_error = None

        session.commit()
        session.refresh(video)
        want_sidecar = (
            video_codec == "sidecar"
            and not is_audio_preset(quality_preset)
            and needs_compat(video, compat_copy_cap())
        )
        return _CommittedVideo(
            video_id=video.id,
            channel_url=video.channel_url,
            channel_name=video.channel,
            want_sidecar=want_sidecar,
            stale_paths=stale,
        )


def _remove_review_duplicates_for(yt_id: str | None, video_id: int) -> None:
    with Session(engine) as session:
        _remove_review_duplicates(session, yt_id, keep_id=video_id)


def _run_download(
    job_id: int,
    cancel_event: threading.Event | None = None,
) -> int | None:
    import yt_dlp

    cancel = cancel_event or threading.Event()

    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is None:
            return None
        url = job.url
        quality_preset = job.quality_preset
        title_override = job.title_override
        channel_override = job.channel_override
        job_title = job.title
        job_channel = job.channel
        normalize_volume = job.normalize_volume
        replace_video_id = job.replace_video_id
        notes_pending = job.notes_pending
        destination = job.destination or DownloadDestination.library.value
        video_codec = job.video_codec or "av1"

    if destination == DownloadDestination.device.value:
        # Never overwrite a library row from an ephemeral device job.
        replace_video_id = None
        device_job_dir(job_id).mkdir(parents=True, exist_ok=True)
        staging: Path | None = None
        out_root = device_job_dir(job_id)
    else:
        # Library downloads never write into the library directly: a cancel or
        # failure must not touch the file a row already references.
        staging = staging_dir(job_id)
        staging.mkdir(parents=True, exist_ok=True)
        out_root = staging

    if cancel.is_set():
        raise DownloadCancelled()

    dbwrite.update_job(
        job_id,
        status=JobStatus.downloading,
        paused=False,
        error=None,
        error_kind=None,
    )
    progress_store[job_id] = {
        "status": "downloading",
        "progress": 0.0,
        "destination": destination,
    }
    if cancel.is_set():
        raise DownloadCancelled()

    active_paths: set[str] = set()
    info: dict[str, Any] = {}
    metadata_info: dict[str, Any] = {}
    prepared: Path | None = None
    final_path: Path | None = None
    last_exc: Exception | None = None
    ytdlp_logger = YtdlpLogger()
    marked: set[str] = set()
    handed_off = False

    def mark_library_path(rel: str) -> None:
        lib = library_rel(rel, staging)
        if lib not in marked:
            marked.add(lib)
            scanner.mark_active(lib)

    act = activity.start(
        "download",
        "Downloading video",
        reason="Queued from the Download tab",
        engine="yt-dlp",
        detail=title_override or url,
        total=100,
        done=0,
    )

    used_cookies = url_cookie_required(url)
    base_ydl_opts: dict[str, Any] = {
        "progress_hooks": [_make_progress_hook(job_id, cancel, act)],
        "postprocessor_hooks": [_make_postprocessor_hook(job_id, cancel, act)],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "logger": ytdlp_logger,
        "merge_output_format": "mp4",
        "ignoreerrors": True,
        "overwrites": True,
        "windowsfilenames": windows_filenames_ok(out_root),
        "format_sort": format_sort_for(quality_preset, video_codec),
        "file_access_retries": 10,
        "retry_sleep_functions": {"file_access": lambda n: 0.5 * (n + 1)},
        "extractor_args": youtube_extractor_args(),
    }

    try:
        for fmt in _format_chain(quality_preset, video_codec):
            attempt_paths: set[str] = set()
            ydl_opts = {**base_ydl_opts, "format": fmt}
            if used_cookies:
                ydl_opts = apply_cookie_opts(ydl_opts)
            try:
                # Share extract spacing with preview/meta so downloads don't
                # stampede YouTube alongside feed browsing.
                meta_opts: dict[str, Any] = {
                    "quiet": True,
                    "no_warnings": True,
                    "skip_download": True,
                    "logger": QuietYtdlpLogger(),
                    "extractor_args": youtube_extractor_args(),
                }
                try:
                    fetched = extract_info_gated(
                        url,
                        meta_opts,
                        cache_key=url,
                        title=title_override or job_title,
                        channel=channel_override or job_channel,
                        priority=EXTRACT_PRIORITY_DOWNLOAD,
                    )
                except Exception as exc:
                    if is_members_only_error(exc):
                        raise MembersOnlyError("Members-only video — skipped") from exc
                    raise

                if extract_used_cookies():
                    used_cookies = True
                    ydl_opts = apply_cookie_opts({**base_ydl_opts, "format": fmt})

                fetched_info = fetched if isinstance(fetched, dict) else None
                if is_members_only_entry(fetched_info) and not extract_has_media(
                    fetched_info
                ):
                    raise MembersOnlyError("Members-only video — skipped")
                if is_youtube_short_entry(
                    {**(fetched_info or {}), "url": url, "webpage_url": url}
                ):
                    cleanup_partial_files(active_paths)
                    with Session(engine) as session:
                        job = session.get(DownloadJob, job_id)
                        if job is not None:
                            session.delete(job)
                            session.commit()
                    progress_store[job_id] = {
                        "status": "skipped",
                        "reason": "shorts",
                        "url": url,
                    }
                    act.discard()
                    return None
                metadata_info = merge_info(metadata_info, fetched)
                info = metadata_info
                outtmpl, _ = download_outtmpl(
                    destination, job_id, metadata_info, channel_override, out_root
                )
                base_ydl_opts["outtmpl"] = outtmpl
                ydl_opts = {**ydl_opts, "outtmpl": outtmpl}
                audio_fmt = pick_original_audio_format(metadata_info)
                audio_id = str(audio_fmt.get("format_id") or "") if audio_fmt else ""
                fmt_spec = (
                    apply_audio_format_id([fmt], audio_id)[0] if audio_id else fmt
                )
                ydl_opts = {**ydl_opts, "format": fmt_spec}
                if used_cookies:
                    ydl_opts = apply_cookie_opts(ydl_opts)

                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    if ytdlp_logger.members_only:
                        raise MembersOnlyError("Members-only video — skipped")
                    prepared = Path(ydl.prepare_filename(metadata_info))
                    for candidate in (prepared, prepared.with_suffix(".mp4")):
                        rel = safe_rel(candidate)
                        if rel:
                            attempt_paths.add(rel)
                            active_paths.add(rel)
                            mark_library_path(rel)

                    progress_store[job_id] = {
                        **progress_store.get(job_id, {}),
                        "title": metadata_info.get("title"),
                        "channel": metadata_info.get("uploader")
                        or metadata_info.get("channel"),
                    }

                    try:
                        downloaded = ydl.extract_info(url, download=True)
                        if ytdlp_logger.members_only:
                            raise MembersOnlyError("Members-only video — skipped")
                        info = merge_info(metadata_info, downloaded)
                        metadata_info = info
                    except Exception as exc:
                        last_exc = exc
                        if should_retry_with_cookies(
                            ydl_opts,
                            exc,
                            logger_members_only=ytdlp_logger.members_only,
                        ):
                            used_cookies = True
                            remember_cookie_required(url)
                            ytdlp_logger.members_only = False
                            logger.info(
                                "Retrying download with cookies after age/members gate: %s",
                                url,
                            )
                            cookie_opts = apply_cookie_opts(
                                {**base_ydl_opts, "format": fmt}
                            )
                            with yt_dlp.YoutubeDL(cookie_opts) as ydl_auth:
                                prepared = Path(
                                    ydl_auth.prepare_filename(metadata_info)
                                )
                                for candidate in (
                                    prepared,
                                    prepared.with_suffix(".mp4"),
                                ):
                                    rel = safe_rel(candidate)
                                    if rel:
                                        attempt_paths.add(rel)
                                        active_paths.add(rel)
                                        mark_library_path(rel)
                                downloaded = ydl_auth.extract_info(url, download=True)
                                if ytdlp_logger.members_only:
                                    raise MembersOnlyError(
                                        "Members-only video — skipped"
                                    ) from exc
                                info = merge_info(metadata_info, downloaded)
                                metadata_info = info
                        elif ytdlp_logger.members_only or is_members_only_error(exc):
                            raise MembersOnlyError(
                                "Members-only video — skipped"
                            ) from exc
                        elif not is_recoverable_download_error(exc):
                            raise
                        else:
                            final_path = resolve_merged_video(prepared, active_paths)
                            final_path = reject_unplayable(final_path, attempt_paths)
                            if final_path is None:
                                raise

                    if final_path is None:
                        final_path = resolve_merged_video(prepared, active_paths)
                    if final_path is None and metadata_info:
                        candidate = Path(ydl.prepare_filename(metadata_info))
                        final_path = candidate.with_suffix(".mp4")
                        if not final_path.exists():
                            final_path = candidate if candidate.exists() else None

                    final_path = reject_unplayable(final_path, attempt_paths)

                if final_path is not None and final_path.exists():
                    break
            except MembersOnlyError:
                raise
            except Exception as exc:
                last_exc = exc
                if ytdlp_logger.members_only or is_members_only_error(exc):
                    raise MembersOnlyError("Members-only video — skipped") from exc
                recovered = resolve_merged_video(prepared, active_paths)
                recovered = reject_unplayable(recovered, attempt_paths)
                if recovered is not None:
                    final_path = recovered
                    break
                if not (cancel.is_set() and download_queue.is_shutting_down()):
                    cleanup_partial_files(attempt_paths)

        if ytdlp_logger.members_only:
            raise MembersOnlyError("Members-only video — skipped")
        if final_path is None or not final_path.exists():
            final_path = resolve_merged_video(prepared, active_paths)
        final_path = reject_unplayable(final_path, active_paths)
        if (
            final_path is None
            or not final_path.exists()
            or final_path.stat().st_size <= 0
        ):
            raise last_exc or RuntimeError("Download produced no file")

        if cancel.is_set():
            raise DownloadCancelled()

        effective_info = merge_info(as_info(metadata_info), as_info(info))
        detail = str(title_override or effective_info.get("title") or url)
        act.finish(detail=detail)
        _handoff_postprocess(
            job_id,
            final_path,
            effective_info,
            url,
            quality_preset,
            title_override,
            channel_override,
            normalize_volume,
            replace_video_id,
            notes_pending,
            cancel,
            destination,
            video_codec,
            staging_dir=staging,
            active_marks=marked,
        )
        handed_off = True
        return None

    except DownloadCancelled:
        stopping = download_queue.is_shutting_down()
        if not stopping:
            # On shutdown the staged fragments stay: the job resumes from them.
            cleanup_partial_files(active_paths)
        restarting = download_queue.is_quality_restart(job_id)
        pausing = download_queue.is_paused()
        _mark_job_cancelled(job_id, destination)
        if restarting or pausing or stopping:
            act.discard()
        else:
            act.finish(status="cancelled")
        return None

    except Exception as exc:
        if cancel.is_set():
            if not download_queue.is_shutting_down():
                cleanup_partial_files(active_paths)
            _mark_job_cancelled(job_id, destination)
            act.finish(status="cancelled")
            return None
        recovered = resolve_merged_video(prepared, active_paths)
        recovered = reject_unplayable(recovered, active_paths)
        effective_info = merge_info(as_info(metadata_info), as_info(info))
        if (
            recovered is not None
            and recovered.exists()
            and recovered.stat().st_size > 0
            and not cancel.is_set()
        ):
            try:
                detail = str(title_override or effective_info.get("title") or url)
                act.finish(detail=detail)
                _handoff_postprocess(
                    job_id,
                    recovered,
                    effective_info,
                    url,
                    quality_preset,
                    title_override,
                    channel_override,
                    normalize_volume,
                    replace_video_id,
                    notes_pending,
                    cancel,
                    destination,
                    video_codec,
                    staging_dir=staging,
                    active_marks=marked,
                )
                handed_off = True
                return None
            except Exception:
                logger.warning(
                    "could not hand recovered download %s to postprocess",
                    job_id,
                    exc_info=True,
                )

        cleanup_partial_files(active_paths)
        if destination == DownloadDestination.device.value:
            cleanup_device_job_files(job_id)
        prev = progress_store.get(job_id, {})
        subject_title = (
            title_override
            or metadata_info.get("title")
            or info.get("title")
            or job_title
        )
        subject_channel = (
            channel_override
            or metadata_info.get("uploader")
            or metadata_info.get("channel")
            or info.get("uploader")
            or info.get("channel")
            or job_channel
        )
        kind, message = classify_ytdlp_error(
            exc, url=url, title=subject_title, channel=subject_channel
        )
        if kind == ERROR_KIND_MEMBERS or is_members_only_error(exc):
            kind = ERROR_KIND_MEMBERS
            message = classify_ytdlp_error(
                MembersOnlyError("Members-only video — skipped"),
                url=url,
                title=subject_title,
                channel=subject_channel,
            )[1]
            purge_members_only_url(url)
        record_extract_failure(
            kind, message, url=url, title=subject_title, channel=subject_channel
        )
        if kind == ERROR_KIND_UNKNOWN:
            logger.exception("download job %s failed unexpectedly", job_id)
        else:
            logger.warning("download job %s failed (%s): %s", job_id, kind, message)
        dbwrite.update_job(
            job_id,
            status=JobStatus.error,
            error=message,
            error_kind=kind,
            device_file_path=None,
        )
        progress_store[job_id] = {
            "status": "error",
            "error": message,
            "error_kind": kind,
            "title": prev.get("title"),
            "channel": prev.get("channel"),
            "destination": destination,
        }
        act.finish(status="failed", error=message[:500])
        return None
    finally:
        # Ensure activity never leaks if an unexpected path skips finish.
        if not act._closed:
            act.discard()
        if not handed_off:
            # The postprocess stage owns the marks and the staging dir once it
            # has the job; otherwise release them here.
            for lib in marked:
                scanner.unmark_active(lib)
            discard_staging_unless_requeued(job_id)


def enqueue_download(job_id: int) -> None:
    download_queue.enqueue(job_id)


# Serialize create/retry so two clicks cannot insert two active rows.
job_mutate_lock = threading.Lock()

_ACTIVE_JOB_STATUSES = (JobStatus.queued, JobStatus.downloading)


def find_active_job_for_identity(session: Session, url: str) -> DownloadJob | None:
    """Queued/downloading job for the same YouTube id (or cleaned URL)."""
    yt_id = youtube_video_id(url)
    cleaned = clean_url(url, keep_playlist=False) or url
    jobs = session.exec(
        select(DownloadJob)
        .where(DownloadJob.status.in_(list(_ACTIVE_JOB_STATUSES)))
        .order_by(DownloadJob.id.asc())
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
        progress_store[job.id] = {
            "status": "queued",
            "progress": 0.0,
            "title": job.title_override or job.title,
            "channel": job.channel_override or job.channel,
            "destination": job.destination,
        }


def wait_until_job_not_running(job_id: int, timeout: float = 30.0) -> bool:
    """Block until the worker thread for job_id has exited."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not download_queue.is_running(job_id):
            return True
        time.sleep(0.1)
    return not download_queue.is_running(job_id)


def change_job_quality(
    session: Session, job_id: int, requested_preset: str
) -> DownloadJob:
    """Change quality on a queued/downloading job. Restarts in-flight work silently."""
    preset = (requested_preset or "").strip()
    if preset not in QUALITY_FORMATS:
        raise ValueError("Unknown quality preset")

    with job_mutate_lock:
        job = session.get(DownloadJob, job_id)
        if job is None:
            raise KeyError("Job not found")
        if job.status not in (JobStatus.queued, JobStatus.downloading):
            raise PermissionError("Job already finished")

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
        needs_restart = running or job.status == JobStatus.downloading

        if not needs_restart:
            job.quality_preset = resolved
            session.add(job)
            session.commit()
            session.refresh(job)
            return job

        assert job.id is not None  # noqa: S101 - type narrowing; the row was committed above
        download_queue.request_quality_restart(job.id)
        job.quality_preset = resolved
        job.progress = 0.0
        job.error = None
        job.error_kind = None
        session.add(job)
        session.commit()
        progress_store[job.id] = {
            "status": "queued",
            "progress": 0.0,
            "title": job.title_override or job.title,
            "channel": job.channel_override or job.channel,
            "destination": job.destination,
        }

    stopped = wait_until_job_not_running(job_id)
    if not stopped:
        with job_mutate_lock:
            session.expire_all()
            job = session.get(DownloadJob, job_id)
            if job is not None and job.status == JobStatus.downloading:
                job.quality_preset = previous_preset
                session.add(job)
                session.commit()
                session.refresh(job)
            download_queue.release_job(job_id)
        raise TimeoutError("Could not restart download")

    with job_mutate_lock:
        session.expire_all()
        job = session.get(DownloadJob, job_id)
        if job is None:
            download_queue.release_job(job_id)
            raise KeyError("Job not found")
        try:
            if job.status == JobStatus.completed:
                job.quality_preset = previous_preset
                session.add(job)
                session.commit()
                session.refresh(job)
                return job
            if job.status == JobStatus.cancelled or job.status == JobStatus.error:
                job.quality_preset = resolved
                prepare_job_retry(job)
                session.add(job)
                session.commit()
                session.refresh(job)
            else:
                job.quality_preset = resolved
                job.progress = 0.0
                session.add(job)
                session.commit()
                session.refresh(job)
        finally:
            download_queue.release_job(job_id)
        enqueue_download(job.id)
        return job


def start_download(
    job_id: int,
    url: str,
    quality_preset: str,
    title_override: str | None = None,
    channel_override: str | None = None,
) -> None:
    """Legacy entry point — enqueue only."""
    enqueue_download(job_id)


def _attach_slot(session: Session, playlist_id: int, job_id: int) -> int:
    """Playlist position for a job's video, so import order survives async finishing.

    A playlist import enqueues one job per missing entry, in playlist order, so
    job ids ascend with playlist order. Entries already in the library were
    placed at their playlist index during the import, leaving holes where the
    jobs go. A job takes the first free position *after* the holes reserved by
    the still-active jobs with a lower id, so a later entry that finishes first
    cannot jump ahead of an earlier one that is still downloading.
    """
    earlier_active = int(
        session.exec(
            select(func.count())
            .select_from(DownloadJob)
            .where(
                DownloadJob.playlist_id == playlist_id,
                DownloadJob.id < job_id,
                DownloadJob.status.in_([JobStatus.queued, JobStatus.downloading]),
            )
        ).one()
    )
    occupied = set(
        session.exec(
            select(PlaylistItem.position).where(PlaylistItem.playlist_id == playlist_id)
        ).all()
    )
    pos = 0
    skipped = 0
    while True:
        if pos not in occupied:
            if skipped >= earlier_active:
                return pos
            skipped += 1
        pos += 1


# Serializes position assignment: two ffmpeg threads finishing together must not
# compute the same free slot (_attach_slot is read-then-insert).
_playlist_attach_lock = threading.Lock()


def _attach_download_to_playlist(job_id: int, video_id: int | None) -> None:
    """Add a finished download to its playlist. Best effort; never raises.

    Runs after the job is already committed as completed, so a failure here
    (lock contention, a deleted playlist) is logged and must never change the
    job's status.
    """
    if video_id is None:
        return
    try:
        with _playlist_attach_lock:
            dbwrite.retry_db_locked(
                lambda: _attach_once(job_id, video_id),
                what=f"playlist attach for job {job_id}",
            )
    except Exception:
        logger.warning(
            "could not attach job %s (video %s) to its playlist",
            job_id,
            video_id,
            exc_info=True,
        )


def _attach_once(job_id: int, video_id: int) -> None:
    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is None or job.playlist_id is None:
            return
        if session.get(Playlist, job.playlist_id) is None:
            return
        if session.get(Video, video_id) is None:
            return
        if (
            session.exec(
                select(PlaylistItem).where(
                    PlaylistItem.playlist_id == job.playlist_id,
                    PlaylistItem.video_id == video_id,
                )
            ).first()
            is not None
        ):
            return
        playlist_id = job.playlist_id
        session.add(
            PlaylistItem(
                playlist_id=playlist_id,
                video_id=video_id,
                position=_attach_slot(session, playlist_id, job_id),
            )
        )
        try:
            session.commit()
        except IntegrityError:
            # UNIQUE(playlist_id, video_id): another worker or the user added it
            # first; or the playlist/video was deleted meanwhile (FK). Either
            # way there is nothing left to attach.
            session.rollback()
            logger.info(
                "playlist %s item for video %s already present or gone",
                playlist_id,
                video_id,
            )


def _upsert_playlist_item(
    session: Session, playlist_id: int, video_id: int, position: int
) -> None:
    existing = session.exec(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist_id,
            PlaylistItem.video_id == video_id,
        )
    ).first()
    if existing is None:
        session.add(
            PlaylistItem(
                playlist_id=playlist_id,
                video_id=video_id,
                position=position,
            )
        )
    else:
        existing.position = position
        session.add(existing)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        # Lost a race with an attach (UNIQUE(playlist_id, video_id)): set the
        # position on the row that won. If the playlist is gone, give up.
        row = session.exec(
            select(PlaylistItem).where(
                PlaylistItem.playlist_id == playlist_id,
                PlaylistItem.video_id == video_id,
            )
        ).first()
        if row is None:
            logger.info("playlist %s no longer exists; skipping item", playlist_id)
            return
        row.position = position
        session.add(row)
        session.commit()


def _append_unlisted_playlist_items(
    playlist_id: int, placed_video_ids: set[int], start_pos: int
) -> None:
    """Keep items that are not on the remote list, after YouTube order."""
    with Session(engine) as session:
        items = session.exec(
            select(PlaylistItem)
            .where(PlaylistItem.playlist_id == playlist_id)
            .order_by(PlaylistItem.position)
        ).all()
        pos = start_pos
        for item in items:
            if item.video_id in placed_video_ids:
                continue
            item.position = pos
            session.add(item)
            pos += 1
        session.commit()


def _find_active_job_for_url(session: Session, url: str) -> DownloadJob | None:
    return find_active_job_for_identity(session, url)


def _enqueue_playlist_entry(
    playlist_id: int, entry_url: str, quality_preset: str
) -> tuple[str, int | None]:
    """Resolve one playlist entry without waiting for any download.

    Returns ``("library", video_id)`` when the video is already in the library,
    ``("job", job_id)`` when a download job carries ``playlist_id`` (a new one, or
    an active one for the same video) so it attaches itself on completion, and
    ``("skip", None)`` for Shorts and unparseable URLs.
    """
    cleaned = clean_url(entry_url, keep_playlist=False)
    if not cleaned or is_youtube_short_url(cleaned) or is_youtube_short_url(entry_url):
        return "skip", None

    yt_id = youtube_video_id(cleaned)
    thumb = youtube_thumbnail_url(yt_id) if yt_id else None
    created_job_id: int | None = None
    with job_mutate_lock, Session(engine) as session:
        existing = library_video_for_url(session, cleaned)
        if existing is not None and existing.id is not None:
            return "library", existing.id
        active = find_active_job_for_identity(session, cleaned)
        if active is not None and active.id is not None:
            if active.playlist_id is None:
                active.playlist_id = playlist_id
                session.add(active)
                session.commit()
            elif active.playlist_id != playlist_id:
                # One job can attach to one playlist only (no schema for more).
                logger.warning(
                    "job %s already feeds playlist %s; not also attaching to %s",
                    active.id,
                    active.playlist_id,
                    playlist_id,
                )
            return "job", active.id
        job = DownloadJob(
            url=cleaned,
            quality_preset=quality_preset or "best",
            status=JobStatus.queued,
            thumbnail_url=thumb,
            video_codec=default_download_video_codec(),
            destination=DownloadDestination.library.value,
            playlist_id=playlist_id,
            paused=download_queue.is_paused(),
        )
        session.add(job)
        try:
            session.commit()
        except IntegrityError:
            # The playlist was deleted mid-import (playlist_id is an FK).
            session.rollback()
            logger.info("playlist %s deleted during import; skipping", playlist_id)
            return "skip", None
        session.refresh(job)
        created_job_id = job.id

    from .job_metadata import request_job_metadata

    request_job_metadata(created_job_id)
    if created_job_id is not None:
        enqueue_download(created_job_id)
    return "job", created_job_id


def run_playlist_entries(
    playlist_id: int,
    entries: list[str],
    quality_preset: str,
    *,
    activity_handle: Any = None,
) -> None:
    """Enqueue a playlist's entries; never blocks on a download.

    Videos already in the library are placed at their playlist index right away.
    Every other entry becomes an ordinary queue job tagged with ``playlist_id``
    (so it honours concurrency and pause, and survives a restart) and is
    attached by ``_attach_download_to_playlist`` when it completes; see
    ``_attach_slot`` for how playlist order is kept. Items on the playlist that
    are not on the remote list stay after the remote entries.
    """
    total = len(entries)
    with Session(engine) as session:
        if session.get(Playlist, playlist_id) is None:
            logger.info("playlist %s no longer exists; import skipped", playlist_id)
            return
    placed: set[int] = set()
    job_ids: list[int] = []
    for index, entry_url in enumerate(entries):
        kind, ref = _enqueue_playlist_entry(playlist_id, entry_url, quality_preset)
        if kind == "job" and ref is not None:
            job_ids.append(ref)
        if kind == "library" and ref is not None and ref not in placed:
            placed.add(ref)
            with _playlist_attach_lock, Session(engine) as session:
                _upsert_playlist_item(session, playlist_id, ref, index)
        if activity_handle is not None:
            activity_handle.update(
                done=index + 1,
                detail=f"{index + 1}/{total} queued",
            )
    if job_ids:
        # Jobs that already finished attached themselves in playlist order.
        with Session(engine) as session:
            placed.update(
                vid
                for vid in session.exec(
                    select(DownloadJob.video_id).where(
                        DownloadJob.id.in_(job_ids),  # type: ignore[union-attr]
                        DownloadJob.video_id != None,  # noqa: E711 - SQL IS NOT NULL
                    )
                ).all()
                if vid is not None
            )
    _append_unlisted_playlist_items(playlist_id, placed, start_pos=total)


def _run_playlist_import(
    playlist_id: int, entries: list[str], quality_preset: str
) -> None:
    total = len(entries)
    with activity.track(
        "playlist_import",
        "Importing playlist",
        reason="Playlist import started",
        engine="yt-dlp",
        detail=f"0/{total} queued",
        total=total,
        done=0,
    ) as handle:
        run_playlist_entries(
            playlist_id, entries, quality_preset, activity_handle=handle
        )


def start_playlist_import(
    playlist_id: int, entries: list[str], quality_preset: str
) -> None:
    thread = threading.Thread(
        target=_run_playlist_import,
        args=(playlist_id, entries, quality_preset),
        daemon=True,
    )
    thread.start()

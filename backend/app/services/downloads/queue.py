"""The download scheduler: FIFO dispatch, pause/resume, cancel, restart and the reaper.

The queue does not know how a job is run. The code that runs one job (the
yt-dlp attempt loop) is handed in as ``runner`` so this module sits below it;
``app.context.build_context`` binds the real one.
"""

import logging
import threading
import time
from collections.abc import Callable

from sqlalchemy import func
from sqlmodel import Session, col, select

from ...config import MAX_DOWNLOAD_CONCURRENCY
from ...context import get_engine
from ...logging_config import FailureLog, job_context
from ...models import DownloadDestination, DownloadJob, JobStatus
from .. import notifications
from ..url_safety import UnsafeUrlError, validate_public_url
from ..workers import BackgroundWorker
from ..ytdlp_common import ERROR_KIND_CANCELLED
from . import dbwrite, lifecycle
from .errors import DownloadCancelled
from .progress import progress_store
from .space import Hold, SpaceGate

logger = logging.getLogger(__name__)

#: Runs one job to the end of its download stage: ``runner(job_id, cancel_event, queue)``.
JobRunner = Callable[[int, threading.Event, "DownloadQueue"], None]


# A `downloading` job nobody owns for this long goes back to `queued`.
STUCK_JOB_GRACE_SECONDS = 180.0


REAPER_INTERVAL_SECONDS = 60.0

# Held downloads are looked at again this often, so a freed disk or a raised
# limit starts them without anyone touching the queue.
HOLD_RECHECK_SECONDS = 30.0


class DownloadQueue:
    """FIFO download scheduler with global pause and bounded concurrency."""

    def __init__(self, runner: JobRunner | None = None) -> None:
        self.runner = runner
        #: False in the browser-test process: queued jobs are seeded and must never
        #: start yt-dlp. Set by ``build_context``.
        self.dispatch_enabled = True
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
        # ``lifecycle.mark_job_cancelled``) so the next boot resumes it.
        self._shutting_down = False
        self._threads: set[threading.Thread] = set()
        #: The library size limit and the free-space floor (see ``space``).
        self.space = SpaceGate()
        #: Queued jobs waiting for room, with why; rebuilt on every dispatch pass.
        self._space_holds: dict[int, Hold] = {}
        #: Expected size of a job, once its metadata showed it is too big to start.
        self._size_hints: dict[int, int] = {}

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
        from .. import app_settings as settings_svc

        paused = bool(settings_svc.load().get("download_queue_paused", False))
        with self._lock:
            self._global_paused = paused

        with Session(get_engine()) as session:
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
        from .. import app_settings as settings_svc

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
        with Session(get_engine()) as session:
            for job in session.exec(
                select(DownloadJob).where(
                    col(DownloadJob.status).in_(
                        [JobStatus.queued, JobStatus.downloading]
                    )
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
        from .. import app_settings as settings_svc

        with self._lock:
            self._global_paused = False
        settings_svc.save({"download_queue_paused": False})
        with Session(get_engine()) as session:
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
            self._space_holds.pop(job_id, None)
            self._size_hints.pop(job_id, None)
        if event is not None:
            event.set()
        with Session(get_engine()) as session:
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
        with Session(get_engine()) as session:
            return int(
                session.exec(
                    select(func.count())
                    .select_from(DownloadJob)
                    .where(
                        col(DownloadJob.status).in_(
                            [JobStatus.queued, JobStatus.downloading]
                        )
                    )
                ).one()
            )

    def reset(self) -> None:
        """Forget all in-memory job state (the e2e reset route and test isolation)."""
        with self._lock:
            self._global_paused = False
            self._running.clear()
            self._held.clear()
            self._restart_ids.clear()
            self._space_holds.clear()
            self._size_hints.clear()
            for event in self._cancel_events.values():
                event.set()
            self._cancel_events.clear()
        self.space.invalidate()
        self.space.clear_disk_full()
        progress_store.clear()

    def queued_count(self) -> int:
        with Session(get_engine()) as session:
            return int(
                session.exec(
                    select(func.count())
                    .select_from(DownloadJob)
                    .where(DownloadJob.status == JobStatus.queued)
                ).one()
            )

    def _dispatch(self) -> None:
        if not self.dispatch_enabled:
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
        """Oldest queued, unpaused job that is neither running nor held and has room.

        A job that must wait for disk space is left queued and remembered in
        ``_space_holds``; later jobs that fit (a device download, a smaller video)
        may still go ahead of it.
        """
        with self._lock:
            excluded = list(self._running | self._held)
            hints = dict(self._size_hints)
        with Session(get_engine()) as session:
            query = select(DownloadJob.id, DownloadJob.destination).where(
                DownloadJob.status == JobStatus.queued,
                DownloadJob.paused == False,  # noqa: E712 - SQL column comparison, not a Python truth test
            )
            if excluded:
                query = query.where(col(DownloadJob.id).notin_(excluded))
            candidates = [
                (job_id, destination)
                for job_id, destination in session.exec(
                    query.order_by(
                        col(DownloadJob.created_at).asc(), col(DownloadJob.id).asc()
                    )
                ).all()
                if job_id is not None
            ]
        holds: dict[int, Hold] = {}
        chosen: int | None = None
        for job_id, destination in candidates:
            hold = self.space.check(
                destination or DownloadDestination.library.value, hints.get(job_id)
            )
            if hold is None:
                chosen = job_id
                break
            holds[job_id] = hold
        evaluated = set(holds) if chosen is None else {*holds, chosen}
        self._update_space_holds(
            [job_id for job_id, _dest in candidates], evaluated, holds
        )
        return chosen

    # -- disk space -------------------------------------------------------

    def _update_space_holds(
        self, queued: list[int], evaluated: set[int], holds: dict[int, Hold]
    ) -> None:
        """Record which queued jobs wait for room, and tell their cards what changed.

        ``queued`` are the waiting jobs in FIFO order, ``evaluated`` the ones this
        pass looked at (it stops at the first job that may start) and ``holds`` the
        evaluated ones that must wait. Jobs after the stopping point keep their
        previous state.
        """
        with self._lock:
            before = self._space_holds
            kept = {
                j: h for j, h in before.items() if j in queued and j not in evaluated
            }
            kept.update(holds)
            self._space_holds = after = {j: kept[j] for j in queued if j in kept}
            live = set(queued) | self._running | self._held
            self._size_hints = {j: n for j, n in self._size_hints.items() if j in live}
        if after and not before:
            # The queue went from running freely to waiting for room. Disk space
            # that hovers around the floor must not send one a minute.
            first = next(iter(after.values()))
            notifications.emit(
                notifications.events.QUEUE_HELD,
                {"code": first.code, "reason": first.reason},
                dedupe_key="queue-held",
                dedupe_ttl=1800,
            )
        for job_id, hold in after.items():
            if before.get(job_id) != hold:
                progress_store.merge(
                    job_id, {"status": "queued", "held_reason": hold.reason}
                )
        for job_id in before.keys() - after.keys():
            if job_id in progress_store:
                progress_store.merge(job_id, {"held_reason": None})

    def held_reason(self, job_id: int) -> str | None:
        """Why a queued job is waiting for disk space, if it is."""
        with self._lock:
            hold = self._space_holds.get(job_id)
        return hold.reason if hold else None

    def space_hold(self) -> Hold | None:
        """The reason the queue is waiting for disk space, if any job is."""
        with self._lock:
            return next(iter(self._space_holds.values()), None)

    def hold_for_size(self, job_id: int, estimate: int) -> Hold | None:
        """Remember a job's expected size; returns why it cannot start with that size."""
        with self._lock:
            self._size_hints[job_id] = estimate
        return self.space.check(DownloadDestination.library.value, estimate)

    def note_disk_full(self) -> None:
        """A write failed with "no space left on device": start nothing for a while."""
        self.space.note_disk_full()

    def library_changed(self, *, room_made: bool = False) -> None:
        """The library grew or shrank, or a limit changed: look at held jobs again.

        ``room_made`` (a deletion, a raised limit) also lifts the hold that an
        out-of-space write put on the queue.
        """
        self.space.invalidate()
        if room_made:
            self.space.clear_disk_full()
        self._dispatch()

    def recheck_holds(self) -> None:
        """The periodic look at held jobs (a disk freed outside Horde, say)."""
        if self.space_hold() is not None:
            self.space.invalidate()
            self._dispatch()

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
        with Session(get_engine()) as session:
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
        """The worker that requeues orphaned jobs, prunes finished progress and rechecks held jobs."""

        def loop(worker: BackgroundWorker) -> None:
            failures = FailureLog(logger, "stuck-job reaper pass failed")
            tick = min(interval, HOLD_RECHECK_SECONDS)
            last_reap = time.monotonic()
            while not worker.sleep(tick):
                try:
                    self.recheck_holds()
                    if time.monotonic() - last_reap >= interval:
                        last_reap = time.monotonic()
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
            with Session(get_engine()) as session:
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
            if self.runner is None:
                raise RuntimeError("the download queue has no job runner bound")
            try:
                self.runner(job_id, cancel_event, self)
            except DownloadCancelled:
                lifecycle.mark_job_cancelled(self, job_id, destination)
        except Exception as exc:
            logger.exception("download worker for job %s crashed", job_id)
            lifecycle.force_job_error(job_id, exc)
        finally:
            with self._lock:
                self._running.discard(job_id)
                self._threads.discard(threading.current_thread())
                if job_id not in self._ffmpeg_running:
                    self._cancel_events.pop(job_id, None)
            self._dispatch()


download_queue = DownloadQueue()

import logging
import threading
import time
from pathlib import Path
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ..database import engine
from ..logging_config import job_context
from ..models import (
    DownloadDestination,
    DownloadJob,
    JobStatus,
    Playlist,
    Video,
)
from . import activity, library, scanner
from .downloads import dbwrite, lifecycle
from .downloads.artifacts import (
    cleanup_partial_files,
    reject_unplayable,
    resolve_merged_video,
)
from .downloads.errors import (
    DownloadCancelled,
    YtdlpLogger,
    is_recoverable_download_error,
    purge_members_only_url,
)
from .downloads.finalize import complete_download
from .downloads.infodict import as_info, merge_info

# Facade: public names that moved to ``services/downloads`` (see the end of the
# import block); importers outside the package keep working through them.
from .downloads.playlist_attach import (
    append_unlisted_playlist_items,
    playlist_attach_lock,
    upsert_playlist_item,
)
from .downloads.postprocess import PostprocessTask
from .downloads.progress import (
    STAGE_REMUXING,
    make_postprocessor_hook,
    make_progress_hook,
    set_processing_stage,
)
from .downloads.progress import progress_store as progress_store
from .downloads.queue import REAPER_INTERVAL_SECONDS as REAPER_INTERVAL_SECONDS
from .downloads.queue import STUCK_JOB_GRACE_SECONDS as STUCK_JOB_GRACE_SECONDS
from .downloads.queue import DownloadQueue, download_queue
from .downloads.staging import DEVICE_STAGING_DIR as DEVICE_STAGING_DIR
from .downloads.staging import (
    cleanup_device_job_files,
    device_job_dir,
    discard_staging_unless_requeued,
    download_outtmpl,
    library_rel,
)
from .downloads.staging import device_outtmpl as device_outtmpl
from .downloads.staging import gc_orphaned_device_dirs as gc_orphaned_device_dirs
from .downloads.staging import is_device_staging_path as is_device_staging_path
from .downloads.staging import remove_staging_dir as remove_staging_dir
from .downloads.subtitles import download_subtitles as download_subtitles
from .fsutil import (
    safe_rel,
)
from .outtmpl import (
    windows_filenames_ok,
)
from .paths import (
    staging_dir,
)
from .url_clean import clean_url, youtube_thumbnail_url, youtube_video_id
from .ytdlp_common import (
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

# Facade: API routers and tests reach these through ``downloader.<name>`` (tests
# monkeypatch them here), so they are re-exported explicitly (``x as x``).
from .ytdlp_extract import estimate_playlist_sizes as estimate_playlist_sizes
from .ytdlp_extract import extract_playlist as extract_playlist
from .ytdlp_extract import extract_playlist_entries as extract_playlist_entries
from .ytdlp_extract import extract_preview as extract_preview
from .ytdlp_extract import fetch_channel_feed as fetch_channel_feed
from .ytdlp_extract import (
    is_youtube_short_entry,
    is_youtube_short_url,
)
from .ytdlp_extract import search_youtube_channels as search_youtube_channels
from .ytdlp_formats import (
    QUALITY_FORMATS,
    _format_chain,
    apply_audio_format_id,
    decode_available_presets,
    default_download_video_codec,
    format_sort_for,
    pick_original_audio_format,
    resolve_quality_preset,
)
from .ytdlp_formats import _available_presets as _available_presets
from .ytdlp_formats import _has_audio as _has_audio
from .ytdlp_formats import _height_to_tier as _height_to_tier

logger = logging.getLogger(__name__)


DUPLICATE_QUEUED = "already_queued"
DUPLICATE_DOWNLOADING = "already_downloading"
DUPLICATE_LIBRARY = "already_in_library"
DUPLICATE_MESSAGES = {
    DUPLICATE_QUEUED: "Already queued",
    DUPLICATE_DOWNLOADING: "Already downloading",
    DUPLICATE_LIBRARY: "Already in library",
}


# QUALITY_FORMATS / PRESET_MAX_HEIGHT / STANDARD_HEIGHTS / _format_chain: see ytdlp_formats


# yt-dlp per-format fragments (e.g. ".f401.mp4") — not the final merged file.


# Fall through: leave other errors to raised exceptions / default silence.


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


class FfmpegQueue:
    """Bounded remux/transcode/loudnorm so a slow encode does not hold a download slot."""

    name = "ffmpeg-queue"
    stop_timeout = 10.0

    def __init__(self) -> None:
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

    def _abandon(self, task: PostprocessTask) -> None:
        """Requeue a postprocess task that never started (shutdown)."""
        try:
            # Explicit: the download queue may not have been told to stop yet
            # (workers are signalled newest first), and a cancel would delete the
            # finished download that is waiting for its remux.
            lifecycle.mark_job_cancelled(
                download_queue, task.job_id, task.destination, requeue=True
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

    def enqueue(self, task: PostprocessTask) -> None:
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

    def _worker(self, task: PostprocessTask) -> None:
        with job_context(f"download-{task.job_id}"):
            self._run_task(task)

    def _run_task(self, task: PostprocessTask) -> None:
        try:
            complete_download(
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
            lifecycle.mark_job_cancelled(download_queue, task.job_id, task.destination)
        except Exception as exc:
            logger.warning("postprocess of job %s failed", task.job_id, exc_info=True)
            lifecycle.fail_postprocess_job(
                download_queue, task.job_id, task.destination, exc
            )
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
    set_processing_stage(job_id, STAGE_REMUXING, progress=0.0)
    ffmpeg_queue.enqueue(
        PostprocessTask(
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


def _run_download(
    job_id: int,
    cancel_event: threading.Event | None = None,
    queue: DownloadQueue | None = None,
) -> int | None:
    import yt_dlp

    queue = queue or download_queue
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
        "progress_hooks": [make_progress_hook(job_id, cancel, act)],
        "postprocessor_hooks": [make_postprocessor_hook(job_id, cancel, act)],
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
                if not (cancel.is_set() and queue.is_shutting_down()):
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
        stopping = queue.is_shutting_down()
        if not stopping:
            # On shutdown the staged fragments stay: the job resumes from them.
            cleanup_partial_files(active_paths)
        restarting = queue.is_quality_restart(job_id)
        pausing = queue.is_paused()
        lifecycle.mark_job_cancelled(queue, job_id, destination)
        if restarting or pausing or stopping:
            act.discard()
        else:
            act.finish(status="cancelled")
        return None

    except Exception as exc:
        if cancel.is_set():
            if not queue.is_shutting_down():
                cleanup_partial_files(active_paths)
            lifecycle.mark_job_cancelled(queue, job_id, destination)
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
    attached by ``attach_download_to_playlist`` when it completes; see
    ``attach_slot`` for how playlist order is kept. Items on the playlist that
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
            with playlist_attach_lock, Session(engine) as session:
                upsert_playlist_item(session, playlist_id, ref, index)
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
    append_unlisted_playlist_items(playlist_id, placed, start_pos=total)


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


download_queue.runner = _run_download

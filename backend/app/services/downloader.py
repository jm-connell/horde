import logging
import threading
import time
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ..database import engine
from ..models import (
    DownloadDestination,
    DownloadJob,
    JobStatus,
    Playlist,
    Video,
)
from . import activity, library

# Facade: public names that moved to ``services/downloads`` (see the end of the
# import block); importers outside the package keep working through them.
from .downloads.ffmpeg_queue import ffmpeg_queue as ffmpeg_queue
from .downloads.playlist_attach import (
    append_unlisted_playlist_items,
    playlist_attach_lock,
    upsert_playlist_item,
)
from .downloads.progress import progress_store as progress_store
from .downloads.queue import REAPER_INTERVAL_SECONDS as REAPER_INTERVAL_SECONDS
from .downloads.queue import STUCK_JOB_GRACE_SECONDS as STUCK_JOB_GRACE_SECONDS
from .downloads.queue import DownloadQueue as DownloadQueue
from .downloads.queue import download_queue
from .downloads.staging import DEVICE_STAGING_DIR as DEVICE_STAGING_DIR
from .downloads.staging import (
    cleanup_device_job_files,
)
from .downloads.staging import device_outtmpl as device_outtmpl
from .downloads.staging import gc_orphaned_device_dirs as gc_orphaned_device_dirs
from .downloads.staging import is_device_staging_path as is_device_staging_path
from .downloads.staging import remove_staging_dir as remove_staging_dir
from .downloads.subtitles import download_subtitles as download_subtitles
from .url_clean import clean_url, youtube_thumbnail_url, youtube_video_id

# Facade: API routers and tests reach these through ``downloader.<name>`` (tests
# monkeypatch them here), so they are re-exported explicitly (``x as x``).
from .ytdlp_extract import estimate_playlist_sizes as estimate_playlist_sizes
from .ytdlp_extract import extract_playlist as extract_playlist
from .ytdlp_extract import extract_playlist_entries as extract_playlist_entries
from .ytdlp_extract import extract_preview as extract_preview
from .ytdlp_extract import fetch_channel_feed as fetch_channel_feed
from .ytdlp_extract import (
    is_youtube_short_url,
)
from .ytdlp_extract import search_youtube_channels as search_youtube_channels
from .ytdlp_formats import (
    QUALITY_FORMATS,
    decode_available_presets,
    default_download_video_codec,
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


# QUALITY_FORMATS / PRESET_MAX_HEIGHT / STANDARD_HEIGHTS / format_chain: see ytdlp_formats


# yt-dlp per-format fragments (e.g. ".f401.mp4") — not the final merged file.


# Fall through: leave other errors to raised exceptions / default silence.


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

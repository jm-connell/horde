"""Finishing a download: postprocess, promote into the library, commit the row.

``complete_download`` is the second stage of a job (the first is the yt-dlp
attempt loop in the runner). Everything slow happens before the one short
database transaction that makes the video visible.
"""

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlmodel import Session, select

from ...context import get_engine, get_paths
from ...models import (
    DownloadDestination,
    DownloadJob,
    JobStatus,
    Video,
    VideoStatus,
    require_id,
)
from .. import activity, compat_rendition, library, scanner
from ..fsutil import MoveJournal, safe_unlink
from ..media_info import apply_stream_info, needs_compat, probe_stream_info
from ..metadata import probe_dimensions, probe_duration
from ..paths import find_video_by_path, resolve_compat_path, to_rel_path
from ..thumbnails import save_from_url
from ..video_delete import delete_video_cascade, remove_files
from ..ytdlp_extract import list_thumbnail_url
from ..ytdlp_formats import compat_copy_cap, is_audio_preset
from . import artifacts, dbwrite, postprocess, subtitles
from .errors import DownloadCancelled
from .infodict import as_info, collect_tags, published_at
from .playlist_attach import attach_download_to_playlist
from .postprocess import PostprocessTask
from .progress import (
    progress_store,
)
from .spec import JobSpec
from .staging import promote_from_staging, rollback_or_log

logger = logging.getLogger(__name__)


def finalize_in_background(
    video_id: int,
    final_path: Path,
    source_url: str,
    thumbnail_url: str | None,
    list_thumbnail_url: str | None = None,
) -> None:
    """Fetch subtitles and thumbnail without blocking watchability."""

    def run() -> None:
        title: str | None = None
        with Session(get_engine()) as session:
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
                from ..subtitle_retry import apply_subtitle_outcome, outcome_from_fetch

                try:
                    outcome = subtitles.download_subtitles(final_path, source_url)
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
                thumb = save_from_url(
                    thumbnail_url, video_id, list_url=list_thumbnail_url
                )
            except Exception:
                logger.warning(
                    "could not save the thumbnail for video %s", video_id, exc_info=True
                )
                thumb = None
            if thumb:
                with Session(get_engine()) as session:
                    video = session.get(Video, video_id)
                    if video is None:
                        return
                    video.thumbnail_path = thumb
                    session.add(video)
                    session.commit()
            # Re-embed even if captions are still pending (hash updates later).
            try:
                from ..ai import enqueue_for_video

                enqueue_for_video(video_id, include_tags=False, force=False)
            except Exception:
                logger.warning(
                    "could not queue AI indexing for video %s",
                    video_id,
                    exc_info=True,
                )
            try:
                from ..sprites import enqueue_sprite_generation

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


@dataclass(frozen=True)
class MediaFacts:
    """What is known about the processed file, probed before any database write."""

    file_size: int | None
    duration: Any
    width: int | None
    height: int | None
    stream_info: Any = None


@dataclass
class CommittedVideo:
    video_id: int
    channel_url: str | None
    channel_name: str | None
    want_sidecar: bool
    # Files the previous version of a replaced video owned; delete after commit.
    stale_paths: list[Path]


@dataclass(frozen=True)
class CommitRequest:
    """Everything the library row for a finished download is written from."""

    spec: JobSpec
    final_path: Path
    rel_path: str
    info: dict[str, Any]
    source_url: str
    facts: MediaFacts


def probe_facts(path: Path, info: dict[str, Any], *, is_library: bool) -> MediaFacts:
    """Everything slow (ffprobe, stat) happens here, so the write transaction that
    follows is only a handful of statements."""
    file_size = path.stat().st_size if path.exists() else None
    duration = probe_duration(path) or info.get("duration")
    dims = probe_dimensions(path)
    width: int | None
    height: int | None
    if dims:
        width, height = dims
    else:
        raw_w = info.get("width")
        raw_h = info.get("height")
        width = int(raw_w) if raw_w else None
        height = int(raw_h) if raw_h else None
    stream_info = probe_stream_info(path) if is_library else None
    return MediaFacts(file_size, duration, width, height, stream_info)


def _warnings(
    snapshot: dict[str, Any], quality: str | None, volume: str | None
) -> dict[str, Any]:
    if quality:
        snapshot["quality_warning"] = quality
    if volume:
        snapshot["volume_warning"] = volume
    return snapshot


def complete_download(task: PostprocessTask) -> int | None:
    """Second stage of a job: postprocess, then device file or library commit.

    Returns the new library video id (``None`` for a device download).
    """
    spec = task.spec
    if task.cancel_event.is_set():
        raise DownloadCancelled()
    info = as_info(task.info)
    media = postprocess.process_media(task, info)
    if task.cancel_event.is_set():
        raise DownloadCancelled()

    facts = probe_facts(media.final_path, info, is_library=not spec.is_device)
    quality_warning = postprocess.check_quality(
        spec.quality_preset, int(facts.height) if facts.height else None, spec.codec
    )
    warnings = (quality_warning, media.volume_warning)
    if spec.is_device:
        _complete_device(spec, info, media.final_path, facts, warnings)
        return None
    return _complete_library(task, info, media.final_path, facts, warnings)


def _complete_device(
    spec: JobSpec,
    info: dict[str, Any],
    final_path: Path,
    facts: MediaFacts,
    warnings: tuple[str | None, str | None],
) -> None:
    """Ephemeral "to this device" download: no library row, sprites or AI."""
    with Session(get_engine()) as session:
        job = session.get(DownloadJob, spec.job_id)
        title = (
            (job.title_override if job else None)
            or spec.title_override
            or info.get("title")
            or final_path.stem
        )
        channel = (
            (job.channel_override if job else None)
            or spec.channel_override
            or (job.channel if job else None)
            or info.get("uploader")
            or info.get("channel")
        )
    snapshot = _warnings(
        {
            "status": "completed",
            "progress": 100.0,
            "destination": DownloadDestination.device.value,
            "title": title,
            "channel": channel,
            "file_size": facts.file_size,
        },
        *warnings,
    )
    dbwrite.update_job(
        spec.job_id,
        status=JobStatus.completed,
        progress=100.0,
        title=title,
        device_file_path=to_rel_path(final_path),
        file_size=facts.file_size,
        height_px=facts.height,
        video_id=None,
        error=None,
        error_kind=None,
    )
    progress_store[spec.job_id] = snapshot


def _promote_into_library(
    final_path: Path, staging_dir: Path
) -> tuple[Path, MoveJournal]:
    """Validate the processed file, then move it into the library.

    A failed move puts everything back; the returned journal lets the caller do
    the same if the database commit fails.
    """
    if not artifacts.validate_playable(final_path):
        raise RuntimeError("Processed file is not playable")
    journal = MoveJournal(get_paths().downloads)
    try:
        return promote_from_staging(journal, final_path, staging_dir), journal
    except BaseException:
        rollback_or_log(journal)
        raise


def _commit_or_roll_back(
    request: CommitRequest, journal: MoveJournal | None, staged: bool
) -> CommittedVideo:
    try:
        committed = dbwrite.retry_db_locked(
            lambda: commit_library_video(request=request),
            what=f"library row for job {request.spec.job_id}",
        )
    except BaseException:
        if journal is not None:
            rollback_or_log(journal)
        raise
    if journal is not None:
        journal.commit()
    if staged:
        scanner.unmark_active(request.rel_path)
    return committed


def _remove_replaced_files(stale_paths: list[Path]) -> None:
    """The new row is durable: only now remove what it replaced (old media,
    subtitles, stale H.264 sidecar). Done before the finalize thread starts so it
    cannot delete freshly fetched subtitles that share a name."""
    for stale in stale_paths:
        if not safe_unlink(stale):
            logger.warning(
                "could not remove the replaced file %s after commit; "
                "delete it manually if it is still there",
                stale,
            )


def _queue_follow_up_work(
    committed: CommittedVideo,
    info: dict[str, Any],
    final_path: Path,
    source_url: str,
) -> None:
    """AI enrichment, channel catalog, subtitles/thumbnail and the H.264 sidecar."""
    video_id = committed.video_id
    # Queue metadata embed + tag enrich (subtitles re-embed after finalize).
    try:
        from ..ai import enqueue_for_video

        enqueue_for_video(video_id, include_tags=True, force=False)
    except Exception:
        logger.warning(
            "could not queue AI enrichment for video %s", video_id, exc_info=True
        )

    # Index channel library in the background on first download from a channel.
    try:
        if committed.channel_url:
            from .. import channel_catalog

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

    finalize_in_background(
        video_id,
        final_path,
        source_url,
        info.get("thumbnail"),
        list_thumbnail_url(info, info.get("id")),
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


def _complete_library(
    task: PostprocessTask,
    info: dict[str, Any],
    final_path: Path,
    facts: MediaFacts,
    warnings: tuple[str | None, str | None],
) -> int:
    spec = task.spec
    rel_path = to_rel_path(final_path)
    journal: MoveJournal | None = None
    if task.staging_dir is not None:
        final_path, journal = _promote_into_library(final_path, task.staging_dir)
        rel_path = to_rel_path(final_path)
        scanner.mark_active(rel_path)

    source_url = info.get("webpage_url") or spec.url
    request = CommitRequest(spec, final_path, rel_path, info, source_url, facts)
    committed = _commit_or_roll_back(request, journal, task.staging_dir is not None)
    video_id = committed.video_id
    _remove_replaced_files(committed.stale_paths)
    remove_review_duplicates_for(info.get("id"), video_id)
    _queue_follow_up_work(committed, info, final_path, source_url)

    snapshot = _warnings(
        {
            "status": "completed",
            "progress": 100.0,
            "destination": DownloadDestination.library.value,
            "video_id": video_id,
            "title": info.get("title"),
            "file_size": facts.file_size,
        },
        *warnings,
    )
    dbwrite.update_job(
        spec.job_id,
        status=JobStatus.completed,
        progress=100.0,
        title=info.get("title"),
        video_id=video_id,
        file_size=facts.file_size,
        height_px=facts.height,
        error=None,
        error_kind=None,
    )
    attach_download_to_playlist(spec.job_id, video_id)
    progress_store[spec.job_id] = snapshot
    return video_id


def _resolve_target(
    session: Session, request: CommitRequest
) -> tuple[Video, bool, list[Path]]:
    """The row this download becomes: a replaced video, or a new one.

    Returns ``(video, is_replace, stale paths)``; the stale files belong to the
    previous version of a replaced video and are returned, not deleted, so a
    failed commit never costs the user the previous copy.
    """
    spec, info = request.spec, request.info
    replace_video_id = spec.replace_video_id
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
            spec.job_id,
        )
        replace_video_id = None
    if replace_video_id and video is not None:
        return video, True, _stale_files_of(video, request.final_path)
    video = find_video_by_path(session, request.rel_path)
    if video is None:
        video = Video(file_path=request.rel_path)  # type: ignore[call-arg]  # table models skip validation; _apply_display_title sets title before the flush
        session.add(video)
    return video, False, []


def _stale_files_of(video: Video, final_path: Path) -> list[Path]:
    stale: list[Path] = []
    old_path = get_paths().downloads / video.file_path
    if old_path.resolve() != final_path.resolve():
        stale.append(old_path)
    for track in library.parse_subtitles(video.subtitles):
        if track.get("path"):
            stale.append(get_paths().downloads / track["path"])
    # New original → any previous H.264 sidecar is stale.
    old_compat = resolve_compat_path(video)
    if old_compat is not None:
        stale.append(old_compat)
    return stale


def _apply_display_title(
    video: Video, request: CommitRequest, job: DownloadJob | None, is_replace: bool
) -> None:
    effective_title = (
        job.title_override if job else None
    ) or request.spec.title_override
    remote_title = request.info.get("title") or request.final_path.stem
    remote_description = request.info.get("description")

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
    if not (is_replace and video.description_is_custom):
        video.description = remote_description


def _apply_channel(
    video: Video, request: CommitRequest, job: DownloadJob | None
) -> None:
    info = request.info
    effective_channel = (
        (job.channel_override if job else None)
        or request.spec.channel_override
        or (job.channel if job else None)
    )
    video.channel = effective_channel or info.get("uploader") or info.get("channel")
    video.channel_url = info.get("uploader_url") or info.get("channel_url")


def _apply_remote_metadata(
    session: Session, video: Video, info: dict[str, Any], is_replace: bool
) -> None:
    from ..chapters import apply_source_chapters

    apply_source_chapters(video, info)

    tags_locked = False
    if is_replace and video.id is not None:
        from ...models import VideoAiMeta

        meta = session.get(VideoAiMeta, video.id)
        tags_locked = bool(meta is not None and meta.tags_locked)
    if not tags_locked:
        video.tags = library.dump_tags(collect_tags(info))

    video.published_at = published_at(info)
    video.view_count = info.get("view_count")
    video.channel_subscriber_count = info.get("channel_follower_count")
    video.platform = info.get("extractor_key")


def _apply_file_facts(video: Video, request: CommitRequest) -> None:
    facts = request.facts
    video.source_url = request.source_url
    video.duration_sec = facts.duration
    video.file_size = facts.file_size
    video.width_px = facts.width
    video.height_px = facts.height
    video.subtitles = library.dump_subtitles([])
    video.subtitles_pending = True
    video.needs_review = False
    video.status = VideoStatus.ready
    video.file_path = request.rel_path
    if request.spec.notes_pending:
        video.notes = request.spec.notes_pending
    apply_stream_info(video, facts.stream_info)
    video.compat_path = None
    video.compat_size = None
    video.compat_source = None
    video.compat_error = None


def commit_library_video(request: CommitRequest) -> CommittedVideo:
    """Write the library row for a finished download. Database work only.

    Runs in one short transaction with no file I/O. Anything that has to be
    deleted for a replaced video is returned, not deleted: the caller removes it
    once this commit succeeded, so a failed commit never costs the user the
    previous copy.
    """
    with Session(get_engine()) as session:
        job = session.get(DownloadJob, request.spec.job_id)
        video, is_replace, stale = _resolve_target(session, request)
        _apply_display_title(video, request, job, is_replace)
        _apply_channel(video, request, job)
        _apply_remote_metadata(session, video, request.info, is_replace)
        _apply_file_facts(video, request)

        session.commit()
        session.refresh(video)
        want_sidecar = (
            request.spec.codec == "sidecar"
            and not is_audio_preset(request.spec.quality_preset)
            and needs_compat(video, compat_copy_cap())
        )
        return CommittedVideo(
            video_id=require_id(video),
            channel_url=video.channel_url,
            channel_name=video.channel,
            want_sidecar=want_sidecar,
            stale_paths=stale,
        )


def remove_review_duplicates(
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


def remove_review_duplicates_for(yt_id: str | None, video_id: int) -> None:
    with Session(get_engine()) as session:
        remove_review_duplicates(session, yt_id, keep_id=video_id)

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

from ...config import DOWNLOADS_DIR
from ...database import engine
from ...models import DownloadDestination, DownloadJob, JobStatus, Video, VideoStatus
from .. import activity, compat_rendition, library, scanner
from ..ffmpeg_progress import FfmpegCancelled
from ..fsutil import MoveJournal, safe_unlink
from ..media_info import apply_stream_info, needs_compat, probe_stream_info
from ..metadata import probe_dimensions, probe_duration
from ..mp4_compat import compat_plan, ensure_safari_mp4, probe_media
from ..paths import find_video_by_path, resolve_compat_path, to_rel_path
from ..thumbnails import save_from_url
from ..video_delete import delete_video_cascade, remove_files
from ..video_transcode import encode_target, transcode_video
from ..ytdlp_extract import list_thumbnail_url
from ..ytdlp_formats import compat_copy_cap, is_audio_preset, normalize_video_codec
from . import artifacts, dbwrite, postprocess, subtitles
from .errors import DownloadCancelled
from .infodict import as_info, collect_tags, published_at
from .playlist_attach import attach_download_to_playlist
from .progress import (
    STAGE_NORMALIZING,
    STAGE_TRANSCODING,
    processing_stage_for_compat,
    progress_store,
    set_processing_stage,
)
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
                with Session(engine) as session:
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


def complete_download(
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
        set_processing_stage(job_id, stage, progress=pct)

    try:
        if final_path.exists():
            probe = probe_media(final_path)
            if probe is not None:
                stage = processing_stage_for_compat(compat_plan(probe))
                if stage:
                    set_processing_stage(job_id, stage, progress=0.0)
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
                set_processing_stage(job_id, STAGE_TRANSCODING, progress=0.0)
                final_path = transcode_video(
                    final_path,
                    target,
                    cancel_event=cancel_event,
                    on_progress=_on_ffmpeg_progress,
                    duration=duration_f,
                )

        volume_warning: str | None = None
        if normalize_volume and final_path.exists():
            set_processing_stage(job_id, STAGE_NORMALIZING, progress=0.0)
            volume_warning = postprocess.apply_loudnorm(
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

    quality_warning = postprocess.check_quality(
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
            lambda: commit_library_video(
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

    remove_review_duplicates_for(info.get("id"), video_id)

    # Queue metadata embed + tag enrich (subtitles re-embed after finalize).
    try:
        from ..ai import enqueue_for_video

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
    attach_download_to_playlist(job_id, video_id)
    progress_store[job_id] = snapshot
    return video_id


@dataclass
class CommittedVideo:
    video_id: int
    channel_url: str | None
    channel_name: str | None
    want_sidecar: bool
    # Files the previous version of a replaced video owned; delete after commit.
    stale_paths: list[Path]


def commit_library_video(
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
) -> CommittedVideo:
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

        from ..chapters import apply_source_chapters

        apply_source_chapters(video, info)

        tags_locked = False
        if is_replace and video.id is not None:
            from ...models import VideoAiMeta

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
        return CommittedVideo(
            video_id=video.id,
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
    with Session(engine) as session:
        remove_review_duplicates(session, yt_id, keep_id=video_id)

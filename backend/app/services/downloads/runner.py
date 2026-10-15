"""The first stage of a job: the yt-dlp attempt loop that produces a media file.

``run_download`` fetches metadata, tries each format selector in turn (with one
cookie retry), picks the finished file and hands it to the postprocess queue.
"""

import logging
import threading
from pathlib import Path
from typing import Any

from sqlmodel import Session

from ...database import engine
from ...models import DownloadDestination, DownloadJob, JobStatus
from .. import activity, scanner
from ..fsutil import safe_rel
from ..outtmpl import windows_filenames_ok
from ..paths import staging_dir
from ..ytdlp_common import (
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
from ..ytdlp_extract import is_youtube_short_entry
from ..ytdlp_formats import (
    apply_audio_format_id,
    format_chain,
    format_sort_for,
    pick_original_audio_format,
)
from . import dbwrite, lifecycle
from .artifacts import cleanup_partial_files, reject_unplayable, resolve_merged_video
from .errors import (
    DownloadCancelled,
    YtdlpLogger,
    is_recoverable_download_error,
    purge_members_only_url,
)
from .ffmpeg_queue import ffmpeg_queue
from .infodict import as_info, merge_info
from .postprocess import PostprocessTask
from .progress import (
    STAGE_REMUXING,
    make_postprocessor_hook,
    make_progress_hook,
    progress_store,
    set_processing_stage,
)
from .queue import DownloadQueue, download_queue
from .spec import JobSpec
from .staging import (
    cleanup_device_job_files,
    device_job_dir,
    discard_staging_unless_requeued,
    download_outtmpl,
    library_rel,
)

logger = logging.getLogger(__name__)


def handoff_postprocess(task: PostprocessTask) -> None:
    """Queue the finished download for remux/transcode/loudnorm and the library commit."""
    set_processing_stage(task.job_id, STAGE_REMUXING, progress=0.0)
    ffmpeg_queue.enqueue(task)


def run_download(
    job_id: int,
    cancel_event: threading.Event | None = None,
    queue: DownloadQueue | None = None,
) -> int | None:
    import yt_dlp

    queue = queue or download_queue
    cancel = cancel_event or threading.Event()

    spec = JobSpec.load(job_id)
    if spec is None:
        return None
    url = spec.url
    quality_preset = spec.quality_preset
    title_override = spec.title_override
    channel_override = spec.channel_override
    job_title = spec.title
    job_channel = spec.channel
    destination = spec.destination
    video_codec = spec.video_codec

    if destination == DownloadDestination.device.value:
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
        for fmt in format_chain(quality_preset, video_codec):
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
        handoff_postprocess(
            PostprocessTask(
                spec=spec,
                final_path=final_path,
                info=effective_info,
                cancel_event=cancel,
                staging_dir=staging,
                active_marks=set(marked),
            )
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
                handoff_postprocess(
                    PostprocessTask(
                        spec=spec,
                        final_path=recovered,
                        info=effective_info,
                        cancel_event=cancel,
                        staging_dir=staging,
                        active_marks=set(marked),
                    )
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

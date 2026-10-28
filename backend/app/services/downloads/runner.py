"""The first stage of a job: the yt-dlp attempt loop that produces a media file.

``run_download`` fetches metadata, tries each format selector in turn (with one
cookie retry), picks the finished file and hands it to the postprocess queue.
The state of one run lives on ``DownloadRun``; each step of the loop is a small
method so the control flow (what is retried, what ends the job) stays readable.
"""

import enum
import errno
import logging
import threading
from pathlib import Path
from typing import Any

from sqlmodel import Session

from ...context import get_engine
from ...models import DownloadJob, JobStatus
from .. import activity, scanner
from ..fsutil import safe_rel
from ..live.sessions import is_live_info
from ..outtmpl import windows_filenames_ok
from ..paths import staging_dir
from ..ytdlp_common import (
    ERROR_KIND_DISK_FULL,
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
    is_disk_full_error,
    is_members_only_entry,
    is_members_only_error,
    record_extract_failure,
    remember_cookie_required,
    should_retry_with_cookies,
    url_cookie_required,
    youtube_extractor_args,
)
from ..ytdlp_extract import estimate_download_bytes, is_youtube_short_entry
from ..ytdlp_formats import (
    apply_audio_format_id,
    format_chain,
    format_sort_for,
    pick_original_audio_format,
)
from . import clips, dbwrite, lifecycle
from .artifacts import cleanup_partial_files, reject_unplayable, resolve_merged_video
from .errors import (
    DownloadCancelled,
    DownloadHeld,
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

_MEMBERS_ONLY_SKIPPED = "Members-only video — skipped"


class _Outcome(enum.Enum):
    """What one pass over a format selector came to."""

    FOUND = "found"  # a finished file is in ``final_path``
    EMPTY = "empty"  # no usable file: try the next selector
    SKIPPED = "skipped"  # the job was dropped (a YouTube Short)


def handoff_postprocess(task: PostprocessTask) -> None:
    """Queue the finished download for remux/transcode/loudnorm and the library commit."""
    set_processing_stage(task.job_id, STAGE_REMUXING, progress=0.0)
    ffmpeg_queue.enqueue(task)


def run_download(
    job_id: int,
    cancel_event: threading.Event | None = None,
    queue: DownloadQueue | None = None,
) -> None:
    spec = JobSpec.load(job_id)
    if spec is None:
        return
    DownloadRun(
        spec, cancel_event or threading.Event(), queue or download_queue
    ).execute()


class DownloadRun:
    """One execution of a job's download stage, from queued to handed off (or ended)."""

    def __init__(
        self, spec: JobSpec, cancel: threading.Event, queue: DownloadQueue
    ) -> None:
        self.spec = spec
        self.cancel = cancel
        self.queue = queue
        self.staging: Path | None = None
        self.out_root: Path
        self.active_paths: set[str] = set()
        self.attempt_paths: set[str] = set()
        self.marked: set[str] = set()
        self.info: dict[str, Any] = {}
        self.metadata_info: dict[str, Any] = {}
        self.prepared: Path | None = None
        self.final_path: Path | None = None
        self.last_exc: Exception | None = None
        self.ytdlp_logger = YtdlpLogger()
        self.used_cookies = False
        self.base_opts: dict[str, Any] = {}
        self.fmt = ""
        self.handed_off = False
        #: A clip being cut from a live broadcast (no yt-dlp format retries).
        self.live_clip = False
        self.act: activity.ActivityHandle

    # -- the run ---------------------------------------------------------------

    def execute(self) -> None:
        self._open_workdir()
        self._raise_if_cancelled()
        dbwrite.update_job(
            self.spec.job_id,
            status=JobStatus.downloading,
            paused=False,
            error=None,
            error_kind=None,
        )
        progress_store[self.spec.job_id] = {
            "status": "downloading",
            "progress": 0.0,
            "destination": self.spec.destination,
        }
        self._raise_if_cancelled()
        self._start_activity()
        try:
            self._download_and_hand_off()
        except DownloadCancelled:
            self._on_cancelled()
        except DownloadHeld as held:
            self._on_held(str(held))
        except Exception as exc:  # noqa: BLE001 - _on_error logs it and ends the job
            self._on_error(exc)
        finally:
            self._release()

    def _open_workdir(self) -> None:
        if self.spec.is_device:
            self.out_root = device_job_dir(self.spec.job_id)
            self.out_root.mkdir(parents=True, exist_ok=True)
            return
        # Library downloads never write into the library directly: a cancel or
        # failure must not touch the file a row already references.
        self.staging = staging_dir(self.spec.job_id)
        self.staging.mkdir(parents=True, exist_ok=True)
        self.out_root = self.staging

    def _raise_if_cancelled(self) -> None:
        if self.cancel.is_set():
            raise DownloadCancelled()

    def _start_activity(self) -> None:
        spec = self.spec
        self.act = activity.start(
            "download",
            "Downloading video",
            reason="Queued from the Download tab",
            engine="yt-dlp",
            detail=spec.title_override or spec.url,
            total=100,
            done=0,
        )
        self.used_cookies = url_cookie_required(spec.url)
        self.base_opts = {
            "progress_hooks": [make_progress_hook(spec.job_id, self.cancel, self.act)],
            "postprocessor_hooks": [
                make_postprocessor_hook(spec.job_id, self.cancel, self.act)
            ],
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "logger": self.ytdlp_logger,
            "merge_output_format": "mp4",
            "ignoreerrors": True,
            "overwrites": True,
            "windowsfilenames": windows_filenames_ok(self.out_root),
            "format_sort": format_sort_for(spec.quality_preset, spec.video_codec),
            "file_access_retries": 10,
            "retry_sleep_functions": {"file_access": lambda n: 0.5 * (n + 1)},
            "extractor_args": youtube_extractor_args(),
        }

    def _download_and_hand_off(self) -> None:
        if self._run_formats():
            return
        self._members_only_check()
        path = self._settled_final_path()
        self._raise_if_cancelled()
        self._hand_off(path)

    def _members_only_check(self) -> None:
        if self.ytdlp_logger.members_only:
            raise MembersOnlyError(_MEMBERS_ONLY_SKIPPED)

    def _disk_full_check(self) -> None:
        if self.ytdlp_logger.disk_full:
            raise OSError(errno.ENOSPC, "No space left on device")

    def _settled_final_path(self) -> Path:
        """Pick the finished file after the attempts, or fail with the last error."""
        path = self.final_path
        if path is None or not path.exists():
            path = resolve_merged_video(self.prepared, self.active_paths)
        path = reject_unplayable(path, self.active_paths)
        if path is None or not path.exists() or path.stat().st_size <= 0:
            raise self.last_exc or RuntimeError("Download produced no file")
        return path

    # -- the attempt loop ------------------------------------------------------

    def _run_formats(self) -> bool:
        """Try each format selector until one yields a file; True if the job was skipped."""
        for fmt in format_chain(self.spec.quality_preset, self.spec.video_codec):
            self.attempt_paths = set()
            try:
                outcome = self._attempt(fmt)
            except MembersOnlyError, DownloadHeld:
                raise
            except Exception as exc:
                if self.live_clip:
                    # Another format selector would cut the same segments again.
                    self.last_exc = exc
                    raise
                if is_disk_full_error(exc):
                    # Another format needs the same space: end the job now.
                    self.last_exc = exc
                    raise
                if self._recovered_after_failure(exc):
                    break
                continue
            if outcome is _Outcome.SKIPPED:
                return True
            if outcome is _Outcome.FOUND:
                break
        return False

    def _recovered_after_failure(self, exc: Exception) -> bool:
        """A failed attempt may still have left a finished file; else clean up."""
        self.last_exc = exc
        if self.ytdlp_logger.members_only or is_members_only_error(exc):
            raise MembersOnlyError(_MEMBERS_ONLY_SKIPPED) from exc
        recovered = resolve_merged_video(self.prepared, self.active_paths)
        recovered = reject_unplayable(recovered, self.attempt_paths)
        if recovered is not None:
            self.final_path = recovered
            return True
        if not (self.cancel.is_set() and self.queue.is_shutting_down()):
            cleanup_partial_files(self.attempt_paths)
        return False

    def _attempt(self, fmt: str) -> _Outcome:
        self.fmt = fmt
        ydl_opts = self._opts_for(fmt)
        fetched = self._fetch_metadata()
        if extract_used_cookies():
            self.used_cookies = True
            ydl_opts = apply_cookie_opts({**self.base_opts, "format": fmt})
        fetched_info = fetched if isinstance(fetched, dict) else None
        if is_members_only_entry(fetched_info) and not extract_has_media(fetched_info):
            raise MembersOnlyError(_MEMBERS_ONLY_SKIPPED)
        if self._is_short(fetched_info):
            self._skip_short()
            return _Outcome.SKIPPED
        self.metadata_info = merge_info(self.metadata_info, fetched)
        self.info = self.metadata_info
        clip = self.spec.clip
        if clip is not None and fetched_info is not None:
            if fetched_info.get("live_status") == "post_live":
                # The recording is still being processed: until then YouTube
                # serves only its last hours, on a timeline of their own.
                raise clips.ClipUnavailable(
                    "YouTube is still processing this stream. Retry the clip "
                    "once the recording is available."
                )
            if is_live_info(fetched_info):
                self.live_clip = True
                self._download_live_clip(fetched_info, *clip)
                return _Outcome.FOUND
        self._hold_if_too_big()
        ydl_opts = self._download_opts(ydl_opts, fmt)
        self._download(ydl_opts)
        found = self.final_path is not None and self.final_path.exists()
        return _Outcome.FOUND if found else _Outcome.EMPTY

    def _hold_if_too_big(self) -> None:
        """With a library size limit set, wait if this video would not fit under it."""
        if self.spec.is_device or self.queue.space.limit_bytes() is None:
            return
        estimate = estimate_download_bytes(self.metadata_info, self.spec.quality_preset)
        if not estimate:
            return
        clip = self.spec.clip
        if clip is not None:
            duration = self.metadata_info.get("duration")
            if not duration:
                return
            estimate = int(estimate * min(1.0, (clip[1] - clip[0]) / float(duration)))
        hold = self.queue.hold_for_size(self.spec.job_id, estimate)
        if hold is not None:
            raise DownloadHeld(hold.reason)

    def _opts_for(self, fmt: str) -> dict[str, Any]:
        opts = {**self.base_opts, "format": fmt}
        return apply_cookie_opts(opts) if self.used_cookies else opts

    def _fetch_metadata(self) -> Any:
        spec = self.spec
        # Share extract spacing with preview/meta so downloads don't stampede
        # YouTube alongside feed browsing.
        meta_opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "logger": QuietYtdlpLogger(),
            "extractor_args": youtube_extractor_args(),
        }
        try:
            return extract_info_gated(
                spec.url,
                meta_opts,
                cache_key=spec.url,
                title=spec.title_override or spec.title,
                channel=spec.channel_override or spec.channel,
                priority=EXTRACT_PRIORITY_DOWNLOAD,
            )
        except Exception as exc:
            if is_members_only_error(exc):
                raise MembersOnlyError(_MEMBERS_ONLY_SKIPPED) from exc
            raise

    def _is_short(self, fetched_info: dict[str, Any] | None) -> bool:
        url = self.spec.url
        return is_youtube_short_entry(
            {**(fetched_info or {}), "url": url, "webpage_url": url}
        )

    def _skip_short(self) -> None:
        spec = self.spec
        cleanup_partial_files(self.active_paths)
        with Session(get_engine()) as session:
            job = session.get(DownloadJob, spec.job_id)
            if job is not None:
                session.delete(job)
                session.commit()
        progress_store[spec.job_id] = {
            "status": "skipped",
            "reason": "shorts",
            "url": spec.url,
        }
        self.act.discard()

    def _download_opts(self, ydl_opts: dict[str, Any], fmt: str) -> dict[str, Any]:
        """The yt-dlp options for the real download, once the metadata is known."""
        outtmpl, _ = download_outtmpl(
            self.spec.destination,
            self.spec.job_id,
            self.metadata_info,
            self.spec.channel_override,
            self.out_root,
        )
        clip = self.spec.clip
        if clip is not None:
            import yt_dlp

            with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as namer:
                outtmpl = clips.literal_outtmpl(
                    namer, outtmpl, clips.clip_info(self.metadata_info, *clip)
                )
            ydl_opts = {**ydl_opts, **clips.download_range_opts(*clip)}
        self.base_opts["outtmpl"] = outtmpl
        audio_fmt = pick_original_audio_format(self.metadata_info)
        audio_id = str(audio_fmt.get("format_id") or "") if audio_fmt else ""
        fmt_spec = apply_audio_format_id([fmt], audio_id)[0] if audio_id else fmt
        opts = {**ydl_opts, "outtmpl": outtmpl, "format": fmt_spec}
        return apply_cookie_opts(opts) if self.used_cookies else opts

    def _download_live_clip(
        self, live_info: dict[str, Any], start: float, end: float
    ) -> None:
        """Cut the clip from the broadcast's segments while it is still live."""
        import yt_dlp

        spec = self.spec
        info = clips.clip_info(self.metadata_info, start, end)
        outtmpl, _ = download_outtmpl(
            spec.destination, spec.job_id, info, spec.channel_override, self.out_root
        )
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as namer:
            dest = Path(namer.prepare_filename({**info, "ext": "mp4"}, outtmpl=outtmpl))
        self.prepared = dest
        rel = safe_rel(dest)
        if rel:
            self.attempt_paths.add(rel)
            self.active_paths.add(rel)
            self._mark_library_path(rel)

        def on_progress(percent: float) -> None:
            self._raise_if_cancelled()
            progress_store[spec.job_id] = {
                **progress_store.get(spec.job_id, {}),
                "status": "downloading",
                "progress": percent,
                "title": info.get("title"),
            }
            self.act.update(done=int(percent))

        self.final_path = clips.download_live_clip(
            live_info, start, end, dest, cancel=self.cancel, on_progress=on_progress
        )

    # -- one yt-dlp download ---------------------------------------------------

    def _download(self, ydl_opts: dict[str, Any]) -> None:
        import yt_dlp

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            self._members_only_check()
            self._register_outputs(ydl)
            progress_store[self.spec.job_id] = {
                **progress_store.get(self.spec.job_id, {}),
                "title": self.metadata_info.get("title"),
                "channel": self.metadata_info.get("uploader")
                or self.metadata_info.get("channel"),
            }
            try:
                self._extract(ydl)
            except Exception as exc:  # noqa: BLE001 - re-raised unless survivable
                self._handle_download_error(exc, ydl_opts)
            self._locate_output(ydl)

    def _register_outputs(self, ydl: Any) -> None:
        """Remember the files yt-dlp is about to write, and tell the scanner."""
        self.prepared = Path(ydl.prepare_filename(self.metadata_info))
        for candidate in (self.prepared, self.prepared.with_suffix(".mp4")):
            rel = safe_rel(candidate)
            if rel:
                self.attempt_paths.add(rel)
                self.active_paths.add(rel)
                self._mark_library_path(rel)

    def _mark_library_path(self, rel: str) -> None:
        lib = library_rel(rel, self.staging)
        if lib not in self.marked:
            self.marked.add(lib)
            scanner.mark_active(lib)

    def _extract(self, ydl: Any) -> None:
        downloaded = ydl.extract_info(self.spec.url, download=True)
        self._members_only_check()
        self._disk_full_check()
        self._absorb(downloaded)

    def _absorb(self, downloaded: Any) -> None:
        self.info = merge_info(self.metadata_info, downloaded)
        self.metadata_info = self.info

    def _handle_download_error(self, exc: Exception, ydl_opts: dict[str, Any]) -> None:
        """Decide what a failed ``extract_info`` means; raise unless it is survivable."""
        self.last_exc = exc
        if should_retry_with_cookies(
            ydl_opts, exc, logger_members_only=self.ytdlp_logger.members_only
        ):
            self._retry_with_cookies(exc)
        elif self.ytdlp_logger.members_only or is_members_only_error(exc):
            raise MembersOnlyError(_MEMBERS_ONLY_SKIPPED) from exc
        elif not is_recoverable_download_error(exc):
            raise exc
        else:
            self.final_path = resolve_merged_video(self.prepared, self.active_paths)
            self.final_path = reject_unplayable(self.final_path, self.attempt_paths)
            if self.final_path is None:
                raise exc

    def _retry_with_cookies(self, exc: Exception) -> None:
        """Run the download again once with cookies, after an age/members gate."""
        import yt_dlp

        url = self.spec.url
        self.used_cookies = True
        remember_cookie_required(url)
        self.ytdlp_logger.members_only = False
        logger.info("Retrying download with cookies after age/members gate: %s", url)
        cookie_opts = apply_cookie_opts({**self.base_opts, "format": self.fmt})
        with yt_dlp.YoutubeDL(cookie_opts) as ydl_auth:
            self._register_outputs(ydl_auth)
            downloaded = ydl_auth.extract_info(url, download=True)
            if self.ytdlp_logger.members_only:
                raise MembersOnlyError(_MEMBERS_ONLY_SKIPPED) from exc
            self._absorb(downloaded)

    def _locate_output(self, ydl: Any) -> None:
        """Find the file the download wrote (yt-dlp may name it differently)."""
        if self.final_path is None:
            self.final_path = resolve_merged_video(self.prepared, self.active_paths)
        if self.final_path is None and self.metadata_info:
            candidate = Path(ydl.prepare_filename(self.metadata_info))
            self.final_path = candidate.with_suffix(".mp4")
            if not self.final_path.exists():
                self.final_path = candidate if candidate.exists() else None
        self.final_path = reject_unplayable(self.final_path, self.attempt_paths)

    # -- hand-off --------------------------------------------------------------

    def _effective_info(self) -> dict[str, Any]:
        info = merge_info(as_info(self.metadata_info), as_info(self.info))
        clip = self.spec.clip
        return info if clip is None else clips.clip_info(info, *clip)

    def _hand_off(self, path: Path) -> None:
        spec = self.spec
        info = self._effective_info()
        self.act.finish(
            detail=str(spec.title_override or info.get("title") or spec.url)
        )
        handoff_postprocess(
            PostprocessTask(
                spec=spec,
                final_path=path,
                info=info,
                cancel_event=self.cancel,
                staging_dir=self.staging,
                active_marks=set(self.marked),
            )
        )
        self.handed_off = True

    # -- endings ---------------------------------------------------------------

    def _on_cancelled(self) -> None:
        queue = self.queue
        stopping = queue.is_shutting_down()
        if not stopping:
            # On shutdown the staged fragments stay: the job resumes from them.
            cleanup_partial_files(self.active_paths)
        restarting = queue.is_quality_restart(self.spec.job_id)
        pausing = queue.is_paused()
        lifecycle.mark_job_cancelled(queue, self.spec.job_id, self.spec.destination)
        if restarting or pausing or stopping:
            self.act.discard()
        else:
            self.act.finish(status="cancelled")

    def _on_held(self, reason: str) -> None:
        """Back to the queue: the queue starts it again when there is room."""
        spec = self.spec
        dbwrite.update_job(
            spec.job_id, status=JobStatus.queued, progress=0.0, error=None
        )
        prev = progress_store.get(spec.job_id, {})
        progress_store[spec.job_id] = {
            "status": "queued",
            "progress": 0.0,
            "title": prev.get("title") or self.metadata_info.get("title"),
            "channel": prev.get("channel"),
            "destination": spec.destination,
            "held_reason": reason,
        }
        self.act.discard()
        logger.info("download job %s held: %s", spec.job_id, reason)

    def _on_error(self, exc: Exception) -> None:
        if self.cancel.is_set():
            if not self.queue.is_shutting_down():
                cleanup_partial_files(self.active_paths)
            lifecycle.mark_job_cancelled(
                self.queue, self.spec.job_id, self.spec.destination
            )
            self.act.finish(status="cancelled")
            return
        if self._hand_off_recovered_file():
            return
        self._fail(exc)

    def _hand_off_recovered_file(self) -> bool:
        """A failure after yt-dlp finished the file still yields a download."""
        recovered = resolve_merged_video(self.prepared, self.active_paths)
        recovered = reject_unplayable(recovered, self.active_paths)
        if (
            recovered is None
            or not recovered.exists()
            or recovered.stat().st_size <= 0
            or self.cancel.is_set()
        ):
            return False
        try:
            self._hand_off(recovered)
        except Exception:
            logger.warning(
                "could not hand recovered download %s to postprocess",
                self.spec.job_id,
                exc_info=True,
            )
            return False
        return True

    def _subject(self) -> tuple[Any, Any]:
        """Title and channel to name the video in an error message."""
        spec, meta, info = self.spec, self.metadata_info, self.info
        title = (
            spec.title_override or meta.get("title") or info.get("title") or spec.title
        )
        channel = (
            spec.channel_override
            or meta.get("uploader")
            or meta.get("channel")
            or info.get("uploader")
            or info.get("channel")
            or spec.channel
        )
        return title, channel

    def _fail(self, exc: Exception) -> None:
        spec = self.spec
        cleanup_partial_files(self.active_paths)
        if spec.is_device:
            cleanup_device_job_files(spec.job_id)
        prev = progress_store.get(spec.job_id, {})
        title, channel = self._subject()
        kind, message = classify_ytdlp_error(
            exc, url=spec.url, title=title, channel=channel
        )
        if kind == ERROR_KIND_MEMBERS or is_members_only_error(exc):
            kind = ERROR_KIND_MEMBERS
            message = classify_ytdlp_error(
                MembersOnlyError(_MEMBERS_ONLY_SKIPPED),
                url=spec.url,
                title=title,
                channel=channel,
            )[1]
            purge_members_only_url(spec.url)
        if kind == ERROR_KIND_DISK_FULL:
            self.queue.note_disk_full()
        else:
            record_extract_failure(
                kind, message, url=spec.url, title=title, channel=channel
            )
        if kind == ERROR_KIND_UNKNOWN:
            logger.exception("download job %s failed unexpectedly", spec.job_id)
        else:
            logger.warning(
                "download job %s failed (%s): %s", spec.job_id, kind, message
            )
        dbwrite.update_job(
            spec.job_id,
            status=JobStatus.error,
            error=message,
            error_kind=kind,
            device_file_path=None,
        )
        progress_store[spec.job_id] = {
            "status": "error",
            "error": message,
            "error_kind": kind,
            "title": prev.get("title"),
            "channel": prev.get("channel"),
            "destination": spec.destination,
        }
        self.act.finish(status="failed", error=message[:500])

    def _release(self) -> None:
        # Ensure activity never leaks if an unexpected path skips finish.
        self.act.discard()
        if not self.handed_off:
            # The postprocess stage owns the marks and the staging dir once it
            # has the job; otherwise release them here.
            for lib in self.marked:
                scanner.unmark_active(lib)
            discard_staging_unless_requeued(self.spec.job_id)

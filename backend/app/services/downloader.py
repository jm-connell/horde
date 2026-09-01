import logging
import re
import secrets
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from xml.sax.saxutils import escape as xml_escape

import httpx
from sqlmodel import Session, select

logger = logging.getLogger(__name__)

from ..config import DOWNLOADS_DIR, MAX_DOWNLOAD_CONCURRENCY, THUMBNAILS_DIR, VIDEO_EXTENSIONS
from ..database import engine
from ..models import DownloadDestination, DownloadJob, JobStatus, Video, VideoStatus
from . import activity, library, scanner
from .metadata import probe_dimensions, probe_duration, probe_is_playable
from .mp4_compat import ensure_safari_mp4
from .paths import find_video_by_path, to_rel_path
from .ytdlp_common import (
    ERROR_KIND_CANCELLED,
    ERROR_KIND_MEMBERS,
    ERROR_KIND_UNKNOWN,
    MembersOnlyError,
    QuietYtdlpLogger,
    apply_cookie_opts,
    classify_ytdlp_error,
    extract_info_gated,
    is_members_only_entry,
    is_members_only_error,
    is_members_only_message,
    record_extract_failure,
    youtube_extractor_args,
)

from .ytdlp_formats import (
    FORMAT_SORT,
    PRESET_MAX_HEIGHT,
    QUALITY_FORMATS,
    STANDARD_HEIGHTS,
    _available_presets,
    _format_chain,
    _has_audio,
    _height_to_tier,
    format_chain,
)
from .ytdlp_extract import (
    estimate_playlist_sizes,
    extract_playlist,
    extract_playlist_entries,
    extract_preview,
    fetch_channel_feed,
    search_youtube_channels,
)


# Live progress snapshots keyed by job id, consumed by the SSE endpoint.
progress_store: dict[int, dict[str, Any]] = {}

# QUALITY_FORMATS / PRESET_MAX_HEIGHT / STANDARD_HEIGHTS / _format_chain: see ytdlp_formats

OUTPUT_TEMPLATE = str(
    DOWNLOADS_DIR / "%(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s].%(ext)s"
)

# Ephemeral staging for "download to this device" jobs (not library media).
DEVICE_STAGING_DIR = "_device"


def device_job_dir(job_id: int) -> Path:
    return DOWNLOADS_DIR / DEVICE_STAGING_DIR / str(job_id)


def device_outtmpl(job_id: int) -> str:
    return str(device_job_dir(job_id) / "%(title)s [%(id)s].%(ext)s")


def is_device_staging_path(rel_path: str) -> bool:
    posix = (rel_path or "").replace("\\", "/").lstrip("/")
    return posix == DEVICE_STAGING_DIR or posix.startswith(f"{DEVICE_STAGING_DIR}/")


def cleanup_device_job_files(
    job_id: int, device_file_path: Optional[str] = None
) -> None:
    """Remove ephemeral device-job media (file + staging dir)."""
    root = DOWNLOADS_DIR.resolve()
    staging = (DOWNLOADS_DIR / DEVICE_STAGING_DIR).resolve()
    if device_file_path and is_device_staging_path(device_file_path):
        full = (DOWNLOADS_DIR / device_file_path).resolve()
        try:
            full.relative_to(root)
        except ValueError:
            pass
        else:
            _safe_unlink(full)
            parent = full.parent
            if parent.is_dir():
                stem = full.stem
                for entry in list(parent.iterdir()):
                    if entry.name.startswith(stem) or entry.suffix in {
                        ".part",
                        ".ytdl",
                    }:
                        _safe_unlink(entry)
    job_dir = device_job_dir(job_id)
    try:
        resolved = job_dir.resolve()
        resolved.relative_to(staging)
    except (OSError, ValueError):
        return
    if resolved.is_dir():
        shutil.rmtree(resolved, ignore_errors=True)


def gc_orphaned_device_dirs() -> int:
    """Remove `_device/{id}` dirs with no matching device DownloadJob row."""
    root = DOWNLOADS_DIR / DEVICE_STAGING_DIR
    if not root.is_dir():
        return 0
    removed = 0
    with Session(engine) as session:
        for child in list(root.iterdir()):
            if not child.is_dir() or not child.name.isdigit():
                continue
            job_id = int(child.name)
            job = session.get(DownloadJob, job_id)
            keep = (
                job is not None
                and job.destination == DownloadDestination.device.value
                and job.status
                in (JobStatus.queued, JobStatus.downloading, JobStatus.completed)
            )
            if keep:
                continue
            shutil.rmtree(child, ignore_errors=True)
            removed += 1
    return removed


# yt-dlp per-format fragments (e.g. ".f401.mp4") — not the final merged file.
_FRAGMENT_RE = re.compile(r"\.f\d+\.[^.]+$")
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _as_info(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _merge_info(base: dict[str, Any], extra: Any) -> dict[str, Any]:
    if not isinstance(extra, dict) or not extra:
        return base
    return {**base, **extra}


def _is_recoverable_download_error(exc: Exception) -> bool:
    msg = str(exc)
    return (
        "Unable to rename file" in msg
        or "Unable to download video subtitles" in msg
        or "Postprocessing:" in msg
        or "'NoneType' object has no attribute 'get'" in msg
    )


def _video_stem(path: Path) -> str:
    stem = path.stem
    if ".f" in stem:
        return stem.rsplit(".f", 1)[0]
    return stem


def _is_intermediate_media(name: str) -> bool:
    """True for yt-dlp/ffmpeg sidecars that are not the final library file."""
    low = name.lower()
    if _FRAGMENT_RE.search(name) or low.endswith(".part"):
        return True
    if ".temp." in low or low.endswith(".temp.mp4"):
        return True
    if ".norm." in low or low.endswith(".norm.mp4"):
        return True
    if ".compat." in low or low.endswith(".compat.mp4"):
        return True
    return False


def _find_merged_video(prepared: Path) -> Optional[Path]:
    """Locate the final merged video when yt-dlp errors on fragment cleanup."""
    mp4 = prepared.with_suffix(".mp4")
    if mp4.exists() and not _is_intermediate_media(mp4.name):
        return mp4
    if (
        prepared.exists()
        and prepared.suffix.lower() in VIDEO_EXTENSIONS
        and not _is_intermediate_media(prepared.name)
    ):
        return prepared

    parent = prepared.parent
    stem = _video_stem(prepared)
    best: Optional[Path] = None
    best_size = 0
    if not parent.is_dir():
        return None
    for entry in parent.iterdir():
        if not entry.is_file():
            continue
        if not entry.name.startswith(stem):
            continue
        if entry.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        if _is_intermediate_media(entry.name):
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        if size > best_size:
            best_size = size
            best = entry
    return best


def _resolve_merged_video(
    prepared: Optional[Path], active_paths: set[str]
) -> Optional[Path]:
    if prepared is not None:
        found = _find_merged_video(prepared)
        if found is not None:
            return found
    for rel in active_paths:
        found = _find_merged_video(DOWNLOADS_DIR / rel)
        if found is not None:
            return found
    return None


class DownloadCancelled(Exception):
    """Raised from yt-dlp progress hooks when a job is cancelled or paused."""


class _YtdlpLogger:
    """Suppress noisy Windows file-lock rename errors from intermediate fragments."""

    def __init__(self) -> None:
        self.members_only = False
        self.last_members_only_msg: Optional[str] = None

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        if "Unable to rename file" in msg:
            return
        if "Unable to download video subtitles" in msg:
            return
        if is_members_only_message(msg):
            self.members_only = True
            self.last_members_only_msg = msg
            return
        # Fall through: leave other errors to raised exceptions / default silence.


def _purge_members_only_yt_id(yt_id: str) -> None:
    try:
        from .channel_catalog.skips import purge_members_only_by_yt_id

        purge_members_only_by_yt_id(yt_id)
    except Exception:  # noqa: BLE001
        logger.debug("members-only catalog purge failed", exc_info=True)


def _purge_members_only_url(url: str) -> None:
    from .url_clean import youtube_video_id

    yt_id = youtube_video_id(url)
    if yt_id:
        _purge_members_only_yt_id(yt_id)


class DownloadQueue:
    """FIFO download scheduler with global pause and bounded concurrency."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._global_paused = False
        self._running: set[int] = set()
        self._cancel_events: dict[int, threading.Event] = {}

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
                select(DownloadJob).where(
                    DownloadJob.status == JobStatus.downloading
                )
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
                        DownloadJob.paused == False,  # noqa: E712
                    )
                ).all():
                    job.paused = True
                    session.add(job)
            else:
                for job in session.exec(
                    select(DownloadJob).where(
                        DownloadJob.status == JobStatus.queued,
                        DownloadJob.paused == True,  # noqa: E712
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
            events = list(self._cancel_events.values())
        settings_svc.save({"download_queue_paused": True})
        for event in events:
            event.set()
        with Session(engine) as session:
            for job in session.exec(
                select(DownloadJob).where(
                    DownloadJob.status.in_(
                        [JobStatus.queued, JobStatus.downloading]
                    )
                )
            ).all():
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
                    DownloadJob.paused == True,  # noqa: E712
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

    def active_count(self) -> int:
        with Session(engine) as session:
            return len(
                session.exec(
                    select(DownloadJob).where(
                        DownloadJob.status.in_(
                            [
                                JobStatus.queued,
                                JobStatus.downloading,
                            ]
                        )
                    )
                ).all()
            )

    def queued_count(self) -> int:
        with Session(engine) as session:
            return len(
                session.exec(
                    select(DownloadJob).where(
                        DownloadJob.status == JobStatus.queued
                    )
                ).all()
            )

    def _dispatch(self) -> None:
        with self._lock:
            if self._global_paused:
                return
            while len(self._running) < MAX_DOWNLOAD_CONCURRENCY:
                job_id = self._next_job_id()
                if job_id is None:
                    break
                self._running.add(job_id)
                cancel_event = threading.Event()
                self._cancel_events[job_id] = cancel_event
                threading.Thread(
                    target=self._worker,
                    args=(job_id, cancel_event),
                    daemon=True,
                ).start()

    def _next_job_id(self) -> Optional[int]:
        """Return next queued job not already claimed. Caller must hold _lock."""
        with Session(engine) as session:
            jobs = session.exec(
                select(DownloadJob)
                .where(
                    DownloadJob.status == JobStatus.queued,
                    DownloadJob.paused == False,  # noqa: E712
                )
                .order_by(DownloadJob.created_at.asc())
            ).all()
            for job in jobs:
                if job.id is not None and job.id not in self._running:
                    return job.id
            return None

    def _worker(self, job_id: int, cancel_event: threading.Event) -> None:
        try:
            with Session(engine) as session:
                job = session.get(DownloadJob, job_id)
                if job is None or job.status != JobStatus.queued:
                    return
            _run_download(job_id, cancel_event=cancel_event)
        finally:
            with self._lock:
                self._running.discard(job_id)
                self._cancel_events.pop(job_id, None)
            self._dispatch()


download_queue = DownloadQueue()


def _update_job(job_id: int, **fields: Any) -> None:
    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is None:
            return
        for key, value in fields.items():
            setattr(job, key, value)
        session.add(job)
        session.commit()


_STREAM_SWITCH_SLOP = 512 * 1024


def _positive_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _progress_stream_total(d: dict[str, Any]) -> Optional[int]:
    """Whole-file size for the current stream, not the current HTTP Range."""
    info = _as_info(d.get("info_dict"))
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

    def _apply_downloaded(
        self, downloaded: int, stream_total: Optional[int]
    ) -> None:
        self.last_stream_downloaded = max(self.last_stream_downloaded, downloaded)
        if stream_total:
            self.last_stream_total = max(self.last_stream_total, stream_total)
        combined = self.accumulated_bytes + self.last_stream_downloaded
        self.max_displayed_bytes = max(self.max_displayed_bytes, combined)

    def _combined_total(self) -> Optional[int]:
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
        if name and _is_intermediate_media(name):
            return False
        info = _as_info(d.get("info_dict"))
        hint = _positive_int(info.get("filesize")) or _positive_int(
            info.get("filesize_approx")
        )
        if hint and downloaded and downloaded < int(hint * 0.95):
            return False
        return bool(name)

    def apply(self, d: dict[str, Any]) -> Optional[dict[str, Any]]:
        status = d.get("status")
        info = _as_info(d.get("info_dict"))
        if status == "downloading":
            downloaded = int(d.get("downloaded_bytes", 0) or 0)
            self._note_stream_switch(downloaded)
            self._apply_downloaded(downloaded, _progress_stream_total(d))
            return self._downloading_snapshot(info)
        if status == "finished":
            downloaded = (
                _positive_int(d.get("downloaded_bytes"))
                or self.last_stream_downloaded
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


def _make_progress_hook(
    job_id: int,
    cancel_event: threading.Event,
    activity_handle: Optional[activity.ActivityHandle] = None,
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
            progress_store[job_id] = snap
            if activity_handle is None:
                return
            if snap.get("status") == "processing":
                activity_handle.update(
                    done=99,
                    total=100,
                    detail="Merging streams",
                    engine="ffmpeg",
                )
                return
            now = time.time()
            pct_i = int(snap.get("progress") or 0)
            if now - last_activity_at >= 1.0 or pct_i >= last_activity_pct + 5:
                last_activity_at = now
                last_activity_pct = pct_i
                activity_handle.update(
                    done=pct_i,
                    total=100,
                    detail=snap.get("title") or None,
                )
        except DownloadCancelled:
            raise
        except Exception:  # noqa: BLE001 — never fail a download over progress UI
            return

    return hook


def _save_thumbnail(url: Optional[str], video_id: int) -> Optional[str]:
    if not url:
        return None
    dest = THUMBNAILS_DIR / f"{video_id}.jpg"
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
        return str(dest)
    except (httpx.HTTPError, OSError):
        return None


def _collect_tags(info: dict[str, Any]) -> list[str]:
    info = _as_info(info)
    collected: list[str] = []
    seen: set[str] = set()
    for key in ("tags", "categories"):
        for item in info.get(key) or []:
            tag = str(item).strip()
            low = tag.lower()
            if tag and low not in seen:
                seen.add(low)
                collected.append(tag)
    return collected


def _safe_rel(path: Path) -> Optional[str]:
    try:
        return to_rel_path(path)
    except ValueError:
        return None


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
        if not entry.name.startswith(stem + "."):
            continue
        raw_lang = entry.name[len(stem) + 1 : -len(".vtt")]
        rel = _safe_rel(entry)
        if not raw_lang or not rel:
            continue
        lang = _normalize_lang(raw_lang)
        if lang not in by_lang or raw_lang.lower() == lang:
            by_lang[lang] = {"lang": lang, "path": rel, "auto": False}
    return list(by_lang.values())


def _safe_unlink(path: Path, retries: int = 5) -> None:
    """Delete a file, retrying on Windows file-lock errors."""
    for attempt in range(retries):
        try:
            path.unlink(missing_ok=True)
            return
        except PermissionError:
            if attempt == retries - 1:
                return
            time.sleep(0.15 * (attempt + 1))
        except OSError:
            return


def _cleanup_subtitle_partials(parent: Path, stem: str) -> None:
    if not parent.is_dir():
        return
    for entry in parent.iterdir():
        if entry.is_file() and entry.name.startswith(stem + ".") and (
            entry.name.endswith(".part") or entry.suffix.lower() == ".part"
        ):
            _safe_unlink(entry)


def _subtitle_ydl_opts(outtmpl: str) -> dict[str, Any]:
    return apply_cookie_opts(
        {
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
        }
    )


def download_subtitles(media: Path, source_url: str) -> list[dict[str, Any]]:
    """Best-effort subtitle fetch; never raises. Uses a temp dir to avoid Windows locks."""
    import tempfile

    import yt_dlp

    if not media.exists():
        return []

    parent = media.parent
    stem = media.stem
    _cleanup_subtitle_partials(parent, stem)

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            outtmpl = str(Path(tmpdir) / f"{stem}.%(ext)s")
            with yt_dlp.YoutubeDL(_subtitle_ydl_opts(outtmpl)) as ydl:
                ydl.download([source_url])

            for entry in Path(tmpdir).iterdir():
                if not entry.is_file() or entry.suffix.lower() != ".vtt":
                    continue
                dest = parent / entry.name
                try:
                    shutil.copy2(entry, dest)
                except OSError:
                    _safe_unlink(dest)
                    try:
                        shutil.copy2(entry, dest)
                    except OSError:
                        pass
    except Exception:  # noqa: BLE001
        pass

    return _collect_subtitles(media)


def _remove_review_duplicates(
    session: Session, video_id: Optional[str], keep_id: Optional[int]
) -> None:
    if not video_id:
        return
    token = f"[{video_id}]"
    rows = session.exec(
        select(Video).where(Video.needs_review == True)  # noqa: E712
    ).all()
    for row in rows:
        if row.id == keep_id or token not in row.file_path:
            continue
        if row.thumbnail_path:
            Path(row.thumbnail_path).unlink(missing_ok=True)
        session.delete(row)
    session.commit()


def _published_at(info: dict[str, Any]) -> Optional[datetime]:
    raw = info.get("upload_date")
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y%m%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _validate_playable(path: Path) -> bool:
    """Return True when the file is a complete, decodable video."""
    return probe_is_playable(path)


def _cleanup_download_artifacts(
    paths: set[str], *, remove_final: bool = False
) -> None:
    """Remove in-progress fragments and optionally corrupt final files."""
    for rel in paths:
        full = DOWNLOADS_DIR / rel
        parent = full.parent
        stem = _video_stem(full)
        if not parent.is_dir():
            continue
        for entry in parent.iterdir():
            if not entry.is_file() or not entry.name.startswith(stem):
                continue
            if entry.name.endswith(".part") or _FRAGMENT_RE.search(entry.name):
                _safe_unlink(entry)
                continue
            if remove_final and entry.suffix.lower() in VIDEO_EXTENSIONS:
                if _FRAGMENT_RE.search(entry.name) is None:
                    _safe_unlink(entry)


def _cleanup_partial_files(paths: set[str]) -> None:
    """Remove in-progress fragments; also drop unplayable merged files left by cancel."""
    _cleanup_download_artifacts(paths, remove_final=False)
    for rel in paths:
        full = DOWNLOADS_DIR / rel
        if not full.is_file():
            continue
        if _FRAGMENT_RE.search(full.name) or full.name.endswith(".part"):
            continue
        if full.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        if not _validate_playable(full):
            _safe_unlink(full)


def _check_quality(
    preset: str, height: Optional[int]
) -> Optional[str]:
    """Return a warning string if actual height is below the requested cap tier."""
    max_h = PRESET_MAX_HEIGHT.get(preset)
    if max_h is None or height is None:
        return None
    # Allow a few pixels of encoder/probe variance (e.g. 1078 vs 1080).
    if height + 8 < max_h:
        return (
            f"Requested {preset} but file is {height}p — "
            "source may not offer that quality."
        )
    return None


def _replace_with_retries(src: Path, dest: Path, retries: int = 8) -> None:
    """Atomically replace dest with src, retrying Windows file-lock errors."""
    last_exc: Optional[OSError] = None
    for attempt in range(retries):
        try:
            src.replace(dest)
            return
        except PermissionError as exc:
            last_exc = exc
            time.sleep(0.2 * (attempt + 1))
        except OSError as exc:
            # WinError 5 (access denied) can also be transient on Windows.
            if getattr(exc, "winerror", None) not in (5, 32) and not isinstance(
                exc, PermissionError
            ):
                raise
            last_exc = exc
            time.sleep(0.2 * (attempt + 1))
    if last_exc is not None:
        raise last_exc


def _apply_loudnorm(path: Path) -> Optional[str]:
    """Normalize loudness via ffmpeg; returns warning if skipped."""
    if not shutil.which("ffmpeg"):
        return "Volume normalization skipped: ffmpeg not found"
    # Unique sidecar so concurrent workers / scanner never share one .norm.mp4.
    tmp = path.with_name(
        f"{path.stem}.norm.{threading.get_ident()}.mp4"
    )
    tmp_rel = _safe_rel(tmp)
    if tmp_rel:
        scanner.mark_active(tmp_rel)
    cmd = [
        "ffmpeg",
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
            subprocess.run(cmd, check=True, capture_output=True, timeout=3600)
            _replace_with_retries(tmp, path)
        return None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        _safe_unlink(tmp)
        return "Volume normalization failed"
    finally:
        if tmp_rel:
            scanner.unmark_active(tmp_rel)
        if tmp.exists():
            _safe_unlink(tmp)


def _finalize_in_background(
    video_id: int,
    final_path: Path,
    source_url: str,
    thumbnail_url: Optional[str],
) -> None:
    """Fetch subtitles and thumbnail without blocking watchability."""

    def run() -> None:
        title: Optional[str] = None
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
            tracks: list[dict[str, Any]] = []
            thumb: Optional[str] = None
            try:
                tracks = download_subtitles(final_path, source_url)
                thumb = _save_thumbnail(thumbnail_url, video_id)
            except Exception:  # noqa: BLE001
                pass
            with Session(engine) as session:
                video = session.get(Video, video_id)
                if video is None:
                    return
                if tracks:
                    video.subtitles = library.dump_subtitles(tracks)
                if thumb:
                    video.thumbnail_path = thumb
                video.subtitles_pending = False
                session.add(video)
                session.commit()
            # Re-embed with subtitle text once captions are on disk.
            try:
                from .ai import enqueue_for_video

                enqueue_for_video(video_id, include_tags=False, force=False)
            except Exception:  # noqa: BLE001
                pass
            try:
                from .sprites import enqueue_sprite_generation

                enqueue_sprite_generation(
                    video_id,
                    reason="Download finished",
                )
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=run, daemon=True, name=f"finalize-{video_id}").start()


def _complete_download(
    job_id: int,
    final_path: Path,
    info: dict[str, Any],
    url: str,
    quality_preset: str,
    title_override: Optional[str],
    channel_override: Optional[str],
    normalize_volume: bool,
    replace_video_id: Optional[int],
    notes_pending: Optional[str],
    cancel_event: Optional[threading.Event] = None,
    destination: str = DownloadDestination.library.value,
) -> Optional[int]:
    if cancel_event is not None and cancel_event.is_set():
        raise DownloadCancelled()

    info = _as_info(info)
    source_url = info.get("webpage_url") or url

    if final_path.exists():
        final_path = ensure_safari_mp4(final_path)

    volume_warning: Optional[str] = None
    if normalize_volume and final_path.exists():
        volume_warning = _apply_loudnorm(final_path)

    if cancel_event is not None and cancel_event.is_set():
        raise DownloadCancelled()

    rel_path = to_rel_path(final_path)
    file_size = final_path.stat().st_size if final_path.exists() else None
    duration = probe_duration(final_path) or info.get("duration")
    width: Optional[int] = None
    height: Optional[int] = None
    dims = probe_dimensions(final_path)
    if dims:
        width, height = dims
    else:
        raw_w = info.get("width")
        raw_h = info.get("height")
        width = int(raw_w) if raw_w else None
        height = int(raw_h) if raw_h else None

    quality_warning = _check_quality(quality_preset, int(height) if height else None)

    # Ephemeral "to this device" — no library row, sprites, or AI.
    if destination == DownloadDestination.device.value:
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

        _update_job(
            job_id,
            status=JobStatus.completed,
            progress=100.0,
            title=effective_title,
            device_file_path=rel_path,
            file_size=file_size,
            video_id=None,
            error=None,
            error_kind=None,
        )
        progress_store[job_id] = snapshot
        return None

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

        if replace_video_id:
            video = session.get(Video, replace_video_id)
            if video is None:
                raise RuntimeError("Video to replace not found")
            old_path = DOWNLOADS_DIR / video.file_path
            if old_path.exists() and old_path.resolve() != final_path.resolve():
                _safe_unlink(old_path)
            for track in library.parse_subtitles(video.subtitles):
                sub = DOWNLOADS_DIR / track.get("path", "")
                if sub.exists():
                    _safe_unlink(sub)
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

        tags_locked = False
        if is_replace and video.id is not None:
            from ..models import VideoAiMeta

            meta = session.get(VideoAiMeta, video.id)
            tags_locked = bool(meta is not None and meta.tags_locked)
        if not tags_locked:
            video.tags = library.dump_tags(_collect_tags(info))

        video.source_url = source_url
        video.duration_sec = duration
        video.file_size = file_size
        video.width_px = width
        video.height_px = height
        video.published_at = _published_at(info)
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

        session.commit()
        session.refresh(video)

        _remove_review_duplicates(session, info.get("id"), keep_id=video.id)

        video_id = video.id
        catalog_channel_url = video.channel_url
        catalog_channel_name = video.channel

    # Queue metadata embed + tag enrich (subtitles re-embed after finalize).
    try:
        from .ai import enqueue_for_video

        enqueue_for_video(video_id, include_tags=True, force=False)
    except Exception:  # noqa: BLE001
        pass

    # Index channel library in the background on first download from a channel.
    try:
        if catalog_channel_url:
            from . import channel_catalog

            channel_catalog.enqueue_channel(
                catalog_channel_url,
                channel_name=catalog_channel_name,
                force=False,
            )
    except Exception:  # noqa: BLE001
        pass

    _finalize_in_background(
        video_id, final_path, source_url, info.get("thumbnail")
    )

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

    _update_job(
        job_id,
        status=JobStatus.completed,
        progress=100.0,
        title=info.get("title"),
        video_id=video_id,
        file_size=file_size,
        error=None,
        error_kind=None,
    )
    progress_store[job_id] = snapshot
    return video_id


def _reject_unplayable(
    path: Optional[Path], attempt_paths: set[str]
) -> Optional[Path]:
    """Return path if playable; otherwise remove corrupt artifacts and return None."""
    if path is None or not path.exists() or path.stat().st_size <= 0:
        return None
    if _validate_playable(path):
        return path
    rel = _safe_rel(path)
    if rel:
        _cleanup_download_artifacts({rel}, remove_final=True)
    _cleanup_partial_files(attempt_paths)
    return None


def _run_download(
    job_id: int,
    cancel_event: Optional[threading.Event] = None,
) -> Optional[int]:
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
        normalize_volume = job.normalize_volume
        replace_video_id = job.replace_video_id
        notes_pending = job.notes_pending
        destination = job.destination or DownloadDestination.library.value

    if destination == DownloadDestination.device.value:
        # Never overwrite a library row from an ephemeral device job.
        replace_video_id = None
        outtmpl = device_outtmpl(job_id)
        device_job_dir(job_id).mkdir(parents=True, exist_ok=True)
    else:
        outtmpl = str(
            DOWNLOADS_DIR
            / "%(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s].%(ext)s"
        )

    _update_job(
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

    active_paths: set[str] = set()
    info: dict[str, Any] = {}
    metadata_info: dict[str, Any] = {}
    prepared: Optional[Path] = None
    final_path: Optional[Path] = None
    last_exc: Optional[Exception] = None
    ytdlp_logger = _YtdlpLogger()

    act = activity.start(
        "download",
        "Downloading video",
        reason="Queued from the Download tab",
        engine="yt-dlp",
        detail=title_override or url,
        total=100,
        done=0,
    )

    base_ydl_opts: dict[str, Any] = apply_cookie_opts(
        {
            "outtmpl": outtmpl,
            "progress_hooks": [_make_progress_hook(job_id, cancel, act)],
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "logger": ytdlp_logger,
            "merge_output_format": "mp4",
            "ignoreerrors": True,
            "overwrites": True,
            "format_sort": FORMAT_SORT,
            "file_access_retries": 10,
            "retry_sleep_functions": {"file_access": lambda n: 0.5 * (n + 1)},
            "extractor_args": youtube_extractor_args(),
        }
    )

    try:
        for fmt in _format_chain(quality_preset):
            attempt_paths: set[str] = set()
            ydl_opts = {**base_ydl_opts, "format": fmt}
            try:
                # Share extract spacing with preview/meta so downloads don't
                # stampede YouTube alongside feed browsing.
                meta_opts = apply_cookie_opts(
                    {
                        "quiet": True,
                        "no_warnings": True,
                        "skip_download": True,
                        "logger": QuietYtdlpLogger(),
                        "extractor_args": youtube_extractor_args(),
                    }
                )
                try:
                    fetched = extract_info_gated(
                        url,
                        meta_opts,
                        cache_key=f"download-meta:{url}",
                    )
                except Exception as exc:
                    if is_members_only_error(exc):
                        raise MembersOnlyError(
                            "Members-only video — skipped"
                        ) from exc
                    raise

                if is_members_only_entry(
                    fetched if isinstance(fetched, dict) else None
                ):
                    raise MembersOnlyError("Members-only video — skipped")
                metadata_info = _merge_info(metadata_info, fetched)
                info = metadata_info

                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    if ytdlp_logger.members_only:
                        raise MembersOnlyError("Members-only video — skipped")
                    prepared = Path(ydl.prepare_filename(metadata_info))
                    for candidate in (prepared, prepared.with_suffix(".mp4")):
                        rel = _safe_rel(candidate)
                        if rel:
                            attempt_paths.add(rel)
                            active_paths.add(rel)
                            scanner.mark_active(rel)

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
                        info = _merge_info(metadata_info, downloaded)
                        metadata_info = info
                    except Exception as exc:
                        last_exc = exc
                        if ytdlp_logger.members_only or is_members_only_error(exc):
                            raise MembersOnlyError(
                                "Members-only video — skipped"
                            ) from exc
                        if not _is_recoverable_download_error(exc):
                            raise
                        final_path = _resolve_merged_video(prepared, active_paths)
                        final_path = _reject_unplayable(final_path, attempt_paths)
                        if final_path is None:
                            raise

                    if final_path is None:
                        final_path = _resolve_merged_video(prepared, active_paths)
                    if final_path is None and metadata_info:
                        candidate = Path(ydl.prepare_filename(metadata_info))
                        final_path = candidate.with_suffix(".mp4")
                        if not final_path.exists():
                            final_path = candidate if candidate.exists() else None

                    final_path = _reject_unplayable(final_path, attempt_paths)

                if final_path is not None and final_path.exists():
                    break
            except MembersOnlyError:
                raise
            except Exception as exc:
                last_exc = exc
                if ytdlp_logger.members_only or is_members_only_error(exc):
                    raise MembersOnlyError("Members-only video — skipped") from exc
                recovered = _resolve_merged_video(prepared, active_paths)
                recovered = _reject_unplayable(recovered, attempt_paths)
                if recovered is not None:
                    final_path = recovered
                    break
                _cleanup_partial_files(attempt_paths)

        if ytdlp_logger.members_only:
            raise MembersOnlyError("Members-only video — skipped")
        if final_path is None or not final_path.exists():
            final_path = _resolve_merged_video(prepared, active_paths)
        final_path = _reject_unplayable(final_path, active_paths)
        if final_path is None or not final_path.exists() or final_path.stat().st_size <= 0:
            raise last_exc or RuntimeError("Download produced no file")

        if cancel.is_set():
            raise DownloadCancelled()

        effective_info = _merge_info(_as_info(metadata_info), _as_info(info))
        detail = str(title_override or effective_info.get("title") or url)
        act.update(done=100, detail=detail)
        video_id = _complete_download(
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
            cancel_event=cancel,
            destination=destination,
        )
        act.finish(detail=detail)
        return video_id

    except DownloadCancelled:
        _cleanup_partial_files(active_paths)
        if destination == DownloadDestination.device.value:
            cleanup_device_job_files(job_id)
        with Session(engine) as session:
            job = session.get(DownloadJob, job_id)
            if job is None:
                act.finish(status="cancelled")
                return None
            if download_queue.is_paused():
                job.status = JobStatus.queued
                job.paused = True
                job.progress = 0.0
                job.error = None
                job.error_kind = None
                progress_store[job_id] = {
                    "status": "queued",
                    "progress": 0.0,
                    "title": job.title,
                    "channel": job.channel,
                    "destination": destination,
                }
                act.discard()
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
                act.finish(status="cancelled")
            session.add(job)
            session.commit()
        return None

    except Exception as exc:  # noqa: BLE001
        recovered = _resolve_merged_video(prepared, active_paths)
        recovered = _reject_unplayable(recovered, active_paths)
        effective_info = _merge_info(_as_info(metadata_info), _as_info(info))
        if (
            recovered is not None
            and recovered.exists()
            and recovered.stat().st_size > 0
            and not cancel.is_set()
        ):
            try:
                detail = str(
                    title_override or effective_info.get("title") or url
                )
                video_id = _complete_download(
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
                    cancel_event=cancel,
                    destination=destination,
                )
                act.finish(detail=detail)
                return video_id
            except Exception:  # noqa: BLE001
                pass

        _cleanup_partial_files(active_paths)
        if destination == DownloadDestination.device.value:
            cleanup_device_job_files(job_id)
        prev = progress_store.get(job_id, {})
        kind, message = classify_ytdlp_error(exc)
        if kind == ERROR_KIND_MEMBERS or is_members_only_error(exc):
            kind = ERROR_KIND_MEMBERS
            message = "Members-only video — skipped"
            _purge_members_only_url(url)
        record_extract_failure(kind, message)
        if kind == ERROR_KIND_UNKNOWN:
            logger.exception("download job %s failed unexpectedly", job_id)
        else:
            logger.warning("download job %s failed (%s): %s", job_id, kind, message)
        _update_job(
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
        # Keep paths marked briefly so the filesystem watcher does not race
        # the DB commit and try to ingest the file as a duplicate review item.
        paths = list(active_paths)

        def _release() -> None:
            for rel in paths:
                scanner.unmark_active(rel)

        threading.Timer(5.0, _release).start()


def enqueue_download(job_id: int) -> None:
    download_queue.enqueue(job_id)


# Serialize create/retry so two clicks cannot insert two active rows.
job_mutate_lock = threading.Lock()

_ACTIVE_JOB_STATUSES = (JobStatus.queued, JobStatus.downloading)


def find_active_job(
    session: Session,
    url: str,
    destination: str,
    quality_preset: str,
) -> Optional[DownloadJob]:
    """Return an already-queued/downloading job for the same URL+dest+preset."""
    return session.exec(
        select(DownloadJob)
        .where(
            DownloadJob.url == url,
            DownloadJob.destination == destination,
            DownloadJob.quality_preset == quality_preset,
            DownloadJob.status.in_(list(_ACTIVE_JOB_STATUSES)),
        )
        .order_by(DownloadJob.id.asc())
    ).first()


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


def start_download(
    job_id: int,
    url: str,
    quality_preset: str,
    title_override: Optional[str] = None,
    channel_override: Optional[str] = None,
) -> None:
    """Legacy entry point — enqueue only."""
    enqueue_download(job_id)


def _run_playlist_import(
    playlist_id: int, entries: list[str], quality_preset: str
) -> None:
    from ..models import PlaylistItem

    total = len(entries)
    with activity.track(
        "playlist_import",
        "Importing playlist",
        reason="Playlist import started",
        engine="yt-dlp",
        detail=f"0/{total} videos",
        total=total,
        done=0,
    ) as handle:
        for index, entry_url in enumerate(entries):
            with Session(engine) as session:
                # Best-effort preview for title/channel/thumbnail on each entry.
                preview: dict = {}
                try:
                    preview = extract_preview(entry_url)
                except Exception:  # noqa: BLE001
                    pass
                job = DownloadJob(
                    url=entry_url,
                    quality_preset=quality_preset,
                    status=JobStatus.queued,
                    title=preview.get("title"),
                    channel=preview.get("channel"),
                    thumbnail_url=preview.get("thumbnail_url"),
                )
                session.add(job)
                session.commit()
                session.refresh(job)
                job_id = job.id

            enqueue_download(job_id)
            handle.update(
                done=index,
                detail=preview.get("title") or f"{index + 1}/{total} videos",
            )

            video_id = None
            while True:
                with Session(engine) as session:
                    job = session.get(DownloadJob, job_id)
                    if job is None:
                        break
                    if job.status in (
                        JobStatus.completed,
                        JobStatus.error,
                        JobStatus.cancelled,
                    ):
                        video_id = job.video_id
                        break
                threading.Event().wait(1.0)

            if video_id is None:
                continue

            with Session(engine) as session:
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
                            position=index,
                        )
                    )
                    session.commit()
            handle.update(done=index + 1, detail=f"{index + 1}/{total} videos")


def start_playlist_import(
    playlist_id: int, entries: list[str], quality_preset: str
) -> None:
    thread = threading.Thread(
        target=_run_playlist_import,
        args=(playlist_id, entries, quality_preset),
        daemon=True,
    )
    thread.start()

# Re-exports for callers that still import preview/extract helpers from downloader.
from .stream_preview import (  # noqa: E402
    PreviewRefreshError,
    build_dash_manifest,
    extract_stream_preview_meta,
    list_preview_subtitles,
    lookup_preview_media,
    resolve_preview_manifest,
    resolve_preview_stream,
    resolve_preview_subtitle,
)

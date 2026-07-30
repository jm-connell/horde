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
from ..models import DownloadJob, JobStatus, Video, VideoStatus
from . import library, scanner
from .metadata import probe_dimensions, probe_duration, probe_is_playable
from .paths import find_video_by_path, to_rel_path
from .ytdlp_common import (
    ERROR_KIND_CANCELLED,
    ERROR_KIND_MEMBERS,
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

# Live progress snapshots keyed by job id, consumed by the SSE endpoint.
progress_store: dict[int, dict[str, Any]] = {}

# Strict capped presets — no unrestricted fallback that can grab a lower tier.
QUALITY_FORMATS = {
    "best": "bv*+ba/b",
    "2160p": "bv*[height<=2160]+ba/b[height<=2160]/b[height<=2160]",
    "1440p": "bv*[height<=1440]+ba/b[height<=1440]/b[height<=1440]",
    "1080p": "bv*[height<=1080]+ba/b[height<=1080]/b[height<=1080]",
    "720p": "bv*[height<=720]+ba/b[height<=720]/b[height<=720]",
    "480p": "bv*[height<=480]+ba/b[height<=480]/b[height<=480]",
    "audio": "ba/b",
}

PRESET_MAX_HEIGHT: dict[str, Optional[int]] = {
    "best": None,
    "2160p": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "audio": None,
}

# Standard tiers offered in the UI when present in source formats.
STANDARD_HEIGHTS = (2160, 1440, 1080, 720, 480)

OUTPUT_TEMPLATE = str(
    DOWNLOADS_DIR / "%(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s].%(ext)s"
)

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


def _format_chain(preset: str) -> list[str]:
    """Build yt-dlp format selectors. Height-capped presets never fall back to unbounded best."""
    primary = QUALITY_FORMATS.get(preset, QUALITY_FORMATS["best"])
    max_h = PRESET_MAX_HEIGHT.get(preset)
    chain = [primary]
    if max_h:
        # Stay within the height cap — do not append unrestricted best/best.
        chain.append(f"best[ext=mp4][height<={max_h}]/best[height<={max_h}]")
    elif preset == "best":
        chain.append("best[ext=mp4]/best")
    elif preset == "audio":
        chain.append("bestaudio/best")
    unique: list[str] = []
    seen: set[str] = set()
    for fmt in chain:
        if fmt not in seen:
            seen.add(fmt)
            unique.append(fmt)
    return unique


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
        from . import channel_catalog

        channel_catalog.purge_members_only_by_yt_id(yt_id)
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


def _make_progress_hook(job_id: int, cancel_event: threading.Event):
    accumulated_bytes = 0
    last_stream_downloaded = 0
    max_displayed_bytes = 0
    max_percent = 0.0

    def hook(d: dict[str, Any]) -> None:
        nonlocal accumulated_bytes, last_stream_downloaded
        nonlocal max_displayed_bytes, max_percent
        if cancel_event.is_set():
            raise DownloadCancelled()
        if not isinstance(d, dict):
            return
        try:
            status = d.get("status")
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                downloaded = d.get("downloaded_bytes", 0) or 0
                # yt-dlp resets byte counters per stream (video then audio).
                if downloaded < last_stream_downloaded - 512 * 1024:
                    accumulated_bytes += last_stream_downloaded
                    last_stream_downloaded = 0
                last_stream_downloaded = max(last_stream_downloaded, downloaded)
                combined = accumulated_bytes + last_stream_downloaded
                max_displayed_bytes = max(max_displayed_bytes, combined)
                # Per-stream totals make combined/total exceed 100% across
                # video+audio; clamp so the UI never shows 800%+.
                percent = min(100.0, (combined / total * 100) if total else 0.0)
                max_percent = min(100.0, max(max_percent, percent))
                info = _as_info(d.get("info_dict"))
                progress_store[job_id] = {
                    "status": "downloading",
                    "progress": round(max_percent, 1),
                    "title": info.get("title"),
                    "channel": info.get("uploader") or info.get("channel"),
                    "total_bytes": total,
                    "downloaded_bytes": max_displayed_bytes,
                }
            elif status == "finished":
                info = _as_info(d.get("info_dict"))
                size = (
                    info.get("filesize")
                    or info.get("filesize_approx")
                    or last_stream_downloaded
                )
                if size:
                    accumulated_bytes += int(size)
                last_stream_downloaded = 0
                progress_store[job_id] = {
                    "status": "processing",
                    "progress": min(100.0, max(max_percent, 99.0)),
                }
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
    tiers = [480, 720, 1080, 1440, 2160]
    cap_idx = next((i for i, t in enumerate(tiers) if t >= max_h), len(tiers) - 1)
    actual_idx = next(
        (i for i, t in enumerate(tiers) if t >= height), len(tiers) - 1
    )
    if actual_idx < cap_idx:
        return (
            f"Requested {preset} but file is {height}p — "
            "source may not offer higher quality."
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
        str(tmp),
    ]
    try:
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

            enqueue_sprite_generation(video_id)
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=run, daemon=True).start()


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
) -> int:
    if cancel_event is not None and cancel_event.is_set():
        raise DownloadCancelled()

    info = _as_info(info)
    source_url = info.get("webpage_url") or url

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

        video.title = effective_title or info.get("title") or final_path.stem
        video.channel = effective_channel or info.get("uploader") or info.get("channel")
        video.channel_url = info.get("uploader_url") or info.get("channel_url")
        video.description = info.get("description")
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

    snapshot: dict[str, Any] = {
        "status": "completed",
        "progress": 100.0,
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

    _update_job(
        job_id,
        status=JobStatus.downloading,
        paused=False,
        error=None,
        error_kind=None,
    )
    progress_store[job_id] = {"status": "downloading", "progress": 0.0}

    active_paths: set[str] = set()
    info: dict[str, Any] = {}
    metadata_info: dict[str, Any] = {}
    prepared: Optional[Path] = None
    final_path: Optional[Path] = None
    last_exc: Optional[Exception] = None
    ytdlp_logger = _YtdlpLogger()

    base_ydl_opts: dict[str, Any] = apply_cookie_opts(
        {
            "outtmpl": OUTPUT_TEMPLATE,
            "progress_hooks": [_make_progress_hook(job_id, cancel)],
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "logger": ytdlp_logger,
            "merge_output_format": "mp4",
            "ignoreerrors": True,
            "overwrites": True,
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

        return _complete_download(
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
        )

    except DownloadCancelled:
        _cleanup_partial_files(active_paths)
        with Session(engine) as session:
            job = session.get(DownloadJob, job_id)
            if job is None:
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
                }
            else:
                job.status = JobStatus.cancelled
                job.error = "Cancelled"
                job.error_kind = ERROR_KIND_CANCELLED
                job.progress = 0.0
                progress_store[job_id] = {
                    "status": "cancelled",
                    "error": "Cancelled",
                    "error_kind": ERROR_KIND_CANCELLED,
                }
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
                return _complete_download(
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
                )
            except Exception:  # noqa: BLE001
                pass

        _cleanup_partial_files(active_paths)
        prev = progress_store.get(job_id, {})
        kind, message = classify_ytdlp_error(exc)
        if kind == ERROR_KIND_MEMBERS or is_members_only_error(exc):
            kind = ERROR_KIND_MEMBERS
            message = "Members-only video — skipped"
            _purge_members_only_url(url)
        record_extract_failure(kind, message)
        _update_job(
            job_id, status=JobStatus.error, error=message, error_kind=kind
        )
        progress_store[job_id] = {
            "status": "error",
            "error": message,
            "error_kind": kind,
            "title": prev.get("title"),
            "channel": prev.get("channel"),
        }
        return None
    finally:
        # Keep paths marked briefly so the filesystem watcher does not race
        # the DB commit and try to ingest the file as a duplicate review item.
        paths = list(active_paths)

        def _release() -> None:
            for rel in paths:
                scanner.unmark_active(rel)

        threading.Timer(5.0, _release).start()


def enqueue_download(job_id: int) -> None:
    download_queue.enqueue(job_id)


def start_download(
    job_id: int,
    url: str,
    quality_preset: str,
    title_override: Optional[str] = None,
    channel_override: Optional[str] = None,
) -> None:
    """Legacy entry point — enqueue only."""
    enqueue_download(job_id)


def _video_heights(info: dict[str, Any]) -> set[int]:
    heights: set[int] = set()
    for fmt in info.get("formats") or []:
        height = fmt.get("height")
        if height and fmt.get("vcodec") not in (None, "none"):
            heights.add(int(height))
    return heights


def _has_audio(info: dict[str, Any]) -> bool:
    for fmt in info.get("formats") or []:
        if fmt.get("acodec") not in (None, "none"):
            return True
    return False


def _height_to_tier(height: int) -> int:
    """Map an actual pixel height to the nearest standard quality tier."""
    best = STANDARD_HEIGHTS[-1]
    best_dist = abs(height - best)
    for tier in STANDARD_HEIGHTS:
        dist = abs(height - tier)
        if dist < best_dist or (dist == best_dist and tier > best):
            best = tier
            best_dist = dist
    return best


def _available_presets(info: dict[str, Any]) -> list[str]:
    """Return resolution presets present in source, highest first, then audio."""
    heights = _video_heights(info)
    tiers_present = {_height_to_tier(h) for h in heights}
    presets: list[str] = []
    for tier in STANDARD_HEIGHTS:
        if tier in tiers_present:
            presets.append(f"{tier}p")
    if _has_audio(info):
        presets.append("audio")
    return presets


def _format_byte_size(fmt: dict[str, Any]) -> Optional[int]:
    size = fmt.get("filesize") or fmt.get("filesize_approx")
    return int(size) if size else None


def _estimate_preset_bytes(ydl: Any, info: dict[str, Any], format_spec: str) -> Optional[int]:
    formats = info.get("formats") or []
    if not formats:
        return None
    try:
        selector = ydl.build_format_selector(format_spec)
        selected = list(selector({"formats": formats, "incomplete": False}))
    except Exception:  # noqa: BLE001
        return None
    if not selected:
        return None
    total = 0
    for fmt in selected:
        size = _format_byte_size(fmt)
        if size is None:
            return None
        total += size
    return total


def _estimate_preset_sizes(
    info: dict[str, Any], presets: list[str]
) -> dict[str, int]:
    import yt_dlp

    sizes: dict[str, int] = {}
    opts = apply_cookie_opts({"quiet": True, "no_warnings": True, "skip_download": True})
    with yt_dlp.YoutubeDL(opts) as ydl:
        for preset in presets:
            format_spec = QUALITY_FORMATS.get(preset)
            if not format_spec:
                continue
            try:
                size = _estimate_preset_bytes(ydl, info, format_spec)
            except Exception:  # noqa: BLE001
                size = None
            if size:
                sizes[preset] = size
    return sizes


def extract_preview(url: str) -> dict[str, Any]:
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": "in_playlist",
            "logger": QuietYtdlpLogger(),
            "extractor_args": youtube_extractor_args(),
        }
    )
    try:
        info = _as_info(extract_info_gated(url, opts, cache_key=f"preview:{url}"))
    except Exception as exc:  # noqa: BLE001
        if is_members_only_error(exc):
            _purge_members_only_url(url)
            raise MembersOnlyError("Members-only video — skipped") from exc
        raise
    if is_members_only_entry(info):
        yt_id = info.get("id")
        if yt_id:
            _purge_members_only_yt_id(str(yt_id))
        else:
            _purge_members_only_url(url)
        raise MembersOnlyError("Members-only video — skipped")

    if info.get("_type") == "playlist" or info.get("entries") is not None:
        entries = [e for e in (info.get("entries") or []) if e]
        return {
            "is_playlist": True,
            "title": info.get("title"),
            "channel": info.get("uploader") or info.get("channel"),
            "channel_url": info.get("uploader_url") or info.get("channel_url"),
            "thumbnail_url": _best_thumbnail_url(info),
            "entry_count": len(entries),
            "available_presets": [],
            "preset_sizes": {},
        }

    available = _available_presets(info)
    view_count = info.get("view_count")
    if view_count is not None:
        try:
            view_count = int(view_count)
        except (TypeError, ValueError):
            view_count = None
    from .feed_meta_cache import parse_upload_date

    published_at = parse_upload_date(
        info.get("upload_date")
        or info.get("release_timestamp")
        or info.get("timestamp")
    )
    return {
        "is_playlist": False,
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url"),
        "thumbnail_url": _best_thumbnail_url(info),
        "entry_count": None,
        "view_count": view_count,
        "published_at": published_at,
        "available_presets": available,
        "preset_sizes": _estimate_preset_sizes(info, available),
    }


def extract_playlist_entries(url: str) -> dict[str, Any]:
    """Fast flat extraction of playlist metadata and entry list."""
    import yt_dlp

    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": "in_playlist",
            "skip_download": True,
            "extractor_args": youtube_extractor_args(),
        }
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = _as_info(ydl.extract_info(url, download=False))

    entries: list[dict[str, Any]] = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        if is_members_only_entry(entry):
            continue
        entry_url = entry.get("url") or entry.get("webpage_url")
        vid = entry.get("id")
        if entry_url and not str(entry_url).startswith("http"):
            entry_url = None
        if not entry_url and vid:
            entry_url = f"https://www.youtube.com/watch?v={vid}"
        if not entry_url:
            continue
        view_count = entry.get("view_count")
        if view_count is not None:
            try:
                view_count = int(view_count)
            except (TypeError, ValueError):
                view_count = None
        entries.append(
            {
                "id": vid,
                "url": entry_url,
                "title": entry.get("title"),
                "channel": entry.get("uploader") or entry.get("channel"),
                "duration": entry.get("duration"),
                "thumbnail_url": _entry_thumbnail_url(entry, vid),
                "view_count": view_count,
            }
        )

    return {
        "title": info.get("title") or "Imported playlist",
        "channel": info.get("uploader") or info.get("channel"),
        "entries": entries,
    }


_FEED_CACHE_TTL_SEC = 300
_feed_cache: dict[tuple[str, int, int, int], tuple[float, dict[str, Any]]] = {}
_feed_cache_lock = threading.Lock()


def _best_thumbnail_url(
    info: dict[str, Any], vid: Optional[str] = None
) -> Optional[str]:
    """Pick the highest-res thumbnail from yt-dlp info, or a YouTube CDN URL."""
    thumbs = info.get("thumbnails")
    best_url: Optional[str] = None
    best_area = -1
    if isinstance(thumbs, list):
        for item in thumbs:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not url:
                continue
            w = item.get("width") or 0
            h = item.get("height") or 0
            try:
                area = int(w) * int(h)
            except (TypeError, ValueError):
                area = 0
            if area >= best_area:
                best_area = area
                best_url = str(url).strip()
    if best_url:
        if best_url.startswith("//"):
            return f"https:{best_url}"
        return best_url
    thumb = info.get("thumbnail")
    if thumb:
        s = str(thumb).strip()
        if s.startswith("//"):
            return f"https:{s}"
        if s.startswith("http"):
            return s
    video_id = vid or info.get("id")
    if isinstance(video_id, str) and video_id:
        # hqdefault is reliably available; maxresdefault 404s for some videos.
        return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return None


def _entry_thumbnail_url(entry: dict[str, Any], vid: Optional[str]) -> Optional[str]:
    """Resolve a thumbnail URL from flat extract data or YouTube video id."""
    return _best_thumbnail_url(entry, vid)


def _playlist_count(info: dict[str, Any]) -> Optional[int]:
    raw = info.get("playlist_count") or info.get("n_entries")
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _channel_videos_url(channel_url: str) -> str:
    url = channel_url.strip().rstrip("/")
    if url.endswith("/videos"):
        return url
    for suffix in ("/shorts", "/streams", "/playlists", "/featured", "/about"):
        if url.endswith(suffix):
            return url[: -len(suffix)] + "/videos"
    return f"{url}/videos"


def fetch_channel_feed(
    channel_url: str, offset: int = 0, limit: int = 30
) -> dict[str, Any]:
    """Fetch a page of uploads from a YouTube channel tab."""
    import yt_dlp

    offset = max(0, offset)
    limit = max(1, min(limit, 100))
    feed_url = _channel_videos_url(channel_url)
    cache_key = (feed_url, offset, limit, 3)
    now = time.time()
    with _feed_cache_lock:
        cached = _feed_cache.get(cache_key)
        if cached and now - cached[0] < _FEED_CACHE_TTL_SEC:
            return cached[1]

    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": "in_playlist",
            "skip_download": True,
            "playliststart": offset + 1,
            "playlistend": offset + limit,
            "extractor_args": youtube_extractor_args(),
        }
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = _as_info(ydl.extract_info(feed_url, download=False))

    entries: list[dict[str, Any]] = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        if is_members_only_entry(entry):
            continue
        entry_url = entry.get("url") or entry.get("webpage_url")
        vid = entry.get("id")
        if entry_url and not str(entry_url).startswith("http"):
            entry_url = None
        if not entry_url and vid:
            entry_url = f"https://www.youtube.com/watch?v={vid}"
        if not entry_url:
            continue
        view_count = entry.get("view_count")
        if view_count is not None:
            try:
                view_count = int(view_count)
            except (TypeError, ValueError):
                view_count = None
        from .feed_meta_cache import parse_upload_date

        published_at = parse_upload_date(
            entry.get("upload_date") or entry.get("release_timestamp") or entry.get("timestamp")
        )
        availability = entry.get("availability")
        entries.append(
            {
                "id": vid,
                "url": entry_url,
                "title": entry.get("title"),
                "duration": entry.get("duration"),
                "thumbnail_url": _entry_thumbnail_url(entry, vid),
                "view_count": view_count,
                "published_at": published_at,
                "availability": availability,
            }
        )

    result = {
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url") or channel_url,
        "entries": entries,
        "has_more": len(entries) == limit,
        "playlist_count": _playlist_count(info),
    }
    with _feed_cache_lock:
        _feed_cache[cache_key] = (now, result)
    return result


def estimate_playlist_sizes(
    urls: list[str], max_entries: int = 100
) -> dict[str, dict[str, int]]:
    """Best-effort per-URL preset size estimates (may be partial)."""
    sizes: dict[str, dict[str, int]] = {}
    for url in urls[:max_entries]:
        try:
            preview = extract_preview(url)
            if preview.get("preset_sizes"):
                sizes[url] = preview["preset_sizes"]
        except Exception:  # noqa: BLE001
            continue
    return sizes


def extract_playlist(url: str) -> tuple[str, list[str]]:
    import yt_dlp

    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": "in_playlist",
            "skip_download": True,
            "extractor_args": youtube_extractor_args(),
        }
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = _as_info(ydl.extract_info(url, download=False))

    title = info.get("title") or "Imported playlist"
    entries = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        entry_url = entry.get("url") or entry.get("webpage_url")
        vid = entry.get("id")
        if entry_url and entry_url.startswith("http"):
            entries.append(entry_url)
        elif vid:
            entries.append(f"https://www.youtube.com/watch?v={vid}")
    return title, entries


def _run_playlist_import(
    playlist_id: int, entries: list[str], quality_preset: str
) -> None:
    from ..models import PlaylistItem

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


def start_playlist_import(
    playlist_id: int, entries: list[str], quality_preset: str
) -> None:
    thread = threading.Thread(
        target=_run_playlist_import,
        args=(playlist_id, entries, quality_preset),
        daemon=True,
    )
    thread.start()


def search_youtube_channels(query: str, *, limit: int = 8) -> list[dict[str, Any]]:
    """Search YouTube for channels matching query (yt-dlp flat extract)."""
    import urllib.parse

    import yt_dlp

    q = (query or "").strip()
    if not q:
        return []
    limit = max(1, min(limit, 20))
    # sp=EgIQAg%253D%253D filters YouTube results to Channels.
    search_url = (
        "https://www.youtube.com/results?search_query="
        + urllib.parse.quote(q)
        + "&sp=EgIQAg%253D%253D"
    )
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": "in_playlist",
            "skip_download": True,
            "playlistend": limit,
            "extractor_args": youtube_extractor_args(),
        }
    )
    results: list[dict[str, Any]] = []
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = _as_info(ydl.extract_info(search_url, download=False))
    except Exception:  # noqa: BLE001
        return []

    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url") or entry.get("webpage_url") or entry.get("channel_url")
        if not url:
            channel_id = entry.get("channel_id") or entry.get("id")
            if channel_id and str(channel_id).startswith("UC"):
                url = f"https://www.youtube.com/channel/{channel_id}"
        if not url or not str(url).startswith("http"):
            continue
        name = (
            entry.get("channel")
            or entry.get("uploader")
            or entry.get("title")
            or entry.get("id")
        )
        if not name:
            continue
        results.append(
            {
                "name": str(name),
                "url": str(url).split("/videos")[0].rstrip("/"),
                "thumbnail_url": entry.get("thumbnail")
                or (entry.get("thumbnails") or [{}])[-1].get("url"),
                "subscriber_count": entry.get("channel_follower_count")
                or entry.get("subscriber_count"),
            }
        )
        if len(results) >= limit:
            break
    return results


# --- In-app stream preview (progressive + adaptive DASH) ---

_PREVIEW_CACHE_TTL_SEC = 240
_PREVIEW_MANIFEST_TTL_SEC = 5 * 3600 + 1800  # ~5.5h; CDN URLs last ~6h
_PREVIEW_MAX_HEIGHT = 720
_PREVIEW_PROBE_SIZES = (256 * 1024, 1024 * 1024, 4 * 1024 * 1024)
_PREVIEW_REFRESH_DEBOUNCE_SEC = 10.0
_PREVIEW_REFRESH_PROACTIVE_SEC = 5 * 60
_PREVIEW_REFRESH_MAX_ATTEMPTS = 3
_preview_stream_cache: dict[str, dict[str, Any]] = {}
_preview_manifest_by_url: dict[str, dict[str, Any]] = {}
_preview_manifest_by_token: dict[str, dict[str, Any]] = {}
_preview_stream_lock = threading.Lock()
_preview_extract_sem = threading.Semaphore(2)
_preview_refresh_inflight: dict[str, threading.Event] = {}
_preview_refresh_last_at: dict[str, float] = {}
_preview_refresh_attempts: dict[str, int] = {}


class PreviewRefreshError(RuntimeError):
    """CDN URL refresh failed; clients should back off."""

    def __init__(self, message: str, *, retry_after: int = 15):
        super().__init__(message)
        self.retry_after = retry_after


def _pick_progressive_format(info: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Best muxed progressive format at or below preview height cap."""
    formats = info.get("formats") or []
    candidates: list[tuple[int, dict[str, Any]]] = []
    for fmt in formats:
        if not isinstance(fmt, dict):
            continue
        if not fmt.get("url"):
            continue
        vcodec = str(fmt.get("vcodec") or "none")
        acodec = str(fmt.get("acodec") or "none")
        if vcodec == "none" or acodec == "none":
            continue
        height = int(fmt.get("height") or 0)
        if height > _PREVIEW_MAX_HEIGHT:
            continue
        ext = str(fmt.get("ext") or "")
        # Prefer mp4, then higher height, then higher tbr.
        score = height * 10
        if ext == "mp4":
            score += 100_000
        elif ext in ("webm", "mkv"):
            score += 50_000
        tbr = fmt.get("tbr") or 0
        try:
            score += int(float(tbr))
        except (TypeError, ValueError):
            pass
        candidates.append((score, fmt))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _is_mp4_video_codec(vcodec: str) -> bool:
    v = vcodec.lower()
    return v.startswith("avc1") or v.startswith("av01") or v.startswith("avc")


def _is_mp4_audio_codec(acodec: str) -> bool:
    a = acodec.lower()
    return a.startswith("mp4a") or a in ("aac", "mp4a.40.2", "mp4a.40.5")


def _video_codec_family(vcodec: str) -> Optional[str]:
    v = vcodec.lower()
    if v.startswith("av01"):
        return "av01"
    if v.startswith("avc1") or v.startswith("avc"):
        return "avc1"
    return None


def _pick_adaptive_formats(
    info: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Select MP4 adaptive video (H.264/AV1) + AAC audio for DASH preview.

    Video formats are kept per (codec family, height) so each AdaptationSet
    stays codec-homogeneous. Audio prefers non-DRC, original-language AAC.
    """
    formats = info.get("formats") or []
    # (family, height) -> best format
    video_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    audio_candidates: list[tuple[int, dict[str, Any]]] = []
    original_lang = str(
        info.get("language") or info.get("original_language") or ""
    ).lower()

    for fmt in formats:
        if not isinstance(fmt, dict) or not fmt.get("url"):
            continue
        ext = str(fmt.get("ext") or "").lower()
        if ext not in ("mp4", "m4a"):
            continue
        # Skip storyboard / image formats.
        if str(fmt.get("format_note") or "").lower().startswith("storyboard"):
            continue
        if fmt.get("protocol") in ("mhtml", "m3u8", "m3u8_native", "http_dash_segments"):
            continue
        # SegmentBase DASH needs a single-file URL with sidx, not a fragment list.
        if fmt.get("fragments"):
            continue

        vcodec = str(fmt.get("vcodec") or "none")
        acodec = str(fmt.get("acodec") or "none")
        height = int(fmt.get("height") or 0)

        # Video-only adaptive (no audio track).
        if vcodec != "none" and acodec == "none" and height > 0:
            family = _video_codec_family(vcodec)
            if family is None:
                continue
            score = height * 1000
            tbr = fmt.get("tbr") or fmt.get("vbr") or 0
            try:
                score += int(float(tbr))
            except (TypeError, ValueError):
                pass
            key = (family, height)
            prev = video_by_key.get(key)
            if prev is None or score > int(prev.get("_score") or 0):
                entry = dict(fmt)
                entry["_score"] = score
                entry["_codec_family"] = family
                video_by_key[key] = entry
            continue

        # Audio-only adaptive.
        if vcodec == "none" and acodec != "none":
            if not _is_mp4_audio_codec(acodec):
                continue
            score = 0
            abr = fmt.get("abr") or fmt.get("tbr") or 0
            try:
                score += int(float(abr))
            except (TypeError, ValueError):
                pass
            # Prefer higher sample rate / channels as a tie-break.
            try:
                score += int(fmt.get("asr") or 0) // 100
            except (TypeError, ValueError):
                pass
            format_id = str(fmt.get("format_id") or "")
            # Prefer non-DRC variants (YouTube exposes "-drc" format IDs).
            if "-drc" in format_id.lower() or "drc" in str(
                fmt.get("format_note") or ""
            ).lower():
                score -= 50_000
            lang = str(fmt.get("language") or fmt.get("lang") or "").lower()
            if original_lang and lang == original_lang:
                score += 20_000
            elif lang in ("", "und", "en") and not original_lang:
                score += 5_000
            elif lang and original_lang and lang != original_lang:
                score -= 10_000
            audio_candidates.append((score, fmt))

    videos = sorted(
        video_by_key.values(),
        key=lambda f: (
            0 if f.get("_codec_family") == "av01" else 1,
            -int(f.get("height") or 0),
        ),
    )
    for v in videos:
        v.pop("_score", None)

    audios: list[dict[str, Any]] = []
    if audio_candidates:
        audio_candidates.sort(key=lambda item: item[0], reverse=True)
        audios.append(audio_candidates[0][1])

    return videos, audios


def _format_http_headers(fmt: dict[str, Any], info: dict[str, Any]) -> dict[str, str]:
    headers = dict(fmt.get("http_headers") or {})
    cookie = fmt.get("cookies") or info.get("cookies")
    if cookie and "Cookie" not in headers:
        headers["Cookie"] = cookie
    return {str(k): str(v) for k, v in headers.items()}


def _walk_mp4_boxes(
    data: bytes, start: int = 0, end: Optional[int] = None
) -> list[tuple[int, bytes, int]]:
    """Return top-level (offset, type, size) boxes in [start, end)."""
    if end is None:
        end = len(data)
    boxes: list[tuple[int, bytes, int]] = []
    pos = start
    while pos + 8 <= end:
        size = int.from_bytes(data[pos : pos + 4], "big")
        typ = data[pos + 4 : pos + 8]
        header = 8
        if size == 1:
            if pos + 16 > end:
                break
            size = int.from_bytes(data[pos + 8 : pos + 16], "big")
            header = 16
        elif size == 0:
            size = end - pos
        if size < header:
            break
        if pos + size > end:
            # Incomplete box in buffer — still record start for sidx detection.
            boxes.append((pos, typ, size))
            break
        boxes.append((pos, typ, size))
        pos += size
    return boxes


def _find_sidx_range(data: bytes) -> Optional[tuple[int, int]]:
    """Locate the first complete top-level sidx box; return (start, end_inclusive)."""
    for offset, typ, size in _walk_mp4_boxes(data):
        if typ == b"sidx":
            end = offset + size - 1
            if end < len(data):
                return offset, end
            return None
    return None


def _parse_sidx(data: bytes, offset: int) -> dict[str, Any]:
    """Parse an ISO-BMFF sidx box at absolute byte offset.

    Returns timescale, earliest_presentation_time, first_offset, duration_sec,
    and cumulative subsegment boundary times (seconds).
    """
    if offset + 12 > len(data):
        raise RuntimeError("sidx box truncated")
    size = int.from_bytes(data[offset : offset + 4], "big")
    typ = data[offset + 4 : offset + 8]
    if typ != b"sidx":
        raise RuntimeError("Not a sidx box")
    header = 8
    if size == 1:
        if offset + 16 > len(data):
            raise RuntimeError("sidx largesize truncated")
        size = int.from_bytes(data[offset + 8 : offset + 16], "big")
        header = 16
    elif size == 0:
        size = len(data) - offset
    box_end = offset + size
    if box_end > len(data):
        raise RuntimeError("sidx box incomplete in buffer")

    body = offset + header
    version = data[body]
    # skip flags (3 bytes)
    pos = body + 4
    # reference_ID
    pos += 4
    timescale = int.from_bytes(data[pos : pos + 4], "big")
    pos += 4
    if version == 0:
        ept = int.from_bytes(data[pos : pos + 4], "big")
        pos += 4
        first_offset = int.from_bytes(data[pos : pos + 4], "big")
        pos += 4
    else:
        ept = int.from_bytes(data[pos : pos + 8], "big")
        pos += 8
        first_offset = int.from_bytes(data[pos : pos + 8], "big")
        pos += 8
    # reserved (2) + reference_count (2)
    pos += 2
    ref_count = int.from_bytes(data[pos : pos + 2], "big")
    pos += 2

    total_duration = 0
    boundaries: list[float] = [0.0]
    for _ in range(ref_count):
        if pos + 12 > box_end:
            break
        # referenced_size in low 31 bits of first uint32; bit 31 = reference_type
        pos += 4
        subseg_dur = int.from_bytes(data[pos : pos + 4], "big")
        pos += 4
        # starts_with_SAP / SAP_type / SAP_delta_time
        pos += 4
        total_duration += subseg_dur
        if timescale > 0:
            boundaries.append(total_duration / timescale)

    duration_sec = (total_duration / timescale) if timescale > 0 else 0.0
    return {
        "timescale": timescale,
        "earliest_presentation_time": ept,
        "first_offset": first_offset,
        "duration_sec": duration_sec,
        "boundaries": boundaries,
    }


def _probe_mp4_ranges(
    direct_url: str, headers: dict[str, str]
) -> tuple[str, str, dict[str, Any]]:
    """Probe ISO-BMFF to compute initRange, indexRange, and parsed sidx.

    Returns (init_range, index_range, sidx_info).
    """
    req_headers = dict(headers)
    last_err: Optional[Exception] = None
    for nbytes in _PREVIEW_PROBE_SIZES:
        req_headers["Range"] = f"bytes=0-{nbytes - 1}"
        try:
            with httpx.Client(
                timeout=httpx.Timeout(20.0, read=60.0),
                follow_redirects=True,
            ) as client:
                resp = client.get(direct_url, headers=req_headers)
            if resp.status_code not in (200, 206):
                raise RuntimeError(
                    f"Probe failed with status {resp.status_code}"
                )
            data = resp.content
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue

        sidx = _find_sidx_range(data)
        if sidx is None:
            # Need a larger window, or no sidx present.
            if len(data) < nbytes:
                break
            continue

        sidx_start, sidx_end = sidx
        if sidx_start <= 0:
            raise RuntimeError("Invalid sidx offset in MP4 probe")
        init_range = f"0-{sidx_start - 1}"
        index_range = f"{sidx_start}-{sidx_end}"
        parsed = _parse_sidx(data, sidx_start)
        return init_range, index_range, parsed

    if last_err is not None:
        raise RuntimeError(f"MP4 range probe failed: {last_err}") from last_err
    raise RuntimeError("MP4 stream has no sidx index (cannot build DASH)")


def _bandwidth_bps(fmt: dict[str, Any], *, kind: str) -> int:
    """Approximate peak bitrate for DASH @bandwidth (yt-dlp tbr is average)."""
    avg = 0
    for key in ("tbr", "vbr", "abr"):
        val = fmt.get(key)
        if val is None:
            continue
        try:
            # yt-dlp tbr is kbps.
            avg = max(1, int(float(val) * 1000))
            break
        except (TypeError, ValueError):
            continue
    if avg <= 0:
        filesize = fmt.get("filesize") or fmt.get("filesize_approx")
        duration = fmt.get("duration")  # rarely on format
        if filesize and duration:
            try:
                avg = max(1, int(int(filesize) * 8 / float(duration)))
            except (TypeError, ValueError, ZeroDivisionError):
                pass
    if avg <= 0:
        avg = 1_000_000 if kind == "video" else 128_000
    pad = 1.4 if kind == "video" else 1.1
    return max(1, int(avg * pad))


def _codecs_string(fmt: dict[str, Any], *, kind: str) -> str:
    if kind == "video":
        return str(fmt.get("vcodec") or "avc1.4D401F")
    return str(fmt.get("acodec") or "mp4a.40.2")


def _build_representation(
    fmt: dict[str, Any],
    info: dict[str, Any],
    *,
    kind: str,
) -> dict[str, Any]:
    direct = str(fmt.get("url") or "")
    if not direct:
        raise RuntimeError("Adaptive format has no URL")
    headers = _format_http_headers(fmt, info)
    init_range, index_range, sidx = _probe_mp4_ranges(direct, headers)
    itag = str(fmt.get("format_id") or fmt.get("format") or "")
    if not itag:
        raise RuntimeError("Adaptive format missing format_id")

    mime = "video/mp4" if kind == "video" else "audio/mp4"
    codecs = _codecs_string(fmt, kind=kind)
    family = (
        fmt.get("_codec_family")
        or _video_codec_family(codecs)
        or "unknown"
    )
    rep: dict[str, Any] = {
        "itag": itag,
        "kind": kind,
        "direct_url": direct,
        "http_headers": headers,
        "content_type": mime,
        "mime_type": mime,
        "codecs": codecs,
        "codec_family": family if kind == "video" else "audio",
        "bandwidth": _bandwidth_bps(fmt, kind=kind),
        "init_range": init_range,
        "index_range": index_range,
        "timescale": int(sidx["timescale"]),
        "earliest_presentation_time": int(sidx["earliest_presentation_time"]),
        "duration_sec": float(sidx["duration_sec"]),
        "boundaries": list(sidx["boundaries"]),
    }
    if kind == "video":
        rep["width"] = int(fmt.get("width") or 0) or None
        rep["height"] = int(fmt.get("height") or 0) or None
        fps = fmt.get("fps")
        try:
            rep["fps"] = int(float(fps)) if fps is not None else None
        except (TypeError, ValueError):
            rep["fps"] = None
    else:
        channels = fmt.get("audio_channels") or 2
        try:
            rep["audio_channels"] = int(channels)
        except (TypeError, ValueError):
            rep["audio_channels"] = 2
        asr = fmt.get("asr")
        try:
            rep["audio_sampling_rate"] = int(asr) if asr else None
        except (TypeError, ValueError):
            rep["audio_sampling_rate"] = None
        lang = fmt.get("language") or fmt.get("lang") or info.get("language")
        rep["lang"] = str(lang) if lang else "und"
    return rep


def _extract_preview_info(url: str, *, force: bool = False) -> dict[str, Any]:
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "logger": QuietYtdlpLogger(),
            "extractor_args": youtube_extractor_args(),
        }
    )
    # Share cache with download-preview when possible (same URL, full extract).
    try:
        info = _as_info(
            extract_info_gated(
                url, opts, cache_key=f"stream:{url}", force=force
            )
        )
    except Exception as exc:  # noqa: BLE001
        if is_members_only_error(exc):
            _purge_members_only_url(url)
            raise MembersOnlyError("Members-only video — skipped") from exc
        raise
    if is_members_only_entry(info):
        yt_id = info.get("id")
        if yt_id:
            _purge_members_only_yt_id(str(yt_id))
        else:
            _purge_members_only_url(url)
        raise MembersOnlyError("Members-only video — skipped")
    if info.get("_type") == "playlist" or (
        info.get("entries") is not None and not info.get("formats")
    ):
        raise ValueError("Playlists cannot be preview-streamed")
    return info


def _subtitle_entry_vtt_url(entries: list[Any]) -> Optional[str]:
    """Pick a VTT URL from a yt-dlp subtitle format list for one language."""
    import urllib.parse

    if not isinstance(entries, list):
        return None
    chosen: Optional[dict[str, Any]] = None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not url:
            continue
        if str(entry.get("ext") or "").lower() == "vtt":
            return str(url)
        if chosen is None:
            chosen = entry
    if chosen is None:
        return None
    url = str(chosen["url"])
    if str(chosen.get("ext") or "").lower() == "vtt":
        return url
    # YouTube timedtext honors fmt=vtt even when yt-dlp listed json3/srv3/etc.
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    query["fmt"] = ["vtt"]
    return urllib.parse.urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path,
            urllib.parse.urlencode(query, doseq=True),
            parts.fragment,
        )
    )


def _collect_preview_subtitles(info: dict[str, Any]) -> list[dict[str, Any]]:
    """English caption tracks from yt-dlp info; manual wins over auto."""
    by_lang: dict[str, dict[str, Any]] = {}
    for source_key, is_auto in (("subtitles", False), ("automatic_captions", True)):
        bucket = info.get(source_key) or {}
        if not isinstance(bucket, dict):
            continue
        for raw_lang, entries in bucket.items():
            lang = _normalize_lang(str(raw_lang or ""))
            if lang != "en":
                continue
            # Manual is walked first; skip once a lang is claimed.
            if lang in by_lang:
                continue
            url = _subtitle_entry_vtt_url(entries)
            if not url:
                continue
            by_lang[lang] = {"lang": lang, "auto": is_auto, "url": url}
    return list(by_lang.values())


def list_preview_subtitles(url: str, *, force: bool = False) -> list[dict[str, Any]]:
    """Return [{lang, auto}] for English captions available on a stream URL."""
    info = _extract_preview_info(url, force=force)
    return [
        {"lang": t["lang"], "auto": t["auto"]}
        for t in _collect_preview_subtitles(info)
    ]


def resolve_preview_subtitle(
    url: str, lang: str, *, force: bool = False
) -> dict[str, Any]:
    """Resolve a proxied caption track: {direct_url, http_headers, lang, auto}."""
    wanted = _normalize_lang(lang)
    info = _extract_preview_info(url, force=force)
    track = next(
        (t for t in _collect_preview_subtitles(info) if t["lang"] == wanted),
        None,
    )
    if track is None:
        raise KeyError(f"No subtitle track for language {lang!r}")
    headers = dict(info.get("http_headers") or {})
    return {
        "direct_url": track["url"],
        "http_headers": {str(k): str(v) for k, v in headers.items()},
        "lang": track["lang"],
        "auto": track["auto"],
    }


def _max_adaptive_height(info: dict[str, Any]) -> Optional[int]:
    videos, _ = _pick_adaptive_formats(info)
    if not videos:
        return None
    heights = [int(v.get("height") or 0) for v in videos if v.get("height")]
    return max(heights) if heights else None


def _boundaries_aligned(
    reps: list[dict[str, Any]], *, tolerance_sec: float = 1.0 / 30.0
) -> bool:
    """True when all representations share subsegment boundaries within tol."""
    if len(reps) < 2:
        return True
    ref = reps[0].get("boundaries") or []
    if len(ref) < 2:
        return False
    for other in reps[1:]:
        bounds = other.get("boundaries") or []
        if len(bounds) != len(ref):
            return False
        for a, b in zip(ref, bounds):
            if abs(float(a) - float(b)) > tolerance_sec:
                return False
    return True


def _segment_base_xml(rep: dict[str, Any]) -> list[str]:
    init_r = xml_escape(str(rep["init_range"]))
    index_r = xml_escape(str(rep["index_range"]))
    attrs = [f'indexRange="{index_r}"', 'indexRangeExact="true"']
    timescale = int(rep.get("timescale") or 0)
    ept = int(rep.get("earliest_presentation_time") or 0)
    if timescale > 0 and ept > 0:
        attrs.append(f'timescale="{timescale}"')
        attrs.append(f'presentationTimeOffset="{ept}"')
    return [
        f'<SegmentBase {" ".join(attrs)}>',
        f'<Initialization range="{init_r}"/>',
        "</SegmentBase>",
    ]


def extract_stream_preview_meta(url: str) -> dict[str, Any]:
    """Metadata for the in-app preview page (includes description for chapters)."""
    info = _extract_preview_info(url)
    preview_height = _max_adaptive_height(info)
    if preview_height is None:
        fmt = _pick_progressive_format(info)
        preview_height = int(fmt["height"]) if fmt and fmt.get("height") else None
    view_count = info.get("view_count")
    if view_count is not None:
        try:
            view_count = int(view_count)
        except (TypeError, ValueError):
            view_count = None
    duration = info.get("duration")
    if duration is not None:
        try:
            duration = float(duration)
        except (TypeError, ValueError):
            duration = None
    source = (
        info.get("webpage_url")
        or info.get("original_url")
        or url
    )
    subtitles = [
        {"lang": t["lang"], "auto": t["auto"]}
        for t in _collect_preview_subtitles(info)
    ]
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url"),
        "thumbnail_url": _best_thumbnail_url(info, info.get("id")),
        "description": info.get("description"),
        "duration": duration,
        "view_count": view_count,
        "source_url": source,
        "preview_height": preview_height,
        "available_presets": _available_presets(info),
        "subtitles": subtitles,
    }


def resolve_preview_stream(url: str) -> dict[str, Any]:
    """Resolve a short-lived progressive media URL for proxy streaming.

    Returns dict with direct_url, http_headers, height, content_type, expires_at.
    Kept as a fallback for clients that cannot play DASH.
    """
    now = time.time()
    with _preview_stream_lock:
        cached = _preview_stream_cache.get(url)
        if cached and cached.get("expires_at", 0) > now + 15:
            return dict(cached)

    with _preview_extract_sem:
        # Re-check cache after waiting for the semaphore.
        with _preview_stream_lock:
            cached = _preview_stream_cache.get(url)
            if cached and cached.get("expires_at", 0) > now + 15:
                return dict(cached)

        info = _extract_preview_info(url)
        fmt = _pick_progressive_format(info)
        if fmt is None:
            raise RuntimeError(
                "No progressive preview format available for this video"
            )
        direct = fmt.get("url")
        if not direct:
            raise RuntimeError("Preview format has no URL")

        headers = _format_http_headers(fmt, info)
        ext = str(fmt.get("ext") or "mp4")
        content_type = {
            "mp4": "video/mp4",
            "webm": "video/webm",
            "mkv": "video/x-matroska",
        }.get(ext, "video/mp4")

        entry = {
            "direct_url": str(direct),
            "http_headers": headers,
            "height": int(fmt["height"]) if fmt.get("height") else None,
            "content_type": content_type,
            "expires_at": now + _PREVIEW_CACHE_TTL_SEC,
        }
        with _preview_stream_lock:
            _preview_stream_cache[url] = entry
            # Bound cache size.
            if len(_preview_stream_cache) > 64:
                oldest = sorted(
                    _preview_stream_cache.items(),
                    key=lambda item: item[1].get("expires_at", 0),
                )[:16]
                for key, _ in oldest:
                    _preview_stream_cache.pop(key, None)
        return dict(entry)


def _trim_manifest_cache_locked() -> None:
    if len(_preview_manifest_by_url) <= 48:
        return
    oldest = sorted(
        _preview_manifest_by_url.items(),
        key=lambda item: item[1].get("expires_at", 0),
    )[:16]
    for key, entry in oldest:
        _preview_manifest_by_url.pop(key, None)
        token = entry.get("token")
        if token:
            _preview_manifest_by_token.pop(str(token), None)


def _store_manifest_entry(url: str, entry: dict[str, Any]) -> None:
    with _preview_stream_lock:
        old = _preview_manifest_by_url.get(url)
        if old and old.get("token") and old["token"] != entry.get("token"):
            _preview_manifest_by_token.pop(str(old["token"]), None)
        _preview_manifest_by_url[url] = entry
        _preview_manifest_by_token[str(entry["token"])] = entry
        _trim_manifest_cache_locked()


def _build_manifest_entry(url: str, info: dict[str, Any]) -> dict[str, Any]:
    videos, audios = _pick_adaptive_formats(info)
    if not videos or not audios:
        raise RuntimeError(
            "No MP4 adaptive formats available for DASH preview"
        )

    # Probe representations concurrently; extract semaphore already released.
    jobs: list[tuple[str, dict[str, Any]]] = [
        ("video", fmt) for fmt in videos
    ] + [("audio", fmt) for fmt in audios]
    reps: dict[str, dict[str, Any]] = {}
    errors: list[Exception] = []

    def _probe_one(kind: str, fmt: dict[str, Any]) -> dict[str, Any]:
        return _build_representation(fmt, info, kind=kind)

    workers = min(6, max(1, len(jobs)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_probe_one, kind, fmt): (kind, fmt)
            for kind, fmt in jobs
        }
        for fut in as_completed(futures):
            try:
                rep = fut.result()
                reps[rep["itag"]] = rep
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
                logger.warning("Preview probe failed: %s", exc)

    video_reps = [r for r in reps.values() if r.get("kind") == "video"]
    audio_reps = [r for r in reps.values() if r.get("kind") == "audio"]
    if not video_reps or not audio_reps:
        detail = f": {errors[0]}" if errors else ""
        raise RuntimeError(
            f"No MP4 adaptive formats available for DASH preview{detail}"
        )

    # Prefer exact sidx-derived duration over yt-dlp's rounded seconds.
    sidx_durs = [
        float(r["duration_sec"])
        for r in reps.values()
        if r.get("duration_sec")
    ]
    duration_f = max(sidx_durs) if sidx_durs else None
    if duration_f is None:
        duration = info.get("duration")
        try:
            duration_f = float(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration_f = None

    heights = [
        int(r["height"])
        for r in video_reps
        if r.get("height")
    ]
    max_height = max(heights) if heights else None

    return {
        "token": secrets.token_urlsafe(18),
        "source_url": url,
        "duration": duration_f,
        "max_height": max_height,
        "formats": reps,
        "expires_at": time.time() + _PREVIEW_MANIFEST_TTL_SEC,
    }


def _do_resolve_preview_manifest(
    url: str, *, force: bool = False
) -> dict[str, Any]:
    """Internal resolve without single-flight wrapping."""
    now = time.time()
    if not force:
        with _preview_stream_lock:
            cached = _preview_manifest_by_url.get(url)
            if cached and cached.get("expires_at", 0) > now + 60:
                return dict(cached)

    # Hold extract semaphore only for yt-dlp; probe concurrently afterwards.
    with _preview_extract_sem:
        if not force:
            with _preview_stream_lock:
                cached = _preview_manifest_by_url.get(url)
                if cached and cached.get("expires_at", 0) > now + 60:
                    return dict(cached)
        info = _extract_preview_info(url, force=force)

    existing_token: Optional[str] = None
    with _preview_stream_lock:
        prev = _preview_manifest_by_url.get(url)
        if prev:
            existing_token = str(prev.get("token") or "") or None

    entry = _build_manifest_entry(url, info)
    if existing_token and force:
        entry["token"] = existing_token
    _store_manifest_entry(url, entry)
    return dict(entry)


def resolve_preview_manifest(url: str, *, force: bool = False) -> dict[str, Any]:
    """Resolve adaptive formats and return a cached manifest session.

    Concurrent force refreshes for the same URL collapse into one extraction
    (single-flight) with a short debounce so 403 storms do not queue N extracts.
    """
    if not force:
        return _do_resolve_preview_manifest(url, force=False)

    now = time.time()
    with _preview_stream_lock:
        last = _preview_refresh_last_at.get(url, 0.0)
        if now - last < _PREVIEW_REFRESH_DEBOUNCE_SEC:
            cached = _preview_manifest_by_url.get(url)
            if cached:
                return dict(cached)
        inflight = _preview_refresh_inflight.get(url)
        if inflight is None:
            inflight = threading.Event()
            _preview_refresh_inflight[url] = inflight
            leader = True
        else:
            leader = False

    if not leader:
        # Wait for the in-flight refresh; fall back to cache or raise.
        inflight.wait(timeout=120)
        with _preview_stream_lock:
            cached = _preview_manifest_by_url.get(url)
        if cached:
            return dict(cached)
        raise PreviewRefreshError(
            "Preview media refresh in progress failed",
            retry_after=15,
        )

    try:
        entry = _do_resolve_preview_manifest(url, force=True)
        with _preview_stream_lock:
            _preview_refresh_last_at[url] = time.time()
            _preview_refresh_attempts[url] = 0
        return entry
    except Exception as exc:  # noqa: BLE001
        with _preview_stream_lock:
            attempts = _preview_refresh_attempts.get(url, 0) + 1
            _preview_refresh_attempts[url] = attempts
        logger.warning("Preview manifest refresh failed for %s: %s", url, exc)
        if isinstance(exc, PreviewRefreshError):
            raise
        raise PreviewRefreshError(
            f"Could not refresh preview media: {exc}",
            retry_after=15,
        ) from exc
    finally:
        with _preview_stream_lock:
            done = _preview_refresh_inflight.pop(url, None)
        if done is not None:
            done.set()


def build_dash_manifest(session: dict[str, Any]) -> str:
    """Build a SegmentBase DASH MPD with proxied BaseURLs.

    Video representations are emitted in one AdaptationSet per codec family
    so ABR never crosses a codec boundary mid-playback.
    """
    token = str(session["token"])
    duration = session.get("duration")
    try:
        dur = float(duration) if duration is not None else 0.0
    except (TypeError, ValueError):
        dur = 0.0
    media_duration = f"PT{max(dur, 0.1):.3f}S"

    formats: dict[str, dict[str, Any]] = session.get("formats") or {}
    videos = [r for r in formats.values() if r.get("kind") == "video"]
    audios = [r for r in formats.values() if r.get("kind") == "audio"]

    # Group by codec family (av01 / avc1).
    by_family: dict[str, list[dict[str, Any]]] = {}
    for rep in videos:
        family = str(rep.get("codec_family") or "avc1")
        by_family.setdefault(family, []).append(rep)
    # Prefer listing AV1 first so Shaka's preferredVideoCodecs can pick it.
    family_order = sorted(
        by_family.keys(),
        key=lambda f: (0 if f == "av01" else 1, f),
    )

    lines: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" '
            'profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" '
            'type="static" '
            f'mediaPresentationDuration="{media_duration}" '
            'minBufferTime="PT1.5S">'
        ),
        "<Period>",
    ]

    set_id = 0
    for family in family_order:
        family_reps = by_family[family]
        family_reps.sort(
            key=lambda r: int(r.get("height") or 0), reverse=True
        )
        aligned = _boundaries_aligned(family_reps)
        widths = [int(r.get("width") or 0) for r in family_reps]
        heights = [int(r.get("height") or 0) for r in family_reps]
        fps_vals = [int(r["fps"]) for r in family_reps if r.get("fps")]
        align_attrs = ""
        if aligned:
            align_attrs = (
                ' segmentAlignment="true" subsegmentAlignment="true"'
            )
        max_w = max(widths) if widths else 0
        max_h = max(heights) if heights else 0
        max_fps = max(fps_vals) if fps_vals else 0
        extra = ""
        if max_w > 0:
            extra += f' maxWidth="{max_w}"'
        if max_h > 0:
            extra += f' maxHeight="{max_h}"'
        if max_fps > 0:
            extra += f' maxFrameRate="{max_fps}"'
        lines.append(
            f'<AdaptationSet id="{set_id}" contentType="video" '
            f'mimeType="video/mp4" startWithSAP="1" '
            f'subsegmentStartsWithSAP="1"{align_attrs}{extra}>'
        )
        lines.append(
            '<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>'
        )
        for rep in family_reps:
            itag = xml_escape(str(rep["itag"]))
            codecs = xml_escape(str(rep.get("codecs") or "avc1.4D401F"))
            bandwidth = int(rep.get("bandwidth") or 1_000_000)
            width = int(rep.get("width") or 0)
            height = int(rep.get("height") or 0)
            fps = rep.get("fps")
            attrs = [
                f'id="{itag}"',
                f'bandwidth="{bandwidth}"',
                f'codecs="{codecs}"',
            ]
            if width > 0:
                attrs.append(f'width="{width}"')
            if height > 0:
                attrs.append(f'height="{height}"')
            if fps:
                attrs.append(f'frameRate="{int(fps)}"')
            base = (
                f"/api/preview/media?token={xml_escape(token)}"
                f"&amp;itag={itag}"
            )
            lines.append(f"<Representation {' '.join(attrs)}>")
            lines.append(f"<BaseURL>{base}</BaseURL>")
            lines.extend(_segment_base_xml(rep))
            lines.append("</Representation>")
        lines.append("</AdaptationSet>")
        set_id += 1

    if audios:
        aligned_a = _boundaries_aligned(audios)
        align_attrs = ""
        if aligned_a:
            align_attrs = (
                ' segmentAlignment="true" subsegmentAlignment="true"'
            )
        lang = xml_escape(str(audios[0].get("lang") or "und"))
        lines.append(
            f'<AdaptationSet id="{set_id}" contentType="audio" '
            f'mimeType="audio/mp4" startWithSAP="1" '
            f'subsegmentStartsWithSAP="1"{align_attrs} lang="{lang}">'
        )
        for rep in audios:
            itag = xml_escape(str(rep["itag"]))
            codecs = xml_escape(str(rep.get("codecs") or "mp4a.40.2"))
            bandwidth = int(rep.get("bandwidth") or 128_000)
            channels = int(rep.get("audio_channels") or 2)
            base = (
                f"/api/preview/media?token={xml_escape(token)}"
                f"&amp;itag={itag}"
            )
            lines.append(
                f'<Representation id="{itag}" bandwidth="{bandwidth}" '
                f'codecs="{codecs}">'
            )
            lines.append(
                '<AudioChannelConfiguration '
                'schemeIdUri="urn:mpeg:dash:23003:3:'
                'audio_channel_configuration:2011" '
                f'value="{channels}"/>'
            )
            lines.append(f"<BaseURL>{base}</BaseURL>")
            lines.extend(_segment_base_xml(rep))
            lines.append("</Representation>")
        lines.append("</AdaptationSet>")

    lines.append("</Period>")
    lines.append("</MPD>")
    return "\n".join(lines)


def lookup_preview_media(
    token: str, itag: str, *, refresh: bool = False
) -> dict[str, Any]:
    """Look up a cached adaptive format for the media proxy.

    On refresh=True (e.g. upstream 403), re-resolve URLs keeping the same token.
    Also refreshes proactively when the session is near expiry.
    """
    with _preview_stream_lock:
        session = _preview_manifest_by_token.get(token)
        attempts = _preview_refresh_attempts.get(
            str(session.get("source_url") or "") if session else "", 0
        )

    if session is None:
        raise KeyError("Unknown or expired preview media token")

    source_url = str(session.get("source_url") or "")
    now = time.time()
    expires_at = float(session.get("expires_at") or 0)
    near_expiry = expires_at > 0 and expires_at - now < _PREVIEW_REFRESH_PROACTIVE_SEC
    need_refresh = refresh or near_expiry

    if need_refresh:
        if not source_url:
            raise RuntimeError("Cannot refresh preview media: missing source URL")
        if attempts >= _PREVIEW_REFRESH_MAX_ATTEMPTS and refresh:
            raise PreviewRefreshError(
                "Preview media refresh attempts exhausted",
                retry_after=30,
            )
        try:
            session = resolve_preview_manifest(source_url, force=True)
            # Ensure token index still points at the refreshed entry.
            with _preview_stream_lock:
                session["token"] = token
                _preview_manifest_by_token[token] = session
                _preview_manifest_by_url[source_url] = session
        except Exception as exc:  # noqa: BLE001
            # Explicit 403 refresh must surface; proactive refresh can keep
            # serving the existing CDN URLs until they actually fail.
            if refresh:
                if isinstance(exc, PreviewRefreshError):
                    raise
                raise PreviewRefreshError(
                    f"Could not refresh preview media: {exc}",
                    retry_after=15,
                ) from exc
            logger.warning(
                "Proactive preview refresh failed; using cached URLs: %s", exc
            )

    formats: dict[str, dict[str, Any]] = session.get("formats") or {}
    fmt = formats.get(itag)
    if fmt is None:
        raise KeyError(f"Unknown itag {itag} for preview token")

    return {
        "direct_url": str(fmt["direct_url"]),
        "http_headers": dict(fmt.get("http_headers") or {}),
        "content_type": str(fmt.get("content_type") or "video/mp4"),
        "source_url": source_url,
    }

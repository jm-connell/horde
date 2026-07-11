import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR, MAX_DOWNLOAD_CONCURRENCY, THUMBNAILS_DIR, VIDEO_EXTENSIONS
from ..database import engine
from ..models import DownloadJob, JobStatus, Video, VideoStatus
from . import library, scanner
from .metadata import probe_dimensions, probe_duration, probe_is_playable
from .paths import find_video_by_path, to_rel_path
from .ytdlp_common import apply_cookie_opts, extract_info_gated, youtube_extractor_args

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
        """Resume dispatching jobs left queued from a previous server run."""
        with Session(engine) as session:
            for job in session.exec(
                select(DownloadJob).where(
                    DownloadJob.status == JobStatus.downloading
                )
            ).all():
                if job.id not in self._running:
                    job.status = JobStatus.queued
                    job.progress = 0.0
                    session.add(job)
            session.commit()
        self._dispatch()

    def pause_all(self) -> None:
        with self._lock:
            self._global_paused = True
            events = list(self._cancel_events.values())
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
        with self._lock:
            self._global_paused = False
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
                session.add(job)
                session.commit()
                progress_store[job_id] = {
                    "status": "cancelled",
                    "error": "Cancelled",
                }
                return True
            if event is None and job.status == JobStatus.downloading:
                # Orphaned job — no worker thread to signal.
                job.status = JobStatus.cancelled
                job.error = "Cancelled"
                job.progress = 0.0
                session.add(job)
                session.commit()
                progress_store[job_id] = {
                    "status": "cancelled",
                    "error": "Cancelled",
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

    # Queue metadata embed + tag enrich (subtitles re-embed after finalize).
    try:
        from .ai import enqueue_for_video

        enqueue_for_video(video_id, include_tags=True, force=False)
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

    _update_job(job_id, status=JobStatus.downloading, paused=False)
    progress_store[job_id] = {"status": "downloading", "progress": 0.0}

    active_paths: set[str] = set()
    info: dict[str, Any] = {}
    metadata_info: dict[str, Any] = {}
    prepared: Optional[Path] = None
    final_path: Optional[Path] = None
    last_exc: Optional[Exception] = None

    base_ydl_opts: dict[str, Any] = apply_cookie_opts(
        {
            "outtmpl": OUTPUT_TEMPLATE,
            "progress_hooks": [_make_progress_hook(job_id, cancel)],
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "logger": _YtdlpLogger(),
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
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    fetched = ydl.extract_info(url, download=False)
                    metadata_info = _merge_info(metadata_info, fetched)
                    info = metadata_info
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
                        info = _merge_info(metadata_info, downloaded)
                        metadata_info = info
                    except Exception as exc:
                        last_exc = exc
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
            except Exception as exc:
                last_exc = exc
                recovered = _resolve_merged_video(prepared, active_paths)
                recovered = _reject_unplayable(recovered, attempt_paths)
                if recovered is not None:
                    final_path = recovered
                    break
                _cleanup_partial_files(attempt_paths)

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
                progress_store[job_id] = {
                    "status": "queued",
                    "progress": 0.0,
                    "title": job.title,
                    "channel": job.channel,
                }
            else:
                job.status = JobStatus.cancelled
                job.error = "Cancelled"
                job.progress = 0.0
                progress_store[job_id] = {
                    "status": "cancelled",
                    "error": "Cancelled",
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
        message = _strip_ansi(str(exc))
        _update_job(job_id, status=JobStatus.error, error=message)
        progress_store[job_id] = {
            "status": "error",
            "error": message,
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
            "extractor_args": youtube_extractor_args(),
        }
    )
    info = _as_info(extract_info_gated(url, opts, cache_key=f"preview:{url}"))

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
    return {
        "is_playlist": False,
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url"),
        "thumbnail_url": _best_thumbnail_url(info),
        "entry_count": None,
        "view_count": view_count,
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
        entries.append(
            {
                "id": vid,
                "url": entry_url,
                "title": entry.get("title"),
                "duration": entry.get("duration"),
                "thumbnail_url": _entry_thumbnail_url(entry, vid),
                "view_count": view_count,
                "published_at": published_at,
            }
        )

    result = {
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url") or channel_url,
        "entries": entries,
        "has_more": len(entries) == limit,
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


# --- In-app stream preview (progressive/muxed proxy) ---

_PREVIEW_CACHE_TTL_SEC = 240
_PREVIEW_MAX_HEIGHT = 720
_preview_stream_cache: dict[str, dict[str, Any]] = {}
_preview_stream_lock = threading.Lock()
_preview_extract_sem = threading.Semaphore(2)


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


def _extract_preview_info(url: str) -> dict[str, Any]:
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extractor_args": youtube_extractor_args(),
        }
    )
    # Share cache with download-preview when possible (same URL, full extract).
    info = _as_info(extract_info_gated(url, opts, cache_key=f"stream:{url}"))
    if info.get("_type") == "playlist" or (
        info.get("entries") is not None and not info.get("formats")
    ):
        raise ValueError("Playlists cannot be preview-streamed")
    return info


def extract_stream_preview_meta(url: str) -> dict[str, Any]:
    """Metadata for the in-app preview page (includes description for chapters)."""
    info = _extract_preview_info(url)
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
    }


def resolve_preview_stream(url: str) -> dict[str, Any]:
    """Resolve a short-lived progressive media URL for proxy streaming.

    Returns dict with direct_url, http_headers, height, content_type, expires_at.
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

        headers = dict(fmt.get("http_headers") or {})
        # yt-dlp sometimes puts cookies on the format / info.
        cookie = fmt.get("cookies") or info.get("cookies")
        if cookie and "Cookie" not in headers:
            headers["Cookie"] = cookie

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

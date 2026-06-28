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
from .metadata import probe_dimensions, probe_duration
from .paths import find_video_by_path, to_rel_path

# Live progress snapshots keyed by job id, consumed by the SSE endpoint.
progress_store: dict[int, dict[str, Any]] = {}

# Strict capped presets — no unrestricted fallback that can grab a lower tier.
QUALITY_FORMATS = {
    "best": "bv*+ba/b",
    "1440p": "bv*[height<=1440]+ba/b[height<=1440]/b[height<=1440]",
    "1080p": "bv*[height<=1080]+ba/b[height<=1080]/b[height<=1080]",
    "720p": "bv*[height<=720]+ba/b[height<=720]/b[height<=720]",
    "480p": "bv*[height<=480]+ba/b[height<=480]/b[height<=480]",
    "audio": "ba/b",
}

PRESET_MAX_HEIGHT: dict[str, Optional[int]] = {
    "best": None,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "audio": None,
}

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


def _find_merged_video(prepared: Path) -> Optional[Path]:
    """Locate the final merged video when yt-dlp errors on fragment cleanup."""
    mp4 = prepared.with_suffix(".mp4")
    if mp4.exists() and _FRAGMENT_RE.search(mp4.name) is None:
        return mp4
    if (
        prepared.exists()
        and prepared.suffix.lower() in VIDEO_EXTENSIONS
        and _FRAGMENT_RE.search(prepared.name) is None
        and not prepared.name.endswith(".part")
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
        if _FRAGMENT_RE.search(entry.name) or entry.name.endswith(".part"):
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
    primary = QUALITY_FORMATS.get(preset, QUALITY_FORMATS["best"])
    max_h = PRESET_MAX_HEIGHT.get(preset)
    chain = [primary]
    if max_h:
        chain.append(
            f"best[ext=mp4][height<={max_h}]/best[height<={max_h}]/best"
        )
    chain.append("best[ext=mp4]/best")
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
        with Session(engine) as session:
            job = session.exec(
                select(DownloadJob)
                .where(
                    DownloadJob.status == JobStatus.queued,
                    DownloadJob.paused == False,  # noqa: E712
                )
                .order_by(DownloadJob.created_at.asc())
            ).first()
            return job.id if job else None

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
    def hook(d: dict[str, Any]) -> None:
        if cancel_event.is_set():
            raise DownloadCancelled()
        if not isinstance(d, dict):
            return
        try:
            status = d.get("status")
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                downloaded = d.get("downloaded_bytes", 0)
                percent = (downloaded / total * 100) if total else 0.0
                info = _as_info(d.get("info_dict"))
                progress_store[job_id] = {
                    "status": "downloading",
                    "progress": round(percent, 1),
                    "title": info.get("title"),
                    "channel": info.get("uploader") or info.get("channel"),
                    "total_bytes": total,
                    "downloaded_bytes": downloaded,
                }
            elif status == "finished":
                progress_store[job_id] = {"status": "processing", "progress": 99.0}
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
    return {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en"],
        "subtitlesformat": "vtt/best",
        "outtmpl": outtmpl,
        "postprocessors": [{"key": "FFmpegSubtitlesConvertor", "format": "vtt"}],
        "extractor_args": {
            "youtube": {"player_client": ["android_vr", "web", "ios"]},
        },
    }


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


def _cleanup_partial_files(paths: set[str]) -> None:
    """Remove in-progress fragments only — never delete a finished merged video."""
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


def _check_quality(
    preset: str, height: Optional[int]
) -> Optional[str]:
    """Return a warning string if actual height is well below the requested cap."""
    max_h = PRESET_MAX_HEIGHT.get(preset)
    if max_h is None or height is None:
        return None
    tiers = [480, 720, 1080, 1440]
    cap_idx = next((i for i, t in enumerate(tiers) if t >= max_h), len(tiers) - 1)
    actual_idx = next(
        (i for i, t in enumerate(tiers) if t >= height), len(tiers) - 1
    )
    if actual_idx < cap_idx - 1:
        return (
            f"Requested {preset} but file is {height}p — "
            "source may not offer higher quality."
        )
    return None


def _apply_loudnorm(path: Path) -> Optional[str]:
    """Normalize loudness via ffmpeg; returns warning if skipped."""
    if not shutil.which("ffmpeg"):
        return "Volume normalization skipped: ffmpeg not found"
    tmp = path.with_suffix(".norm.mp4")
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
        tmp.replace(path)
        return None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        tmp.unlink(missing_ok=True)
        return "Volume normalization failed"


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
) -> int:
    info = _as_info(info)
    source_url = info.get("webpage_url") or url
    subtitle_tracks = download_subtitles(final_path, source_url)

    volume_warning: Optional[str] = None
    if normalize_volume and final_path.exists():
        volume_warning = _apply_loudnorm(final_path)

    rel_path = to_rel_path(final_path)
    file_size = final_path.stat().st_size if final_path.exists() else None
    duration = info.get("duration") or probe_duration(final_path)
    width = info.get("width")
    height = info.get("height")
    if not (width and height):
        dims = probe_dimensions(final_path)
        if dims:
            width, height = dims

    quality_warning = _check_quality(quality_preset, int(height) if height else None)

    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        effective_title = (job.title_override if job else None) or title_override
        effective_channel = (
            (job.channel_override if job else None)
            or channel_override
            or (job.channel if job else None)
        )

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
        video.width_px = int(width) if width else None
        video.height_px = int(height) if height else None
        video.published_at = _published_at(info)
        video.view_count = info.get("view_count")
        video.channel_subscriber_count = info.get("channel_follower_count")
        video.subtitles = library.dump_subtitles(subtitle_tracks)
        video.needs_review = False
        video.platform = info.get("extractor_key")
        video.status = VideoStatus.ready
        video.file_path = rel_path
        if notes_pending:
            video.notes = notes_pending

        session.commit()
        session.refresh(video)

        _remove_review_duplicates(session, info.get("id"), keep_id=video.id)

        thumb = _save_thumbnail(info.get("thumbnail"), video.id)
        if thumb:
            video.thumbnail_path = thumb
            session.add(video)
            session.commit()

        video_id = video.id

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

    base_ydl_opts: dict[str, Any] = {
        "outtmpl": OUTPUT_TEMPLATE,
        "progress_hooks": [_make_progress_hook(job_id, cancel)],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "logger": _YtdlpLogger(),
        "merge_output_format": "mp4",
        "ignoreerrors": True,
        "file_access_retries": 10,
        "retry_sleep_functions": {"file_access": lambda n: 0.5 * (n + 1)},
        "extractor_args": {
            "youtube": {
                "player_client": ["android_vr", "web", "ios"],
            },
        },
    }

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
                        if final_path is None:
                            raise

                    if final_path is None:
                        final_path = _resolve_merged_video(prepared, active_paths)
                    if final_path is None and metadata_info:
                        candidate = Path(ydl.prepare_filename(metadata_info))
                        final_path = candidate.with_suffix(".mp4")
                        if not final_path.exists():
                            final_path = candidate if candidate.exists() else None

                if final_path is not None and final_path.exists():
                    break
            except Exception as exc:
                last_exc = exc
                recovered = _resolve_merged_video(prepared, active_paths)
                if recovered is not None:
                    final_path = recovered
                    break
                _cleanup_partial_files(attempt_paths)

        if final_path is None or not final_path.exists():
            final_path = _resolve_merged_video(prepared, active_paths)
        if final_path is None or not final_path.exists() or final_path.stat().st_size <= 0:
            raise last_exc or RuntimeError("Download produced no file")

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
        effective_info = _merge_info(_as_info(metadata_info), _as_info(info))
        if (
            recovered is not None
            and recovered.exists()
            and recovered.stat().st_size > 0
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


def extract_preview(url: str) -> dict[str, Any]:
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "extractor_args": {
            "youtube": {"player_client": ["android_vr", "web", "ios"]},
        },
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = _as_info(ydl.extract_info(url, download=False))

    if info.get("_type") == "playlist" or info.get("entries") is not None:
        entries = [e for e in (info.get("entries") or []) if e]
        return {
            "is_playlist": True,
            "title": info.get("title"),
            "channel": info.get("uploader") or info.get("channel"),
            "channel_url": info.get("uploader_url") or info.get("channel_url"),
            "thumbnail_url": info.get("thumbnail"),
            "entry_count": len(entries),
        }

    return {
        "is_playlist": False,
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url"),
        "thumbnail_url": info.get("thumbnail"),
        "entry_count": None,
    }


def extract_playlist(url: str) -> tuple[str, list[str]]:
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
    }
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

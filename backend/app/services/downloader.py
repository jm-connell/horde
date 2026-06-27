import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR, MAX_DOWNLOAD_CONCURRENCY, THUMBNAILS_DIR
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


class DownloadCancelled(Exception):
    """Raised from yt-dlp progress hooks when a job is cancelled or paused."""


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
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            downloaded = d.get("downloaded_bytes", 0)
            percent = (downloaded / total * 100) if total else 0.0
            info = d.get("info_dict") or {}
            progress_store[job_id] = {
                "status": "downloading",
                "progress": round(percent, 1),
                "title": info.get("title"),
                "channel": info.get("uploader") or info.get("channel"),
            }
        elif status == "finished":
            progress_store[job_id] = {"status": "processing", "progress": 99.0}

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
    for rel in paths:
        full = DOWNLOADS_DIR / rel
        if full.exists():
            full.unlink(missing_ok=True)
        parent = full.parent
        stem = full.stem
        if parent.is_dir():
            for entry in parent.iterdir():
                if entry.is_file() and entry.name.startswith(stem + "."):
                    entry.unlink(missing_ok=True)


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

    ydl_opts: dict[str, Any] = {
        "format": QUALITY_FORMATS.get(quality_preset, QUALITY_FORMATS["best"]),
        "outtmpl": OUTPUT_TEMPLATE,
        "progress_hooks": [_make_progress_hook(job_id, cancel)],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "merge_output_format": "mp4",
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en"],
        "subtitlesformat": "vtt/best",
        "postprocessors": [
            {"key": "FFmpegSubtitlesConvertor", "format": "vtt"},
        ],
        "extractor_args": {
            "youtube": {
                "player_client": ["android_vr", "web", "ios"],
            },
        },
    }

    active_paths: set[str] = set()
    quality_warning: Optional[str] = None
    volume_warning: Optional[str] = None

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            prepared = Path(ydl.prepare_filename(info))
            for candidate in (prepared, prepared.with_suffix(".mp4")):
                rel = _safe_rel(candidate)
                if rel:
                    active_paths.add(rel)
                    scanner.mark_active(rel)

            progress_store[job_id] = {
                **progress_store.get(job_id, {}),
                "title": info.get("title"),
                "channel": info.get("uploader") or info.get("channel"),
            }

            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            final_path = Path(filename)
            if not final_path.exists():
                mp4_candidate = final_path.with_suffix(".mp4")
                if mp4_candidate.exists():
                    final_path = mp4_candidate

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
                    old_path.unlink(missing_ok=True)
                for track in library.parse_subtitles(video.subtitles):
                    sub = DOWNLOADS_DIR / track.get("path", "")
                    if sub.exists():
                        sub.unlink(missing_ok=True)
            else:
                video = find_video_by_path(session, rel_path)
                if video is None:
                    video = Video(file_path=rel_path)
                    session.add(video)

            video.title = effective_title or info.get("title") or final_path.stem
            video.channel = (
                effective_channel or info.get("uploader") or info.get("channel")
            )
            video.channel_url = info.get("uploader_url") or info.get("channel_url")
            video.description = info.get("description")
            video.tags = library.dump_tags(_collect_tags(info))
            video.source_url = info.get("webpage_url") or url
            video.duration_sec = duration
            video.file_size = file_size
            video.width_px = int(width) if width else None
            video.height_px = int(height) if height else None
            video.published_at = _published_at(info)
            video.view_count = info.get("view_count")
            video.channel_subscriber_count = info.get("channel_follower_count")
            video.subtitles = library.dump_subtitles(_collect_subtitles(final_path))
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
        )
        progress_store[job_id] = snapshot
        return video_id

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
        _cleanup_partial_files(active_paths)
        _update_job(job_id, status=JobStatus.error, error=str(exc))
        progress_store[job_id] = {"status": "error", "error": str(exc)}
        return None
    finally:
        for rel in active_paths:
            scanner.unmark_active(rel)


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
        info = ydl.extract_info(url, download=False)

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
        info = ydl.extract_info(url, download=False)

    title = info.get("title") or "Imported playlist"
    entries = []
    for entry in info.get("entries") or []:
        if not entry:
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
            job = DownloadJob(
                url=entry_url,
                quality_preset=quality_preset,
                status=JobStatus.queued,
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

import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR, THUMBNAILS_DIR
from ..database import engine
from ..models import DownloadJob, JobStatus, Video, VideoStatus
from . import library, scanner
from .metadata import probe_dimensions, probe_duration
from .paths import find_video_by_path, to_rel_path

# Live progress snapshots keyed by job id, consumed by the SSE endpoint.
progress_store: dict[int, dict[str, Any]] = {}

# bv*+ba/b = best video+audio merge, falling back to a single progressive file.
QUALITY_FORMATS = {
    "best": "bv*+ba/b",
    "1440p": "bv*[height<=1440]+ba/b[height<=1440]/bv*+ba/b",
    "1080p": "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
    "720p": "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
    "480p": "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b",
    "audio": "ba/b",
}

OUTPUT_TEMPLATE = str(
    DOWNLOADS_DIR / "%(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s].%(ext)s"
)


def _update_job(job_id: int, **fields: Any) -> None:
    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is None:
            return
        for key, value in fields.items():
            setattr(job, key, value)
        session.add(job)
        session.commit()


def _make_progress_hook(job_id: int):
    def hook(d: dict[str, Any]) -> None:
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            downloaded = d.get("downloaded_bytes", 0)
            percent = (downloaded / total * 100) if total else 0.0
            progress_store[job_id] = {
                "status": "downloading",
                "progress": round(percent, 1),
                "title": d.get("info_dict", {}).get("title"),
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
    """Gather tags and categories from yt-dlp metadata for keyword search."""
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
    """Collapse regional/origin variants (en-US, en-GB, en-orig) to a base code."""
    return lang.split("-")[0].lower()


def _collect_subtitles(final_path: Path) -> list[dict[str, Any]]:
    """Find sidecar ``.vtt`` files yt-dlp wrote next to the video, keeping one
    track per language (variants like ``en-orig`` collapse to ``en``)."""
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
        # Prefer the exact base-code file (e.g. "en") over a variant ("en-orig").
        if lang not in by_lang or raw_lang.lower() == lang:
            by_lang[lang] = {"lang": lang, "path": rel, "auto": False}
    return list(by_lang.values())


def _remove_review_duplicates(
    session: Session, video_id: Optional[str], keep_id: Optional[int]
) -> None:
    """Drop stale review rows for the same source video (e.g. a scanner-ingested
    fragment) now that the real download has landed."""
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
    raw = info.get("upload_date")  # YYYYMMDD
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y%m%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _run_download(
    job_id: int,
    url: str,
    quality_preset: str,
    title_override: Optional[str] = None,
    channel_override: Optional[str] = None,
) -> Optional[int]:
    import yt_dlp

    _update_job(job_id, status=JobStatus.downloading)
    progress_store[job_id] = {"status": "downloading", "progress": 0.0}

    ydl_opts = {
        "format": QUALITY_FORMATS.get(quality_preset, QUALITY_FORMATS["best"]),
        "outtmpl": OUTPUT_TEMPLATE,
        "progress_hooks": [_make_progress_hook(job_id)],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "merge_output_format": "mp4",
        # Fetch captions (manual, falling back to auto-generated) as WebVTT so
        # the player can show subtitles.
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en"],
        "subtitlesformat": "vtt/best",
        "postprocessors": [
            {"key": "FFmpegSubtitlesConvertor", "format": "vtt"},
        ],
        # YouTube often breaks older clients; try multiple player APIs.
        "extractor_args": {
            "youtube": {
                "player_client": ["android_vr", "web", "ios"],
            },
        },
    }

    active_paths: set[str] = set()
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # Metadata-only pass first so we know the output path before any file
            # is written, and can tell the scanner to ignore it (avoids the
            # download briefly appearing in the review queue).
            info = ydl.extract_info(url, download=False)
            prepared = Path(ydl.prepare_filename(info))
            for candidate in (prepared, prepared.with_suffix(".mp4")):
                rel = _safe_rel(candidate)
                if rel:
                    active_paths.add(rel)
                    scanner.mark_active(rel)

            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            # merge_output_format can change the final extension.
            final_path = Path(filename)
            if not final_path.exists():
                mp4_candidate = final_path.with_suffix(".mp4")
                if mp4_candidate.exists():
                    final_path = mp4_candidate

        rel_path = to_rel_path(final_path)
        file_size = final_path.stat().st_size if final_path.exists() else None
        duration = info.get("duration") or probe_duration(final_path)
        width = info.get("width")
        height = info.get("height")
        if not (width and height):
            dims = probe_dimensions(final_path)
            if dims:
                width, height = dims

        with Session(engine) as session:
            # Re-read the job so edits made on the download card mid-download win.
            job = session.get(DownloadJob, job_id)
            effective_title = (job.title_override if job else None) or title_override
            effective_channel = (
                job.channel_override if job else None
            ) or channel_override

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
            # Normalize legacy backslash paths on re-import.
            video.file_path = rel_path

            session.commit()
            session.refresh(video)

            _remove_review_duplicates(session, info.get("id"), keep_id=video.id)

            thumb = _save_thumbnail(info.get("thumbnail"), video.id)
            if thumb:
                video.thumbnail_path = thumb
                session.add(video)
                session.commit()

            video_id = video.id

        _update_job(
            job_id,
            status=JobStatus.completed,
            progress=100.0,
            title=info.get("title"),
            video_id=video_id,
        )
        progress_store[job_id] = {
            "status": "completed",
            "progress": 100.0,
            "video_id": video_id,
            "title": info.get("title"),
        }
        return video_id
    except Exception as exc:  # noqa: BLE001 - surface any yt-dlp failure to the UI
        _update_job(job_id, status=JobStatus.error, error=str(exc))
        progress_store[job_id] = {"status": "error", "error": str(exc)}
        return None
    finally:
        for rel in active_paths:
            scanner.unmark_active(rel)


def start_download(
    job_id: int,
    url: str,
    quality_preset: str,
    title_override: Optional[str] = None,
    channel_override: Optional[str] = None,
) -> None:
    thread = threading.Thread(
        target=_run_download,
        args=(job_id, url, quality_preset, title_override, channel_override),
        daemon=True,
    )
    thread.start()


def extract_preview(url: str) -> dict[str, Any]:
    """Inspect a URL without downloading so the UI can show and let the user
    override the detected title/channel, and detect playlists."""
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
            "entry_count": len(entries),
        }

    return {
        "is_playlist": False,
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url"),
        "entry_count": None,
    }


def extract_playlist(url: str) -> tuple[str, list[str]]:
    """Return (playlist title, list of entry watch URLs) without downloading."""
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
    from ..models import Playlist, PlaylistItem

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

        video_id = _run_download(job_id, entry_url, quality_preset)
        if video_id is None:
            continue

        with Session(engine) as session:
            # Skip if this video is already linked (e.g. re-import).
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

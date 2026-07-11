"""Periodic and on-demand metadata refresh for videos from remote sources."""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR, THUMBNAILS_DIR
from ..database import engine
from ..models import Video
from . import library
from .ytdlp_common import apply_cookie_opts, youtube_extractor_args

SyncField = Literal["views", "thumbnails", "captions", "titles_descriptions", "all"]

_sync_lock = threading.Lock()
_job_lock = threading.Lock()
_job_state: dict[str, Any] = {
    "running": False,
    "total": 0,
    "done": 0,
    "failed": 0,
    "skipped": 0,
    "current_title": None,
    "current_video_id": None,
    "fields": [],
    "last_error": None,
    "finished_at": None,
}


def get_sync_status() -> dict[str, Any]:
    with _job_lock:
        return dict(_job_state)


def _set_job(**kwargs: Any) -> None:
    with _job_lock:
        _job_state.update(kwargs)


def _extract_metadata(url: str) -> dict[str, Any]:
    import yt_dlp

    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extractor_args": youtube_extractor_args(),
        }
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return info or {}


def _save_thumbnail(url: Optional[str], video_id: int) -> Optional[str]:
    if not url:
        return None
    import httpx

    dest = THUMBNAILS_DIR / f"{video_id}.jpg"
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
        return str(dest)
    except (httpx.HTTPError, OSError):
        return None


def _normalize_fields(fields: Optional[list[str]]) -> set[str]:
    if not fields or "all" in fields:
        return {"views", "thumbnails", "captions", "titles_descriptions"}
    allowed = {"views", "thumbnails", "captions", "titles_descriptions"}
    return {f for f in fields if f in allowed} or {
        "views",
        "thumbnails",
        "captions",
        "titles_descriptions",
    }


def refresh_video_metadata(
    video_id: int,
    *,
    fields: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Fetch fresh metadata from the source URL and update the video row.

    Returns a dict of changed fields (useful for the watch-page banner).
    Customized title/description are preserved; only view counts and other
    non-user-editable stats are force-updated.
    """
    want = _normalize_fields(fields)

    with Session(engine) as session:
        video = session.get(Video, video_id)
        if video is None:
            raise ValueError(f"Video {video_id} not found")
        if not video.source_url:
            raise ValueError("No source URL to refresh from")
        source_url = video.source_url

    info = _extract_metadata(source_url)
    changed: dict[str, Any] = {}

    with Session(engine) as session:
        video = session.get(Video, video_id)
        if video is None:
            return {}

        remote_title = info.get("title")
        remote_description = info.get("description")

        if "titles_descriptions" in want or "views" in want:
            if remote_title and remote_title != video.source_title:
                video.source_title = remote_title
            if remote_description != video.source_description:
                video.source_description = remote_description

        if "views" in want:
            new_view_count = info.get("view_count")
            if new_view_count is not None and new_view_count != video.view_count:
                changed["view_count"] = (video.view_count, new_view_count)
                video.view_count = new_view_count

            new_sub_count = info.get("channel_follower_count")
            if (
                new_sub_count is not None
                and new_sub_count != video.channel_subscriber_count
            ):
                video.channel_subscriber_count = new_sub_count

            channel_url = info.get("uploader_url") or info.get("channel_url")
            if channel_url and channel_url != video.channel_url:
                video.channel_url = channel_url

            channel_name = info.get("uploader") or info.get("channel")
            if channel_name and not video.channel:
                video.channel = channel_name

        if "thumbnails" in want:
            thumb_path = _save_thumbnail(info.get("thumbnail"), video.id)
            if thumb_path:
                video.thumbnail_path = thumb_path

        if "titles_descriptions" in want:
            if (
                not video.title_is_custom
                and remote_title
                and remote_title != video.title
            ):
                changed["title"] = (video.title, remote_title)
                video.title = remote_title

            if (
                not video.description_is_custom
                and remote_description != video.description
            ):
                changed["description"] = (video.description, remote_description)
                video.description = remote_description

        video.metadata_synced_at = datetime.now(timezone.utc)
        session.add(video)
        session.commit()

    if "captions" in want:
        try:
            from .downloader import download_subtitles

            with Session(engine) as session:
                video = session.get(Video, video_id)
                if video is None:
                    return changed
                media = DOWNLOADS_DIR / video.file_path
                tracks = download_subtitles(media, source_url)
                if tracks:
                    video.subtitles = library.dump_subtitles(tracks)
                session.add(video)
                session.commit()
        except Exception:  # noqa: BLE001
            pass

    return changed


def _should_sync(video: Video, min_interval_hours: int = 24) -> bool:
    if not video.source_url:
        return False
    if video.metadata_synced_at is None:
        return True
    cutoff = datetime.now(timezone.utc) - timedelta(hours=min_interval_hours)
    synced = video.metadata_synced_at
    if synced.tzinfo is None:
        synced = synced.replace(tzinfo=timezone.utc)
    return synced < cutoff


def _run_bulk_job(video_ids: list[int], fields: list[str]) -> None:
    want = sorted(_normalize_fields(fields))
    _set_job(
        running=True,
        total=len(video_ids),
        done=0,
        failed=0,
        skipped=0,
        current_title=None,
        current_video_id=None,
        fields=want,
        last_error=None,
        finished_at=None,
    )
    try:
        for vid in video_ids:
            with Session(engine) as session:
                video = session.get(Video, vid)
                if video is None or not video.source_url:
                    _set_job(skipped=_job_state["skipped"] + 1)
                    continue
                title = video.title
                _set_job(current_title=title, current_video_id=vid)
            try:
                with _sync_lock:
                    refresh_video_metadata(vid, fields=want)
                _set_job(done=_job_state["done"] + 1)
            except Exception as exc:  # noqa: BLE001
                _set_job(
                    failed=_job_state["failed"] + 1,
                    last_error=str(exc),
                )
    finally:
        _set_job(
            running=False,
            current_title=None,
            current_video_id=None,
            finished_at=datetime.now(timezone.utc).isoformat(),
        )


def start_bulk_sync(
    video_ids: Optional[list[int]] = None,
    fields: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Queue a background bulk metadata sync. Returns immediate status."""
    with _job_lock:
        if _job_state["running"]:
            return {"started": False, "detail": "Metadata sync already running", **dict(_job_state)}

    with Session(engine) as session:
        if video_ids:
            ids = [vid for vid in video_ids if session.get(Video, vid) is not None]
        else:
            ids = list(
                session.exec(
                    select(Video.id).where(Video.source_url.is_not(None))  # type: ignore[attr-defined]
                ).all()
            )
            ids = [vid for vid in ids if vid is not None]

    if not ids:
        return {"started": False, "detail": "No videos to sync", "total": 0}

    want = list(_normalize_fields(fields))
    t = threading.Thread(
        target=_run_bulk_job,
        args=(ids, want),
        daemon=True,
        name="metadata-sync-bulk",
    )
    t.start()
    return {
        "started": True,
        "detail": f"Syncing {len(ids)} video(s)",
        "total": len(ids),
        "fields": want,
    }


def run_periodic_sync(interval_hours: int = 24, batch_size: int = 20) -> None:
    """Background thread: refresh stale metadata for all syncable videos."""
    while True:
        with _sync_lock:
            with Session(engine) as session:
                all_videos = session.exec(
                    select(Video).where(Video.source_url.is_not(None))  # type: ignore[attr-defined]
                ).all()
                stale = [v for v in all_videos if _should_sync(v, interval_hours)]

            for video in stale[:batch_size]:
                try:
                    refresh_video_metadata(video.id)
                except Exception:  # noqa: BLE001
                    pass

        try:
            from . import channel_catalog

            channel_catalog.refresh_stale_catalogs()
        except Exception:  # noqa: BLE001
            pass

        # Re-read interval so Settings changes apply without restart.
        try:
            from . import app_settings as settings_svc

            interval_hours = int(
                settings_svc.load().get("metadata_sync_interval_hours")
                or interval_hours
            )
        except Exception:  # noqa: BLE001
            pass
        threading.Event().wait(3600)


def start_sync_worker(interval_hours: int = 24) -> threading.Thread:
    t = threading.Thread(
        target=run_periodic_sync,
        kwargs={"interval_hours": interval_hours},
        daemon=True,
        name="metadata-sync",
    )
    t.start()
    return t

"""Factory reset: restore settings defaults and optionally wipe the library."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from sqlalchemy import delete
from sqlmodel import Session, func, select

from ..database import engine
from ..models import (
    AiCategory,
    AiJob,
    ChannelAutodownload,
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogSkip,
    ChannelCatalogVideo,
    DownloadJob,
    JobStatus,
    OpenRouterUsage,
    Playlist,
    PlaylistItem,
    Video,
    VideoAiChat,
    VideoAiChatMessage,
    VideoAiMeta,
    VideoEmbedding,
)
from . import app_settings, downloader, library, scanner
from .thumbnails import unlink_for_video

_ALWAYS_CLEAR_MODELS = (AiJob, OpenRouterUsage, DownloadJob)

_ERASE_MEDIA_MODELS = (
    VideoAiChatMessage,
    VideoAiChat,
    VideoAiMeta,
    VideoEmbedding,
    ChannelCatalogEmbedding,
    ChannelCatalogSkip,
    ChannelCatalogVideo,
    ChannelCatalog,
    ChannelAutodownload,
    PlaylistItem,
    Playlist,
    AiCategory,
    Video,
)


def reset_app(*, erase_media: bool) -> dict[str, Any]:
    """Pause workers, optionally wipe media, restore defaults, resume."""
    scanner.suspend_scanner()
    try:
        _pause_workers(cancel_downloads=erase_media)
        if erase_media:
            _erase_media()
        _delete_rows(_ALWAYS_CLEAR_MODELS)
        if erase_media:
            _delete_rows(_ERASE_MEDIA_MODELS)
        _wipe_chrome_assets()
        if erase_media:
            _wipe_library_caches()
        app_settings.reset_to_defaults()
    finally:
        _resume_workers()
        scanner.resume_scanner()

    remaining = _video_count()
    return {
        "setup_completed": False,
        "erased_media": bool(erase_media),
        "library_video_count": remaining,
    }


def _pause_workers(*, cancel_downloads: bool) -> None:
    try:
        downloader.download_queue.pause_all()
    except Exception:  # noqa: BLE001
        pass
    try:
        app_settings.save({"ai": {"paused": True}})
    except Exception:  # noqa: BLE001
        pass
    if not cancel_downloads:
        return
    try:
        with Session(engine) as session:
            jobs = session.exec(
                select(DownloadJob).where(
                    DownloadJob.status.in_(
                        [JobStatus.queued, JobStatus.downloading]
                    )
                )
            ).all()
            ids = [job.id for job in jobs if job.id is not None]
        for job_id in ids:
            downloader.download_queue.cancel_job(job_id)
    except Exception:  # noqa: BLE001
        pass


def _resume_workers() -> None:
    try:
        downloader.download_queue.resume_all()
    except Exception:  # noqa: BLE001
        pass
    try:
        from .ai.worker import wake_worker
        from .ai.provider import invalidate_resolved_url

        invalidate_resolved_url()
        wake_worker()
    except Exception:  # noqa: BLE001
        pass


def _erase_media() -> None:
    from ..config import DOWNLOADS_DIR, SPRITES_DIR

    with Session(engine) as session:
        videos = session.exec(select(Video)).all()
        for video in videos:
            _delete_media_files(video)
            unlink_for_video(video.id, video.thumbnail_path)
            if video.id is not None:
                from .metadata import delete_sprite_files

                delete_sprite_files(SPRITES_DIR, video.id)
    _wipe_dir_contents(DOWNLOADS_DIR)


def _delete_media_files(video: Video) -> None:
    from ..config import DOWNLOADS_DIR

    media = DOWNLOADS_DIR / video.file_path
    if media.exists():
        media.unlink(missing_ok=True)
    for track in library.parse_subtitles(video.subtitles):
        sub = DOWNLOADS_DIR / track.get("path", "")
        if sub.exists():
            sub.unlink(missing_ok=True)


def _delete_rows(models: tuple[type, ...]) -> None:
    with Session(engine) as session:
        for model in models:
            session.execute(delete(model))
        session.commit()


def _wipe_chrome_assets() -> None:
    from ..config import BACKGROUNDS_DIR, FONTS_DIR, ensure_dirs

    _wipe_dir_contents(BACKGROUNDS_DIR)
    _wipe_dir_contents(FONTS_DIR)
    ensure_dirs()


def _wipe_library_caches() -> None:
    from ..config import DATA_DIR, SPRITES_DIR, THUMBNAILS_DIR, ensure_dirs

    _wipe_dir_contents(THUMBNAILS_DIR)
    _wipe_dir_contents(SPRITES_DIR)
    cache = DATA_DIR / "feed_meta_cache.json"
    cache.unlink(missing_ok=True)
    ensure_dirs()


def _wipe_dir_contents(root: Path) -> None:
    if not root.exists() or not root.is_dir():
        return
    for child in root.iterdir():
        try:
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
        except OSError:
            pass


def _video_count() -> int:
    with Session(engine) as session:
        return int(session.scalar(select(func.count(Video.id))) or 0)

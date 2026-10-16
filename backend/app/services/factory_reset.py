"""Factory reset: restore settings defaults and optionally wipe the library."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from sqlalchemy import delete
from sqlmodel import Session, col, func, select

from ..context import get_engine, get_paths
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
    UserSettings,
    UserVideoState,
    Video,
    VideoAiChatMessage,
    VideoAiMeta,
    VideoEmbedding,
)
from . import app_settings, scanner
from .downloads.queue import download_queue
from .video_delete import collect_video_files, remove_files

logger = logging.getLogger(__name__)

# Per-user UI preferences are settings, so they reset with the server defaults.
_ALWAYS_CLEAR_MODELS = (AiJob, OpenRouterUsage, DownloadJob, UserSettings)

_ERASE_MEDIA_MODELS = (
    VideoAiChatMessage,
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
    UserVideoState,
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
        download_queue.pause_all()
    except Exception:
        logger.warning(
            "factory reset: could not pause the download queue",
            exc_info=True,
        )
    try:
        app_settings.save({"ai": {"paused": True}})
    except app_settings.SettingsError:
        logger.warning("Could not pause AI before reset", exc_info=True)
    except Exception:
        logger.warning(
            "factory reset: could not pause AI",
            exc_info=True,
        )
    if not cancel_downloads:
        return
    try:
        with Session(get_engine()) as session:
            jobs = session.exec(
                select(DownloadJob).where(
                    col(DownloadJob.status).in_(
                        [JobStatus.queued, JobStatus.downloading]
                    )
                )
            ).all()
            ids = [job.id for job in jobs if job.id is not None]
        for job_id in ids:
            download_queue.cancel_job(job_id)
    except Exception:
        logger.warning(
            "factory reset: could not cancel active downloads",
            exc_info=True,
        )


def _resume_workers() -> None:
    try:
        download_queue.resume_all()
    except Exception:
        logger.warning(
            "factory reset: could not resume the download queue",
            exc_info=True,
        )
    try:
        from .ai.provider import invalidate_resolved_url
        from .ai.worker import wake_worker

        invalidate_resolved_url()
        wake_worker()
    except Exception:
        logger.warning(
            "factory reset: could not wake the AI worker",
            exc_info=True,
        )


def _erase_media() -> None:
    from ..context import get_engine
    from .compat_rendition import cancel_all

    cancel_all()

    with Session(get_engine()) as session:
        videos = session.exec(select(Video)).all()
        for video in videos:
            remove_files(collect_video_files(video, include_media=True))
    _wipe_dir_contents(get_paths().downloads)


def _delete_rows(models: tuple[type, ...]) -> None:
    with Session(get_engine()) as session:
        for model in models:
            session.execute(delete(model))
        session.commit()


def _wipe_chrome_assets() -> None:

    _wipe_dir_contents(get_paths().backgrounds)
    _wipe_dir_contents(get_paths().fonts)
    get_paths().ensure()


def _wipe_library_caches() -> None:

    _wipe_dir_contents(get_paths().thumbnails)
    _wipe_dir_contents(get_paths().sprites)
    cache = get_paths().data / "feed_meta_cache.json"
    cache.unlink(missing_ok=True)
    get_paths().ensure()


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
    with Session(get_engine()) as session:
        return int(session.scalar(select(func.count(col(Video.id)))) or 0)

"""The single way to delete a ``Video`` row and everything that belongs to it.

``delete_video_cascade`` removes dependent rows, then (only after the commit
succeeded) the files derived from the video: thumbnails, seek sprites, the
compat sidecar and subtitle files, plus the media file itself (and the
media-server ``.nfo`` / ``-thumb.jpg`` beside it) when asked.
Foreign keys cascade as well; the explicit deletes keep the behaviour correct
if a database is ever opened without ``PRAGMA foreign_keys=ON``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from sqlalchemy import delete, update
from sqlalchemy.orm import Mapped
from sqlmodel import Session, SQLModel, col

from ..context import get_paths
from ..models import (
    AiJob,
    DownloadJob,
    OpenRouterUsage,
    Playlist,
    PlaylistItem,
    RetentionKeep,
    UserVideoState,
    UserWatchTime,
    Video,
    VideoAiChatMessage,
    VideoAiMeta,
    VideoEmbedding,
)
from . import library, thumbnails
from .metadata import sprite_image_path, sprite_meta_path
from .paths import media_server_sidecar_paths, resolve_compat_path

logger = logging.getLogger(__name__)

# Child rows that only make sense together with their video.
_OWNED_ROW_COLUMNS: tuple[tuple[type[SQLModel], Mapped[Any]], ...] = (
    (VideoEmbedding, col(VideoEmbedding.video_id)),
    (VideoAiChatMessage, col(VideoAiChatMessage.video_id)),
    (VideoAiMeta, col(VideoAiMeta.video_id)),
    (PlaylistItem, col(PlaylistItem.video_id)),
    (AiJob, col(AiJob.video_id)),
    (UserVideoState, col(UserVideoState.video_id)),
    (RetentionKeep, col(RetentionKeep.video_id)),
)
# History / soft pointers that survive the video with the reference cleared.
_NULLED_REFERENCES: tuple[tuple[type[SQLModel], Mapped[Any]], ...] = (
    (DownloadJob, col(DownloadJob.video_id)),
    (DownloadJob, col(DownloadJob.replace_video_id)),
    (OpenRouterUsage, col(OpenRouterUsage.video_id)),
    (UserWatchTime, col(UserWatchTime.video_id)),
    (Playlist, col(Playlist.cover_video_id)),
)


def collect_video_files(video: Video, *, include_media: bool) -> list[Path]:
    """Files that belong to ``video``. Nothing is touched; see ``remove_files``."""
    paths: list[Path] = []
    if video.thumbnail_path:
        paths.append(Path(video.thumbnail_path))
    if video.sprite_path:
        paths.append(Path(video.sprite_path))
    if video.id is not None:
        paths.append(thumbnails.full_path(video.id))
        paths.append(thumbnails.list_path(video.id))
        paths.append(sprite_image_path(get_paths().sprites, video.id))
        paths.append(sprite_meta_path(get_paths().sprites, video.id))
    compat = resolve_compat_path(video)
    if compat is not None:
        paths.append(compat)
    for track in library.parse_subtitles(video.subtitles):
        sub = track.get("path")
        if sub:
            paths.append(get_paths().downloads / sub)
    if include_media and video.file_path:
        media = get_paths().downloads / video.file_path
        paths.append(media)
        # Written when media-server files are on; cleaned up with the media either way.
        paths.extend(media_server_sidecar_paths(media))
    return paths


def remove_files(paths: list[Path]) -> None:
    """Unlink files, but only inside the library (``DOWNLOADS_DIR`` / ``DATA_DIR``).

    A path that resolves outside both roots (``..`` segments, a symlink that
    escapes, a corrupt DB value) is skipped and logged, never deleted.
    """
    roots = [get_paths().downloads.resolve(), get_paths().data.resolve()]
    for path in paths:
        try:
            resolved = path.resolve()
        except OSError, RuntimeError:
            logger.warning("Not deleting unresolvable path %s", path, exc_info=True)
            continue
        if not any(resolved.is_relative_to(root) for root in roots):
            logger.warning("Not deleting %s: outside the library", path)
            continue
        if resolved in roots or resolved.is_dir():
            logger.warning("Not deleting %s: is a directory", path)
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not delete %s", path, exc_info=True)


def delete_video_cascade(
    session: Session,
    video: Video,
    delete_files: bool,
    *,
    commit: bool = True,
) -> list[Path]:
    """Delete ``video`` and everything hanging off it.

    With ``commit=True`` (the default) the transaction is committed and the
    files are removed afterwards; a failed commit leaves them in place. Batch
    callers pass ``commit=False``, commit once themselves and then call
    ``remove_files`` with the returned paths.
    """
    video_id = video.id
    files = collect_video_files(video, include_media=delete_files)
    if video_id is not None:
        for model, owner_column in _OWNED_ROW_COLUMNS:
            session.execute(delete(model).where(owner_column == video_id))
        for model, ref_column in _NULLED_REFERENCES:
            session.execute(
                update(model).where(ref_column == video_id).values({ref_column: None})
            )
    session.delete(video)
    if commit:
        session.commit()
        remove_files(files)
    return files

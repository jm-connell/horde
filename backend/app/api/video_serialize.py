"""Shared video response serialization helpers."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import HTTPException
from sqlmodel import Session

from ..config import DOWNLOADS_DIR, SPRITES_DIR
from ..models import Video, VideoAiMeta
from ..schemas import VideoRead
from ..services import library
from ..services.metadata import sprites_exist

def safe_filename(name: str) -> str:
    """Strip characters that break Content-Disposition or filesystems."""
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return cleaned or "video"


def as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Ensure datetimes are timezone-aware UTC so JSON includes a Z offset."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_read(video: Video, session: Optional[Session] = None) -> VideoRead:
    ai_tags: list[str] = []
    user_tags: list[str] = []
    ai_summary: Optional[str] = None
    ai_summary_length: Optional[str] = None
    ai_summary_cost: Optional[float] = None
    ai_summary_model: Optional[str] = None
    if session is not None and video.id is not None:
        meta = session.get(VideoAiMeta, video.id)
        if meta is not None:
            if meta.ai_tags:
                ai_tags = library.parse_tags(meta.ai_tags)
            if getattr(meta, "user_tags", None):
                user_tags = library.parse_tags(meta.user_tags)
            if meta.summary:
                ai_summary = meta.summary
            raw_len = getattr(meta, "summary_length", None)
            if raw_len and str(raw_len).strip().lower() in ("short", "medium", "long"):
                ai_summary_length = str(raw_len).strip().lower()
            raw_cost = getattr(meta, "summary_cost", None)
            if isinstance(raw_cost, (int, float)):
                ai_summary_cost = float(raw_cost)
            raw_model = getattr(meta, "summary_model", None)
            if raw_model and str(raw_model).strip():
                ai_summary_model = str(raw_model).strip()
    return VideoRead(
        id=video.id,
        title=video.title,
        channel=video.channel,
        channel_url=video.channel_url,
        tags=library.parse_tags(video.tags),
        ai_tags=ai_tags,
        user_tags=user_tags,
        description=video.description,
        notes=video.notes,
        source_url=video.source_url,
        has_thumbnail=bool(video.thumbnail_path and Path(video.thumbnail_path).exists()),
        has_sprites=bool(video.id is not None and sprites_exist(SPRITES_DIR, video.id)),
        subtitles=[
            {"lang": t.get("lang"), "auto": t.get("auto", False)}
            for t in library.parse_subtitles(video.subtitles)
        ],
        file_path=video.file_path,
        duration_sec=video.duration_sec,
        file_size=video.file_size,
        width_px=video.width_px,
        height_px=video.height_px,
        frame_rate=video.frame_rate,
        view_count=video.view_count,
        channel_subscriber_count=video.channel_subscriber_count,
        published_at=as_utc(video.published_at),
        added_at=as_utc(video.added_at) or video.added_at,
        last_position_sec=video.last_position_sec,
        last_watched_at=as_utc(video.last_watched_at),
        needs_review=video.needs_review,
        platform=video.platform,
        status=video.status,
        metadata_synced_at=as_utc(video.metadata_synced_at),
        source_title=video.source_title,
        title_is_custom=video.title_is_custom,
        subtitles_pending=video.subtitles_pending,
        ai_summary=ai_summary,
        ai_summary_length=ai_summary_length,
        ai_summary_cost=ai_summary_cost,
        ai_summary_model=ai_summary_model,
    )


def resolve_media(video: Video) -> Path:
    path = (DOWNLOADS_DIR / video.file_path).resolve()
    # Guard against path traversal escaping the downloads root.
    if DOWNLOADS_DIR not in path.parents and path != DOWNLOADS_DIR:
        raise HTTPException(status_code=400, detail="Invalid file path")
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    return path



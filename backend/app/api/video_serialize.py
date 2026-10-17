"""Shared video response serialization helpers."""

from __future__ import annotations

import os
import re
from collections.abc import Iterable, Mapping
from collections.abc import Set as AbstractSet
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session, col, select

from ..context import get_paths
from ..models import (
    AiJob,
    AiJobKind,
    AiJobStatus,
    UserVideoState,
    Video,
    VideoAiMeta,
    as_utc,
    require_id,
)
from ..schemas import (
    ChapterRead,
    CompatState,
    SearchMatchReason,
    SubtitleTrack,
    VideoRead,
)
from ..services import chapters as chapters_svc
from ..services import library, user_state
from ..services.auth.accounts import AuthUser
from ..services.metadata import sprites_exist
from . import member_view


def safe_filename(name: str) -> str:
    """Strip characters that break Content-Disposition or filesystems."""
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return cleaned or "video"


def _media_fields(video: Video, *, full: bool) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "vcodec": video.vcodec,
        "acodec": video.acodec,
        "codec_string": video.codec_string,
        "bit_depth": video.bit_depth,
        "is_hdr": bool(video.is_hdr),
        "has_compat": bool(video.compat_path),
        "compat_size": video.compat_size,
    }
    if full and video.id is not None:
        from ..services.compat_rendition import compat_status

        state = compat_status(video)
        fields["compat"] = CompatState(**state)
        fields["has_compat"] = state["status"] == "ready"
    return fields


def _has_sprites(video: Video, sprite_ids: AbstractSet[int] | None) -> bool:
    if video.id is None:
        return False
    if sprite_ids is not None:
        return video.id in sprite_ids
    return sprites_exist(get_paths().sprites, video.id)


def sprite_ids_on_disk() -> set[int]:
    """Ids that have a finished sprite sheet: one directory listing, not a stat per row."""
    try:
        names = {entry.name for entry in os.scandir(get_paths().sprites)}
    except FileNotFoundError:
        return set()
    return {
        int(name[:-4])
        for name in names
        if name.endswith(".jpg")
        and name[:-4].isdigit()
        and f"{name[:-4]}.json" in names
    }


def _watch_fields(
    video: Video,
    session: Session | None,
    user_id: int | None,
    states: Mapping[int, UserVideoState] | None,
) -> dict:
    """The caller's own resume position and last-watched time for ``video``."""
    state = None
    if video.id is not None and user_id is not None:
        if states is not None:
            state = states.get(video.id)
        elif session is not None:
            state = session.get(UserVideoState, (user_id, video.id))
    return {
        "last_position_sec": state.position_sec if state else 0.0,
        "last_watched_at": as_utc(state.last_watched_at) if state else None,
    }


def _load_metas(session: Session, rows: list[Video]) -> dict[int, VideoAiMeta]:
    ids = [v.id for v in rows if v.id is not None]
    found: dict[int, VideoAiMeta] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start : start + 500]
        for meta in session.exec(
            select(VideoAiMeta).where(col(VideoAiMeta.video_id).in_(chunk))
        ):
            found[meta.video_id] = meta
    return found


def to_read_many(
    videos: Iterable[Video],
    session: Session,
    *,
    viewer: AuthUser,
    states: Mapping[int, UserVideoState] | None = None,
    **kwargs,
) -> list[VideoRead]:
    """Serialize a list, reading the viewer's watch state for all of it in one query."""
    rows = list(videos)
    if not kwargs.get("compact"):
        # Everything a full payload reads per video, fetched once for the page.
        kwargs.setdefault("metas", _load_metas(session, rows))
        kwargs.setdefault("sprite_ids", sprite_ids_on_disk())
    if states is None:
        states = user_state.get_states(session, viewer.id, (v.id for v in rows if v.id))
    return [to_read(v, session, viewer=viewer, states=states, **kwargs) for v in rows]


def to_read(
    video: Video,
    session: Session | None = None,
    *,
    viewer: AuthUser,
    states: Mapping[int, UserVideoState] | None = None,
    include_processing: bool = False,
    match_reason: dict | None = None,
    compact: bool = False,
    metas: Mapping[int, VideoAiMeta] | None = None,
    sprite_ids: AbstractSet[int] | None = None,
) -> VideoRead:
    """Serialize ``video`` for ``viewer`` (their history; the rest is shared).

    ``viewer`` has no default on purpose: forgetting it would silently show
    nobody's history, or show a member what only an administrator may see
    (``member_view.video``). Pass ``states``, ``metas`` and ``sprite_ids`` (see
    ``to_read_many``) when serializing a list, so no row costs its own query or stat.
    """
    read = _to_read(
        video,
        session,
        user_id=viewer.id,
        states=states,
        include_processing=include_processing,
        match_reason=match_reason,
        compact=compact,
        metas=metas,
        sprite_ids=sprite_ids,
    )
    return read if viewer.is_admin else member_view.video(read)


def _to_read(
    video: Video,
    session: Session | None,
    *,
    user_id: int,
    states: Mapping[int, UserVideoState] | None,
    include_processing: bool,
    match_reason: dict | None,
    compact: bool,
    metas: Mapping[int, VideoAiMeta] | None,
    sprite_ids: AbstractSet[int] | None,
) -> VideoRead:
    reason = (
        SearchMatchReason.model_validate(match_reason)
        if match_reason is not None
        else None
    )
    watch = _watch_fields(video, session, user_id, states)
    if compact:
        return VideoRead(
            id=require_id(video),
            title=video.title,
            channel=video.channel,
            channel_url=video.channel_url,
            tags=library.parse_tags(video.tags),
            description=None,
            notes=None,
            source_url=video.source_url,
            # No Path.exists()/stat() here — list views only need "is one set".
            has_thumbnail=bool(video.thumbnail_path),
            subtitles=[],
            file_path=video.file_path,
            duration_sec=video.duration_sec,
            file_size=video.file_size,
            width_px=video.width_px,
            height_px=video.height_px,
            frame_rate=video.frame_rate,
            **_media_fields(video, full=False),
            view_count=video.view_count,
            channel_subscriber_count=video.channel_subscriber_count,
            published_at=as_utc(video.published_at),
            added_at=as_utc(video.added_at) or video.added_at,
            **watch,
            needs_review=video.needs_review,
            platform=video.platform,
            status=video.status,
            metadata_synced_at=as_utc(video.metadata_synced_at),
            source_title=video.source_title,
            source_description=None,
            title_is_custom=video.title_is_custom,
            description_is_custom=video.description_is_custom,
            subtitles_pending=video.subtitles_pending,
            match_reason=reason,
        )
    ai_tags: list[str] = []
    user_tags: list[str] = []
    ai_summary: str | None = None
    ai_summary_length: str | None = None
    ai_summary_cost: float | None = None
    ai_summary_model: str | None = None
    embed_status: str | None = None
    embed_error: str | None = None
    tags_enriched_at = None
    processing_summary = False
    processing_sprites = False
    processing_chapters = False
    resolved_chapters: list[ChapterRead] = []
    chapters_source = None
    meta = None
    if session is not None and video.id is not None:
        meta = (
            metas.get(video.id)
            if metas is not None
            else session.get(VideoAiMeta, video.id)
        )
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
            embed_status = str(meta.embed_status or "") or None
            raw_err = getattr(meta, "embed_error", None)
            if raw_err and str(raw_err).strip():
                embed_error = str(raw_err).strip()[:500]
            tags_enriched_at = as_utc(getattr(meta, "tags_enriched_at", None))
        if include_processing:
            from ..services.sprites import sprites_in_progress

            processing_sprites = sprites_in_progress(video.id)
            summary_job = session.exec(
                select(AiJob).where(
                    AiJob.video_id == video.id,
                    AiJob.kind == AiJobKind.summarize,
                    col(AiJob.status).in_([AiJobStatus.queued, AiJobStatus.running]),
                )
            ).first()
            processing_summary = summary_job is not None
            chapter_job = session.exec(
                select(AiJob).where(
                    AiJob.video_id == video.id,
                    AiJob.kind == AiJobKind.chapters,
                    col(AiJob.status).in_([AiJobStatus.queued, AiJobStatus.running]),
                )
            ).first()
            processing_chapters = chapter_job is not None
    resolved, source = chapters_svc.resolve_chapters(video, meta)
    resolved_chapters = [
        ChapterRead(start_sec=c["start_sec"], title=c["title"]) for c in resolved
    ]
    chapters_source = source
    return VideoRead(
        id=require_id(video),
        title=video.title,
        channel=video.channel,
        channel_url=video.channel_url,
        tags=library.parse_tags(video.tags),
        ai_tags=ai_tags,
        user_tags=user_tags,
        description=video.description,
        notes=video.notes,
        source_url=video.source_url,
        has_thumbnail=bool(video.thumbnail_path),
        has_sprites=_has_sprites(video, sprite_ids),
        subtitles=[
            SubtitleTrack.model_validate(
                {"lang": t.get("lang"), "auto": t.get("auto", False)}
            )
            for t in library.parse_subtitles(video.subtitles)
        ],
        file_path=video.file_path,
        duration_sec=video.duration_sec,
        file_size=video.file_size,
        width_px=video.width_px,
        height_px=video.height_px,
        frame_rate=video.frame_rate,
        **_media_fields(video, full=True),
        view_count=video.view_count,
        channel_subscriber_count=video.channel_subscriber_count,
        published_at=as_utc(video.published_at),
        added_at=as_utc(video.added_at) or video.added_at,
        **watch,
        needs_review=video.needs_review,
        platform=video.platform,
        status=video.status,
        metadata_synced_at=as_utc(video.metadata_synced_at),
        source_title=video.source_title,
        source_description=video.source_description,
        title_is_custom=video.title_is_custom,
        description_is_custom=video.description_is_custom,
        subtitles_pending=video.subtitles_pending,
        ai_summary=ai_summary,
        ai_summary_length=ai_summary_length,
        ai_summary_cost=ai_summary_cost,
        ai_summary_model=ai_summary_model,
        embed_status=embed_status,
        embed_error=embed_error,
        tags_enriched_at=tags_enriched_at,
        processing_summary=processing_summary,
        processing_sprites=processing_sprites,
        processing_chapters=processing_chapters,
        chapters=resolved_chapters,
        chapters_source=chapters_source,
        match_reason=reason,
    )


def resolve_media(video: Video) -> Path:
    path = (get_paths().downloads / video.file_path).resolve()
    # Guard against path traversal escaping the downloads root.
    if get_paths().downloads not in path.parents and path != get_paths().downloads:
        raise HTTPException(status_code=400, detail="Invalid file path")
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    return path

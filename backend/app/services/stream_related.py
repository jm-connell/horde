"""Related videos for a streamed (not downloaded) video.

A library video's related list (``library.related_videos``) only holds library
videos. A stream's mixes library videos with indexed-but-not-downloaded catalog
videos, each marked with whether it is in the library:

1. nearest neighbours of the stream's embedding (its catalog embedding when the
   channel is indexed, else its title and description embedded on the fly),
   over both library and catalog embeddings;
2. then the same channel: library videos, then catalog videos.

A live stream first lists the channel's other broadcasts that are live now, so
a tournament's A and B streams sit side by side (``live_now_on_channel``).
"""

from __future__ import annotations

import logging
from typing import Any

from sqlmodel import Session, col, select

from ..models import ChannelCatalogVideo, Video, as_utc, require_id
from ..schemas import ChannelFeedEntry
from . import app_settings, library, ytdlp_extract
from .ai import embeddings as ai_embeddings
from .ai.provider import get_embed_provider
from .channel_catalog import query as catalog_query
from .channel_catalog import skipped_yt_ids

logger = logging.getLogger(__name__)

_LIBRARY_MIN_SCORE = 0.2
_CATALOG_MIN_SCORE = 0.35
_QUERY_DESCRIPTION_CHARS = 1000
# Live broadcasts sit at the top of a channel's streams tab; a few rows is enough.
_LIVE_SCAN = 10


def _query_vector(
    session: Session, youtube_id: str, meta: dict[str, Any], *, may_embed: bool
) -> list[float] | None:
    if get_embed_provider() is None or app_settings.ai_settings().get("paused"):
        return None
    stored = catalog_query.catalog_vector_for(session, youtube_id)
    if stored is not None:
        return stored
    if not may_embed:
        return None
    text = "\n".join(
        part
        for part in (
            str(meta.get("title") or "").strip(),
            str(meta.get("channel") or "").strip(),
            str(meta.get("description") or "").strip()[:_QUERY_DESCRIPTION_CHARS],
        )
        if part
    )
    return ai_embeddings.embed_query(text) if text else None


def _library_entry(video: Video) -> ChannelFeedEntry:
    published = as_utc(video.published_at)
    return ChannelFeedEntry(
        id=video.youtube_id,
        url=video.source_url or "",
        title=video.title,
        duration=video.duration_sec,
        view_count=video.view_count,
        published_at=published.isoformat() if published else None,
        channel=video.channel,
        in_library=True,
        video_id=require_id(video),
        library_height_px=video.height_px,
    )


class _LibraryIds:
    """``yt_id -> (video id, height)`` for library videos, one lookup per id."""

    def __init__(self, session: Session) -> None:
        self._session = session
        self._known: dict[str, tuple[int, int | None] | None] = {}

    def get(self, yt_id: str) -> tuple[int, int | None] | None:
        if yt_id not in self._known:
            video = library.find_video_by_youtube_id(self._session, yt_id)
            self._known[yt_id] = (
                (require_id(video), video.height_px) if video is not None else None
            )
        return self._known[yt_id]


def _catalog_entry(
    video: ChannelCatalogVideo,
    channel_name: str | None,
    lib_map: _LibraryIds,
) -> ChannelFeedEntry:
    lib = lib_map.get(video.yt_id)
    return ChannelFeedEntry(
        id=video.yt_id,
        url=video.url,
        title=video.title,
        duration=video.duration,
        thumbnail_url=video.thumbnail_url,
        view_count=video.view_count,
        published_at=video.published_at,
        channel=channel_name,
        in_library=lib is not None,
        video_id=lib[0] if lib else None,
        library_height_px=lib[1] if lib else None,
    )


class _Collector:
    """Ordered, de-duplicated entries (by YouTube id, else library id)."""

    def __init__(self, limit: int, exclude_yt_id: str) -> None:
        self.limit = limit
        self.items: list[ChannelFeedEntry] = []
        self._seen: set[str] = {f"yt:{exclude_yt_id}"}

    @property
    def full(self) -> bool:
        return len(self.items) >= self.limit

    def add(self, entry: ChannelFeedEntry) -> None:
        if self.full:
            return
        keys = set()
        if entry.id:
            keys.add(f"yt:{entry.id}")
        if entry.video_id is not None:
            keys.add(f"lib:{entry.video_id}")
        if not keys or keys & self._seen:
            return
        self._seen |= keys
        self.items.append(entry)


def live_now_on_channel(channel_url: str) -> list[ChannelFeedEntry]:
    """The broadcasts live now on a channel, read from its streams tab (yt-dlp)."""
    try:
        feed = ytdlp_extract.fetch_channel_feed(
            channel_url, limit=_LIVE_SCAN, tab="streams"
        )
    except Exception:
        logger.warning("stream related: streams tab unreadable", exc_info=True)
        return []
    return [
        ChannelFeedEntry.model_validate(entry)
        for entry in feed.get("entries") or []
        if entry.get("live_status") == "is_live"
    ]


def related_for_stream(
    session: Session,
    youtube_id: str,
    meta: dict[str, Any],
    *,
    limit: int = 24,
    may_embed: bool = True,
    live_now: list[ChannelFeedEntry] | None = None,
) -> list[ChannelFeedEntry]:
    """Up to ``limit`` related videos for the stream ``youtube_id``.

    ``meta`` is the stream's preview metadata (title, channel, channel_url,
    description). ``may_embed`` allows one embedding call when the stream has no
    stored embedding (the caller may use AI). ``live_now`` (the channel's live
    broadcasts, for a live stream) goes first.
    """
    out = _Collector(limit, youtube_id)
    lib_map = _LibraryIds(session)
    for entry in live_now or []:
        out.add(entry)
    skipped_by_catalog: dict[int, set[str]] = {}

    def visible(video: ChannelCatalogVideo) -> bool:
        skipped = skipped_by_catalog.get(video.catalog_id)
        if skipped is None:
            skipped = skipped_yt_ids(session, video.catalog_id)
            skipped_by_catalog[video.catalog_id] = skipped
        return not catalog_query.is_hidden_catalog_video(video, skipped)

    try:
        vec = _query_vector(session, youtube_id, meta, may_embed=may_embed)
    except Exception:
        logger.warning("stream related: no query vector", exc_info=True)
        vec = None
    if vec is not None:
        scored: list[tuple[float, ChannelFeedEntry]] = []
        try:
            hits = ai_embeddings.similar_video_ids(
                session, vec, limit=limit * 2, min_score=_LIBRARY_MIN_SCORE
            )
        except Exception:
            logger.warning("stream related: library search failed", exc_info=True)
            hits = []
        videos = {
            require_id(v): v
            for v in session.exec(
                select(Video).where(
                    col(Video.id).in_([vid for vid, _ in hits]),
                    Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
                )
            ).all()
        }
        for vid, score in hits:
            if vid in videos:
                scored.append((score, _library_entry(videos[vid])))
        try:
            catalog_hits = catalog_query.catalog_hits_for_vector(
                session,
                vec,
                limit=limit * 2,
                exclude_yt_ids={youtube_id},
                min_score=_CATALOG_MIN_SCORE,
            )
        except Exception:
            logger.warning("stream related: catalog search failed", exc_info=True)
            catalog_hits = []
        for score, video, channel_name in catalog_hits:
            if visible(video):
                scored.append((score, _catalog_entry(video, channel_name, lib_map)))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        for _score, entry in scored:
            out.add(entry)

    channel = str(meta.get("channel") or "").strip()
    if channel and not out.full:
        for lib_video in session.exec(
            select(Video)
            .where(
                col(Video.channel) == channel,
                Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
            )
            .order_by(col(Video.published_at).desc(), col(Video.id).desc())
            .limit(limit)
        ).all():
            out.add(_library_entry(lib_video))
    channel_url = str(meta.get("channel_url") or "").strip()
    if channel_url and not out.full:
        rows, channel_name = catalog_query.visible_channel_videos(
            session, channel_url, limit=limit, exclude_yt_ids={youtube_id}
        )
        for row in rows:
            out.add(_catalog_entry(row, channel_name or channel or None, lib_map))
    return out.items

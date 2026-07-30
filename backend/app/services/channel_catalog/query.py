"""Catalog progress, feed pages, and search."""

from __future__ import annotations

import logging
from typing import Any, Optional

from sqlmodel import Session, col, func, or_, select

from ...database import engine
from ...models import (
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
)
from .. import feed_meta_cache
from ..ytdlp_common import is_members_only_entry
from .runtime import (
    _normalize_channel_url,
    get_catalog_by_url,
    get_runtime_status,
)
from .skips import skipped_yt_ids

logger = logging.getLogger(__name__)


def catalog_progress(
    session: Session, channel_url: str
) -> dict[str, Any]:
    """Indexed/total/complete/status for a channel URL (empty defaults if none)."""
    catalog = get_catalog_by_url(session, channel_url)
    if catalog is None:
        return {
            "catalog_indexed": 0,
            "catalog_total": None,
            "catalog_complete": False,
            "catalog_status": None,
            "indexing": False,
        }
    status = (
        catalog.status.value if hasattr(catalog.status, "value") else str(catalog.status)
    )
    return {
        "catalog_indexed": catalog.indexed_count,
        "catalog_total": catalog.channel_total,
        "catalog_complete": bool(catalog.complete),
        "catalog_status": status,
        "indexing": status in ("queued", "indexing"),
    }


def update_catalog_view_counts(
    channel_url: str, updates: list[tuple[str, int]]
) -> None:
    """Persist enriched view counts onto catalog rows when present."""
    if not updates:
        return
    url = _normalize_channel_url(channel_url)
    with Session(engine) as session:
        catalog = get_catalog_by_url(session, url)
        if catalog is None or catalog.id is None:
            return
        by_id = {yt_id: views for yt_id, views in updates}
        rows = session.exec(
            select(ChannelCatalogVideo).where(
                ChannelCatalogVideo.catalog_id == catalog.id,
                col(ChannelCatalogVideo.yt_id).in_(list(by_id.keys())),
            )
        ).all()
        changed = False
        for row in rows:
            views = by_id.get(row.yt_id)
            if views is None:
                continue
            if row.view_count != views:
                row.view_count = views
                session.add(row)
                changed = True
        if changed:
            session.commit()


def catalog_feed_page(
    session: Session,
    channel_url: str,
    *,
    offset: int = 0,
    limit: int = 30,
) -> Optional[dict[str, Any]]:
    """Return a feed page from the local catalog, or None if not usable yet."""
    catalog = get_catalog_by_url(session, channel_url)
    if catalog is None:
        return None
    if catalog.status not in (
        ChannelCatalogStatus.ready,
        ChannelCatalogStatus.indexing,
        ChannelCatalogStatus.error,
    ):
        return None
    total = session.exec(
        select(func.count(ChannelCatalogVideo.id)).where(
            ChannelCatalogVideo.catalog_id == catalog.id
        )
    ).one()
    total_n = int(total or 0)
    if total_n == 0:
        return None
    skipped = skipped_yt_ids(session, catalog.id)  # type: ignore[arg-type]
    rows = session.exec(
        select(ChannelCatalogVideo)
        .where(ChannelCatalogVideo.catalog_id == catalog.id)
        .order_by(ChannelCatalogVideo.position.asc())
        .offset(offset)
        .limit(limit)
    ).all()
    entries = [
        {
            "id": r.yt_id,
            "url": r.url,
            "title": r.title,
            "duration": r.duration,
            "thumbnail_url": r.thumbnail_url,
            "view_count": r.view_count,
            "published_at": r.published_at,
        }
        for r in rows
        if r.yt_id not in skipped
        and not is_members_only_entry({"title": r.title})
    ]
    return {
        "channel": catalog.channel_name,
        "channel_url": catalog.channel_url,
        "entries": entries,
        "has_more": offset + len(entries) < total_n,
        "indexing": catalog.status == ChannelCatalogStatus.indexing,
        "from_catalog": True,
        "catalog_indexed": catalog.indexed_count,
        "catalog_total": catalog.channel_total,
        "catalog_complete": bool(catalog.complete),
        "catalog_status": (
            catalog.status.value if hasattr(catalog.status, "value") else str(catalog.status)
        ),
    }


_EMBED_SEARCH_ROW_CEILING = 20_000


def _catalog_entry_dict(
    video: ChannelCatalogVideo,
    *,
    channel_name: Optional[str] = None,
) -> dict[str, Any]:
    return {
        "id": video.yt_id,
        "url": video.url,
        "title": video.title,
        "duration": video.duration,
        "thumbnail_url": video.thumbnail_url,
        "view_count": video.view_count,
        "published_at": video.published_at,
        "channel": channel_name,
    }


def search_catalog(
    session: Session,
    channel_url: str,
    query: str,
    *,
    limit: int = 60,
) -> list[dict[str, Any]]:
    catalog = get_catalog_by_url(session, channel_url)
    if catalog is None or catalog.id is None:
        return []
    q = query.strip()
    if not q:
        return []
    pattern = f"%{q}%"
    rows = session.exec(
        select(ChannelCatalogVideo)
        .where(ChannelCatalogVideo.catalog_id == catalog.id)
        .where(
            or_(
                col(ChannelCatalogVideo.title).ilike(pattern),
                col(ChannelCatalogVideo.description).ilike(pattern),
            )
        )
        .order_by(ChannelCatalogVideo.position.asc())
        .limit(limit)
    ).all()

    # Hybrid: boost with embedding similarity when available.
    semantic_extra: list[ChannelCatalogVideo] = []
    try:
        from ..ai import embeddings as emb_mod
        from ..ai.provider import get_embed_provider, resolve_embed_model

        provider = get_embed_provider()
        if provider is not None:
            model = resolve_embed_model(provider)
            query_vec = provider.embed(q, model)
            emb_rows = session.exec(select(ChannelCatalogEmbedding)).all()
            scored: list[tuple[float, ChannelCatalogVideo]] = []
            for emb in emb_rows:
                video = session.get(ChannelCatalogVideo, emb.catalog_video_id)
                if video is None or video.catalog_id != catalog.id:
                    continue
                vec = emb_mod.unpack_vector(emb.vector, emb.dim)
                score = emb_mod.cosine(query_vec, vec)
                if score >= 0.35:
                    scored.append((score, video))
            scored.sort(key=lambda x: x[0], reverse=True)
            semantic_extra = [v for _, v in scored[:limit]]
    except Exception:  # noqa: BLE001
        semantic_extra = []

    # Preserve keyword order first, then semantic extras.
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    channel_name = catalog.channel_name
    skipped = skipped_yt_ids(session, catalog.id)
    for r in list(rows) + semantic_extra:
        if r.yt_id in seen:
            continue
        if r.yt_id in skipped or is_members_only_entry({"title": r.title}):
            continue
        seen.add(r.yt_id)
        out.append(_catalog_entry_dict(r, channel_name=channel_name))
        if len(out) >= limit:
            break
    return out


def search_all_catalogs(
    session: Session,
    query: str,
    *,
    limit: int = 40,
) -> list[dict[str, Any]]:
    """Search indexed channel catalogs across all channels (keyword + optional embeddings)."""
    q = query.strip()
    if not q:
        return []
    pattern = f"%{q}%"
    rows = session.exec(
        select(ChannelCatalogVideo, ChannelCatalog)
        .join(
            ChannelCatalog,
            ChannelCatalogVideo.catalog_id == ChannelCatalog.id,  # type: ignore[arg-type]
        )
        .where(
            or_(
                col(ChannelCatalogVideo.title).ilike(pattern),
                col(ChannelCatalogVideo.description).ilike(pattern),
            )
        )
        .order_by(ChannelCatalogVideo.position.asc())
        .limit(limit)
    ).all()

    keyword_hits: list[tuple[ChannelCatalogVideo, Optional[str]]] = []
    for row in rows:
        if isinstance(row, tuple) and len(row) >= 2:
            video, catalog = row[0], row[1]
            keyword_hits.append((video, getattr(catalog, "channel_name", None)))
        else:
            keyword_hits.append((row, None))  # type: ignore[arg-type]

    semantic_extra: list[tuple[ChannelCatalogVideo, Optional[str]]] = []
    try:
        emb_count = session.exec(
            select(func.count()).select_from(ChannelCatalogEmbedding)  # type: ignore[arg-type]
        ).one()
        if int(emb_count or 0) <= _EMBED_SEARCH_ROW_CEILING:
            from ..ai import embeddings as emb_mod
            from ..ai.provider import get_embed_provider, resolve_embed_model

            provider = get_embed_provider()
            if provider is not None:
                model = resolve_embed_model(provider)
                query_vec = provider.embed(q, model)
                emb_rows = session.exec(select(ChannelCatalogEmbedding)).all()
                scored: list[tuple[float, ChannelCatalogVideo, Optional[str]]] = []
                for emb in emb_rows:
                    video = session.get(ChannelCatalogVideo, emb.catalog_video_id)
                    if video is None:
                        continue
                    catalog = session.get(ChannelCatalog, video.catalog_id)
                    vec = emb_mod.unpack_vector(emb.vector, emb.dim)
                    score = emb_mod.cosine(query_vec, vec)
                    if score >= 0.35:
                        scored.append(
                            (
                                score,
                                video,
                                catalog.channel_name if catalog else None,
                            )
                        )
                scored.sort(key=lambda x: x[0], reverse=True)
                semantic_extra = [(v, ch) for _, v, ch in scored[:limit]]
    except Exception:  # noqa: BLE001
        semantic_extra = []

    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    # Preload skips for catalogs we might hit.
    skip_by_catalog: dict[int, set[str]] = {}
    for video, channel_name in keyword_hits + semantic_extra:
        if video.yt_id in seen:
            continue
        cat_skips = skip_by_catalog.get(video.catalog_id)
        if cat_skips is None:
            cat_skips = skipped_yt_ids(session, video.catalog_id)
            skip_by_catalog[video.catalog_id] = cat_skips
        if video.yt_id in cat_skips or is_members_only_entry({"title": video.title}):
            continue
        seen.add(video.yt_id)
        out.append(_catalog_entry_dict(video, channel_name=channel_name))
        if len(out) >= limit:
            break
    return out



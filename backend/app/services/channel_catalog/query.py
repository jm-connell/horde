"""Catalog progress, feed pages, and search."""

from __future__ import annotations

from typing import Any, Optional

from sqlmodel import Session, col, func, select

from ...database import engine
from ...models import (
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
)
from ..feed_meta_cache import parse_upload_date
from ..search_text import (
    explain_match,
    keyword_match_clause,
    keyword_rank_key,
    query_allows_semantic,
)
from ..ytdlp_common import is_members_only_entry
from .runtime import (
    _normalize_channel_url,
    get_catalog_by_url,
)
from .skips import skipped_yt_ids


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


def update_catalog_video_fields(
    channel_url: str, updates: list[dict[str, Any]]
) -> None:
    """Persist enriched metadata onto existing catalog rows (no inserts)."""
    if not updates:
        return
    by_id: dict[str, dict[str, Any]] = {}
    for item in updates:
        yt_id = item.get("id")
        if not yt_id or not isinstance(yt_id, str):
            continue
        by_id[yt_id] = item
    if not by_id:
        return
    url = _normalize_channel_url(channel_url)
    with Session(engine) as session:
        catalog = get_catalog_by_url(session, url)
        if catalog is None or catalog.id is None:
            return
        rows = session.exec(
            select(ChannelCatalogVideo).where(
                ChannelCatalogVideo.catalog_id == catalog.id,
                col(ChannelCatalogVideo.yt_id).in_(list(by_id.keys())),
            )
        ).all()
        any_changed = False
        for row in rows:
            item = by_id.get(row.yt_id)
            if not item:
                continue
            row_changed = False
            views = item.get("view_count")
            if views is not None:
                try:
                    views_i = int(views)
                except (TypeError, ValueError):
                    views_i = None
                if views_i is not None and row.view_count != views_i:
                    row.view_count = views_i
                    row_changed = True
            published = parse_upload_date(item.get("published_at"))
            if published and not row.published_at and not item.get("published_label"):
                row.published_at = published
                row_changed = True
            duration = item.get("duration")
            if duration is not None and row.duration is None:
                row.duration = duration
                row_changed = True
            thumb = item.get("thumbnail_url")
            if thumb and not row.thumbnail_url:
                row.thumbnail_url = str(thumb)
                row_changed = True
            if row_changed:
                session.add(row)
                any_changed = True
        if any_changed:
            session.commit()


def update_catalog_view_counts(
    channel_url: str, updates: list[tuple[str, int]]
) -> None:
    """Persist enriched view counts onto catalog rows when present."""
    update_catalog_video_fields(
        channel_url,
        [{"id": yt_id, "view_count": views} for yt_id, views in updates],
    )


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
_CATALOG_EMBED_MIN_SCORE = 0.35
_KEYWORD_FETCH_CAP = 500


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


def _keyword_fetch_limit(limit: int) -> int:
    return min(max(limit * 4, 200), _KEYWORD_FETCH_CAP)


def _is_hidden_catalog_video(video: ChannelCatalogVideo, skipped: set[str]) -> bool:
    return video.yt_id in skipped or is_members_only_entry({"title": video.title})


def _keyword_catalog_rows(
    session: Session,
    query: str,
    *,
    catalog_id: Optional[int] = None,
    limit: int,
) -> list[tuple[ChannelCatalogVideo, Optional[str]]]:
    clause = keyword_match_clause(
        query,
        col(ChannelCatalogVideo.title),
        col(ChannelCatalogVideo.description),
    )
    if clause is None:
        return []
    fetch_n = _keyword_fetch_limit(limit)
    if catalog_id is not None:
        rows = session.exec(
            select(ChannelCatalogVideo)
            .where(ChannelCatalogVideo.catalog_id == catalog_id)
            .where(clause)
            .order_by(ChannelCatalogVideo.position.asc())
            .limit(fetch_n)
        ).all()
        ranked = sorted(
            rows,
            key=lambda r: keyword_rank_key(
                r.title, r.description, query, r.position
            ),
        )
        return [(r, None) for r in ranked[:limit]]

    rows = session.exec(
        select(ChannelCatalogVideo, ChannelCatalog)
        .join(
            ChannelCatalog,
            ChannelCatalogVideo.catalog_id == ChannelCatalog.id,  # type: ignore[arg-type]
        )
        .where(clause)
        .order_by(ChannelCatalogVideo.position.asc())
        .limit(fetch_n)
    ).all()
    paired: list[tuple[ChannelCatalogVideo, Optional[str]]] = []
    for row in rows:
        video, catalog = row[0], row[1]
        paired.append((video, getattr(catalog, "channel_name", None)))
    paired.sort(
        key=lambda item: keyword_rank_key(
            item[0].title, item[0].description, query, item[0].position
        )
    )
    return paired[:limit]


def _semantic_catalog_hits(
    session: Session,
    query: str,
    *,
    catalog_id: Optional[int] = None,
    limit: int,
) -> list[tuple[float, ChannelCatalogVideo, Optional[str]]]:
    try:
        from ..ai import embeddings as emb_mod

        query_vec = emb_mod.embed_query(query)
        if query_vec is None:
            return []
        if catalog_id is None:
            emb_count = session.exec(
                select(func.count()).select_from(ChannelCatalogEmbedding)  # type: ignore[arg-type]
            ).one()
            if int(emb_count or 0) > _EMBED_SEARCH_ROW_CEILING:
                return []
        stmt = (
            select(ChannelCatalogEmbedding, ChannelCatalogVideo, ChannelCatalog)
            .join(
                ChannelCatalogVideo,
                ChannelCatalogEmbedding.catalog_video_id == ChannelCatalogVideo.id,  # type: ignore[arg-type]
            )
            .join(
                ChannelCatalog,
                ChannelCatalogVideo.catalog_id == ChannelCatalog.id,  # type: ignore[arg-type]
            )
        )
        if catalog_id is not None:
            stmt = stmt.where(ChannelCatalogVideo.catalog_id == catalog_id)
        scored: list[tuple[float, ChannelCatalogVideo, Optional[str]]] = []
        for row in session.exec(stmt).all():
            emb, video, catalog = row[0], row[1], row[2]
            vec = emb_mod.unpack_vector(emb.vector, emb.dim)
            score = emb_mod.cosine(query_vec, vec)
            if score >= _CATALOG_EMBED_MIN_SCORE:
                scored.append(
                    (
                        score,
                        video,
                        catalog.channel_name if catalog else None,
                    )
                )
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[:limit]
    except Exception:  # noqa: BLE001
        return []


def _fuse_catalog_hits(
    keyword_hits: list[tuple[ChannelCatalogVideo, Optional[str]]],
    semantic_hits: list[tuple[float, ChannelCatalogVideo, Optional[str]]],
    *,
    skipped: set[str],
    skip_by_catalog: Optional[dict[int, set[str]]] = None,
    limit: int,
    keyword_ids: Optional[set[str]] = None,
    query: str = "",
) -> list[dict[str, Any]]:
    by_id: dict[str, tuple[ChannelCatalogVideo, Optional[str]]] = {}
    scores: dict[str, float] = {}

    def hidden(video: ChannelCatalogVideo) -> bool:
        if skip_by_catalog is not None:
            cat_skips = skip_by_catalog.get(video.catalog_id)
            if cat_skips is None:
                cat_skips = skipped
            return _is_hidden_catalog_video(video, cat_skips)
        return _is_hidden_catalog_video(video, skipped)

    for score, video, channel_name in semantic_hits:
        if hidden(video):
            continue
        by_id[video.yt_id] = (video, channel_name)
        scores[video.yt_id] = float(score)

    for i, (video, channel_name) in enumerate(keyword_hits):
        if hidden(video):
            continue
        by_id[video.yt_id] = (video, channel_name)
        boost = 1.0 - (i * 0.002)
        scores[video.yt_id] = max(scores.get(video.yt_id, 0.0), 0.55) + boost

    ranked_ids = sorted(scores.keys(), key=lambda i: scores[i], reverse=True)
    kw_ids = keyword_ids or set()
    out: list[dict[str, Any]] = []
    for yt_id in ranked_ids:
        video, channel_name = by_id[yt_id]
        entry = _catalog_entry_dict(video, channel_name=channel_name)
        if query:
            entry["match_reason"] = explain_match(
                query,
                title=video.title,
                description=video.description,
                allow_related=yt_id not in kw_ids,
            )
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def search_catalog(
    session: Session,
    channel_url: str,
    query: str,
    *,
    limit: int = 60,
    semantic: bool = True,
) -> list[dict[str, Any]]:
    catalog = get_catalog_by_url(session, channel_url)
    if catalog is None or catalog.id is None:
        return []
    q = query.strip()
    if not q:
        return []
    keyword_hits = [
        (video, catalog.channel_name)
        for video, _ in _keyword_catalog_rows(
            session, q, catalog_id=catalog.id, limit=limit
        )
    ]
    skipped = skipped_yt_ids(session, catalog.id)
    semantic_hits: list[tuple[float, ChannelCatalogVideo, Optional[str]]] = []
    if semantic and query_allows_semantic(q):
        semantic_hits = [
            (score, video, catalog.channel_name)
            for score, video, _ in _semantic_catalog_hits(
                session, q, catalog_id=catalog.id, limit=limit
            )
        ]
    return _fuse_catalog_hits(
        keyword_hits,
        semantic_hits,
        skipped=skipped,
        limit=limit,
        keyword_ids={v.yt_id for v, _ in keyword_hits},
        query=q,
    )


def search_all_catalogs(
    session: Session,
    query: str,
    *,
    limit: int = 40,
    semantic: bool = True,
) -> list[dict[str, Any]]:
    """Search indexed channel catalogs across all channels (keyword + optional embeddings)."""
    q = query.strip()
    if not q:
        return []
    keyword_hits = _keyword_catalog_rows(session, q, limit=limit)
    semantic_hits: list[tuple[float, ChannelCatalogVideo, Optional[str]]] = []
    if semantic and query_allows_semantic(q):
        semantic_hits = _semantic_catalog_hits(session, q, limit=limit)
    skip_by_catalog: dict[int, set[str]] = {}
    for video, _ in keyword_hits:
        if video.catalog_id not in skip_by_catalog:
            skip_by_catalog[video.catalog_id] = skipped_yt_ids(
                session, video.catalog_id
            )
    for _, video, _ in semantic_hits:
        if video.catalog_id not in skip_by_catalog:
            skip_by_catalog[video.catalog_id] = skipped_yt_ids(
                session, video.catalog_id
            )
    return _fuse_catalog_hits(
        keyword_hits,
        semantic_hits,
        skipped=set(),
        skip_by_catalog=skip_by_catalog,
        limit=limit,
        keyword_ids={v.yt_id for v, _ in keyword_hits},
        query=q,
    )



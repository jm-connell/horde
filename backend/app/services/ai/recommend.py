"""Homepage recommendations and category browse."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from sqlmodel import Session, select

from ...models import AiCategory, Video
from .. import app_settings, library
from . import embeddings
from .provider import get_provider

# Stronger threshold so category shelves don't pad with unrelated videos.
CATEGORY_MIN_SCORE = 0.55
CATEGORY_SCORE_FLOOR = 0.35
CATEGORY_RELATIVE_DELTA = 0.08
FOR_YOU_MIN_SCORE = 0.28


def _category_min_score() -> float:
    ai = app_settings.ai_settings()
    return app_settings.clamp_category_min_score(
        ai.get("category_min_score", CATEGORY_MIN_SCORE)
    )


@dataclass
class RecommendationSection:
    title: str
    seed_video_id: Optional[int]
    videos: list[Video]
    kind: str = "for_you"  # for_you | category | more


@dataclass
class CategoryBrowsePage:
    videos: list[Video]
    has_more: bool
    categories: list[str] = field(default_factory=list)


@dataclass
class ForYouPage:
    videos: list[Video]
    has_more: bool


def _filter_category_hits(
    hits: list[tuple[int, float]], min_score: float
) -> list[tuple[int, float]]:
    """Keep hits at/above min_score or within delta of the top score (floor applied)."""
    if not hits:
        return []
    top = hits[0][1]
    relative = top - CATEGORY_RELATIVE_DELTA
    kept: list[tuple[int, float]] = []
    for vid, score in hits:
        if score < CATEGORY_SCORE_FLOOR:
            continue
        if score >= min_score or score >= relative:
            kept.append((vid, score))
    return kept


def list_categories(session: Session, *, nonempty_only: bool = True) -> list[str]:
    rows = session.exec(select(AiCategory).order_by(AiCategory.name)).all()
    if not nonempty_only:
        return [r.name for r in rows]
    min_score = _category_min_score()
    names: list[str] = []
    for row in rows:
        vec = embeddings.unpack_vector(row.embedding, row.dim)
        if not vec:
            continue
        raw = embeddings.similar_video_ids(
            session, vec, limit=8, min_score=CATEGORY_SCORE_FLOOR
        )
        if _filter_category_hits(raw, min_score):
            names.append(row.name)
    return names


def videos_for_category(
    session: Session,
    category: str,
    *,
    limit: int = 24,
    offset: int = 0,
) -> CategoryBrowsePage:
    """Return a page of category matches (no For You filler)."""
    categories = list_categories(session)
    row = session.exec(
        select(AiCategory).where(AiCategory.name == category)
    ).first()
    if row is None:
        return CategoryBrowsePage([], False, categories)

    vec = embeddings.unpack_vector(row.embedding, row.dim)
    if not vec:
        return CategoryBrowsePage([], False, categories)

    min_score = _category_min_score()
    # Over-fetch then apply relative filter and paginate.
    pool = max(offset + limit + 1, 64)
    raw = embeddings.similar_video_ids(
        session, vec, limit=max(pool * 4, 500), min_score=CATEGORY_SCORE_FLOOR
    )
    hits = _filter_category_hits(raw, min_score)
    slice_hits = hits[offset : offset + limit + 1]
    has_more = len(slice_hits) > limit

    videos: list[Video] = []
    for vid, _score in slice_hits[:limit]:
        video = session.get(Video, vid)
        if video is None or video.needs_review or video.id is None:
            continue
        videos.append(video)

    return CategoryBrowsePage(videos, has_more, categories)


def _ranked_for_you_ids(session: Session, *, pool: int = 2000) -> list[int]:
    """Score by watch history similarity, then append remaining library by recency."""
    history = library.query_videos(
        session,
        watched_only=True,
        sort="last_watched_at",
        order="desc",
        needs_review=False,
    )[:16]

    used: set[int] = {v.id for v in history if v.id is not None}
    scored: dict[int, float] = {}

    for seed in history:
        if seed.id is None:
            continue
        centroid = embeddings.video_centroid(session, seed.id)
        if centroid is None:
            continue
        hits = embeddings.similar_video_ids(
            session,
            centroid,
            limit=pool,
            exclude_ids=used | {seed.id},
            min_score=FOR_YOU_MIN_SCORE,
        )
        for vid, score in hits:
            prev = scored.get(vid)
            if prev is None or score > prev:
                scored[vid] = score

    ranked = sorted(scored.keys(), key=lambda i: scored[i], reverse=True)
    ranked_set = set(ranked)

    # Pad with unscored remainder (and history seeds not already listed) by recency
    # so infinite scroll can page through essentially the whole library.
    remainder = library.query_videos(
        session, sort="added_at", order="desc", needs_review=False
    )
    for video in remainder:
        if video.id is None or video.id in ranked_set:
            continue
        ranked.append(video.id)
        ranked_set.add(video.id)

    return ranked


def homepage_recommendations_page(
    session: Session, *, limit: int = 24, offset: int = 0
) -> ForYouPage:
    if get_provider() is None:
        return ForYouPage([], False)
    ranked_ids = _ranked_for_you_ids(session, pool=max(2000, offset + limit + 100))
    slice_ids = ranked_ids[offset : offset + limit + 1]
    has_more = len(slice_ids) > limit
    videos: list[Video] = []
    for vid in slice_ids[:limit]:
        video = session.get(Video, vid)
        if video is None or video.needs_review:
            continue
        videos.append(video)
    return ForYouPage(videos, has_more)


def homepage_recommendations(
    session: Session, *, limit: int = 36
) -> list[RecommendationSection]:
    """Single For You shelf ordered by recommendation strength."""
    page = homepage_recommendations_page(session, limit=limit, offset=0)
    if not page.videos:
        return []
    return [
        RecommendationSection(
            title="Recommended",
            seed_video_id=None,
            videos=page.videos,
            kind="for_you",
        )
    ]

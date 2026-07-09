"""Homepage recommendations and category browse."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from sqlmodel import Session, select

from ...models import AiCategory, Video
from .. import library
from . import embeddings
from .provider import get_provider

# Stronger threshold so category shelves don't pad with unrelated videos.
CATEGORY_MIN_SCORE = 0.42
FOR_YOU_MIN_SCORE = 0.28


@dataclass
class RecommendationSection:
    title: str
    seed_video_id: Optional[int]
    videos: list[Video]
    kind: str = "for_you"  # for_you | category | more


@dataclass
class CategoryBrowseResult:
    category_videos: list[Video]
    more_videos: list[Video]
    categories: list[str] = field(default_factory=list)


def list_categories(session: Session) -> list[str]:
    rows = session.exec(select(AiCategory).order_by(AiCategory.name)).all()
    return [r.name for r in rows]


def videos_for_category(
    session: Session, category: str, *, limit: int = 48
) -> CategoryBrowseResult:
    """Return strong category matches, plus separate For You filler (not mixed)."""
    categories = list_categories(session)
    row = session.exec(
        select(AiCategory).where(AiCategory.name == category)
    ).first()
    if row is None:
        return CategoryBrowseResult([], [], categories)

    vec = embeddings.unpack_vector(row.embedding, row.dim)
    if not vec:
        return CategoryBrowseResult([], [], categories)

    hits = embeddings.similar_video_ids(
        session, vec, limit=limit, min_score=CATEGORY_MIN_SCORE
    )
    category_videos: list[Video] = []
    used: set[int] = set()
    for vid, _score in hits:
        video = session.get(Video, vid)
        if video is None or video.needs_review or video.id is None:
            continue
        category_videos.append(video)
        used.add(video.id)

    more: list[Video] = []
    for section in homepage_recommendations(session, limit=24):
        for video in section.videos:
            if video.id is None or video.id in used:
                continue
            more.append(video)
            used.add(video.id)
            if len(more) >= 24:
                break
        if len(more) >= 24:
            break

    return CategoryBrowseResult(category_videos, more, categories)


def homepage_recommendations(
    session: Session, *, limit: int = 36
) -> list[RecommendationSection]:
    """Single For You shelf ordered by recommendation strength (no 'because you watched')."""
    if get_provider() is None:
        return []

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
            limit=limit,
            exclude_ids=used | {seed.id},
            min_score=FOR_YOU_MIN_SCORE,
        )
        for vid, score in hits:
            prev = scored.get(vid)
            if prev is None or score > prev:
                scored[vid] = score

    ranked_ids = sorted(scored.keys(), key=lambda i: scored[i], reverse=True)
    videos: list[Video] = []
    for vid in ranked_ids:
        video = session.get(Video, vid)
        if video is None or video.needs_review:
            continue
        videos.append(video)
        if len(videos) >= limit:
            break

    if videos:
        return [
            RecommendationSection(
                title="Recommended",
                seed_video_id=None,
                videos=videos,
                kind="for_you",
            )
        ]

    # Cold start: newest library videos.
    recent = library.query_videos(
        session, sort="added_at", order="desc", needs_review=False
    )[:limit]
    if recent:
        return [
            RecommendationSection(
                title="Recommended",
                seed_video_id=None,
                videos=recent,
                kind="for_you",
            )
        ]
    return []

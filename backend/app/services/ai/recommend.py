"""Homepage recommendations and category browse."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlmodel import Session, select

from ...models import AiCategory, Video
from .. import library
from . import embeddings
from .provider import get_provider


@dataclass
class RecommendationSection:
    title: str
    seed_video_id: Optional[int]
    videos: list[Video]


def list_categories(session: Session) -> list[str]:
    rows = session.exec(select(AiCategory).order_by(AiCategory.name)).all()
    return [r.name for r in rows]


def videos_for_category(
    session: Session, category: str, *, limit: int = 24
) -> list[Video]:
    row = session.exec(
        select(AiCategory).where(AiCategory.name == category)
    ).first()
    if row is None:
        return []
    vec = embeddings.unpack_vector(row.embedding, row.dim)
    if not vec:
        return []
    hits = embeddings.similar_video_ids(session, vec, limit=limit, min_score=0.18)
    videos: list[Video] = []
    for vid, _score in hits:
        video = session.get(Video, vid)
        if video is None or video.needs_review:
            continue
        videos.append(video)
    return videos


def homepage_recommendations(
    session: Session, *, limit_per_section: int = 12, max_sections: int = 4
) -> list[RecommendationSection]:
    if get_provider() is None:
        return []

    history = library.query_videos(
        session,
        watched_only=True,
        sort="last_watched_at",
        order="desc",
        needs_review=False,
    )[:12]

    sections: list[RecommendationSection] = []
    used: set[int] = {v.id for v in history if v.id is not None}

    for seed in history:
        if seed.id is None:
            continue
        centroid = embeddings.video_centroid(session, seed.id)
        if centroid is None:
            continue
        hits = embeddings.similar_video_ids(
            session,
            centroid,
            limit=limit_per_section + 8,
            exclude_ids=used | {seed.id},
            min_score=0.25,
        )
        videos: list[Video] = []
        for vid, _score in hits:
            video = session.get(Video, vid)
            if video is None or video.needs_review:
                continue
            videos.append(video)
            used.add(vid)
            if len(videos) >= limit_per_section:
                break
        if videos:
            sections.append(
                RecommendationSection(
                    title=f"Because you watched {seed.title}",
                    seed_video_id=seed.id,
                    videos=videos,
                )
            )
        if len(sections) >= max_sections:
            break

    if sections:
        return sections

    # Cold start: newest library videos that have embeddings, as a single shelf.
    recent = library.query_videos(
        session, sort="added_at", order="desc", needs_review=False
    )[:limit_per_section]
    if recent:
        return [
            RecommendationSection(
                title="From your library",
                seed_video_id=None,
                videos=recent,
            )
        ]
    return []

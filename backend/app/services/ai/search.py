"""Hybrid keyword + embedding library search."""

from __future__ import annotations

from typing import Optional

from sqlmodel import Session

from ...models import Video
from .. import library
from . import embeddings
from .provider import get_embed_provider


def hybrid_search(
    session: Session,
    q: str,
    *,
    channel: Optional[str] = None,
    tag: Optional[str] = None,
    sort: str = "added_at",
    order: str = "desc",
    needs_review: Optional[bool] = False,
    seed: Optional[int] = None,
) -> list[Video]:
    """Merge ILIKE keyword hits with embedding nearest neighbors.

    When Ollama/embeddings are unavailable, falls back to keyword-only search.
    """
    keyword = library.query_videos(
        session,
        q=q,
        channel=channel,
        tag=tag,
        sort=sort,
        order=order,
        needs_review=needs_review,
        seed=seed,
    )

    if get_embed_provider() is None or not q.strip():
        return keyword

    query_vec = embeddings.embed_query(q)
    if query_vec is None:
        return keyword

    # Restrict semantic candidates by channel/tag filters when present.
    semantic_hits = embeddings.similar_video_ids(
        session, query_vec, limit=80, min_score=0.22
    )
    if not semantic_hits:
        return keyword

    by_id: dict[int, Video] = {}
    for video in library.query_videos(
        session,
        channel=channel,
        tag=tag,
        sort="added_at",
        order="desc",
        needs_review=needs_review,
    ):
        if video.id is not None:
            by_id[video.id] = video

    scores: dict[int, float] = {}
    for vid, score in semantic_hits:
        if vid not in by_id:
            continue
        scores[vid] = float(score)

    # Boost exact keyword matches so title hits stay on top.
    for i, video in enumerate(keyword):
        if video.id is None:
            continue
        boost = 1.0 - (i * 0.002)
        scores[video.id] = max(scores.get(video.id, 0.0), 0.55) + boost

    ranked_ids = sorted(scores.keys(), key=lambda i: scores[i], reverse=True)
    results = [by_id[i] for i in ranked_ids if i in by_id]

    # Append any keyword-only rows that somehow lacked embeddings.
    seen = {v.id for v in results}
    for video in keyword:
        if video.id not in seen:
            results.append(video)
            seen.add(video.id)
    return results

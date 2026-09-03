"""Hybrid keyword + embedding library search."""

from __future__ import annotations

from typing import Any, Optional

from sqlmodel import Session

from ...models import Video
from .. import app_settings, library
from ..search_text import explain_match, query_allows_semantic
from . import embeddings, text as ai_text
from .provider import get_embed_provider


def _caption_chunk_text(video: Video, chunk_index: int) -> Optional[str]:
    if chunk_index < 0:
        return None
    use_subs = bool(app_settings.ai_settings().get("use_subtitles", True))
    for idx, text in ai_text.documents_for_video(video, use_subtitles=use_subs):
        if idx == chunk_index:
            return text
    return None


def explain_library_video(
    video: Video,
    query: str,
    *,
    chunk_index: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    tags = library.parse_tags(video.tags)
    keyword = explain_match(
        query,
        title=video.title,
        description=video.description,
        tags=tags,
        notes=video.notes,
        allow_related=False,
    )
    if keyword:
        return keyword
    caption = None
    if chunk_index is not None and chunk_index >= 0:
        caption = _caption_chunk_text(video, chunk_index)
    return explain_match(
        query,
        title=video.title,
        description=video.description,
        tags=tags,
        notes=video.notes,
        caption_chunk=caption,
        allow_related=chunk_index is not None,
    )


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
) -> tuple[list[Video], dict[int, int]]:
    """Merge whole-word keyword hits with embedding nearest neighbors.

    Returns (videos, chunk_index_by_video_id) for match-reason snippets.
    When Ollama/embeddings are unavailable, or the query is too short to
    embed usefully, falls back to keyword-only search.
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
    chunks: dict[int, int] = {}

    if (
        get_embed_provider() is None
        or not q.strip()
        or not query_allows_semantic(q)
    ):
        return keyword, chunks

    query_vec = embeddings.embed_query(q)
    if query_vec is None:
        return keyword, chunks

    semantic_hits = embeddings.similar_video_hits(
        session, query_vec, limit=80, min_score=0.22
    )
    if not semantic_hits:
        return keyword, chunks

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
    for vid, score, chunk_index in semantic_hits:
        if vid not in by_id:
            continue
        scores[vid] = float(score)
        chunks[vid] = chunk_index

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
    return results, chunks

"""Hybrid keyword + embedding library search."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlmodel import Session

from ...models import Video
from .. import app_settings, library
from ..comments import enabled as comments_enabled
from ..comments import search as comment_search
from ..search_text import explain_match, query_allows_semantic
from . import embeddings
from . import text as ai_text
from .provider import get_embed_provider


def _caption_chunk_text(video: Video, chunk_index: int) -> str | None:
    if chunk_index < 0:
        return None
    use_subs = bool(app_settings.ai_settings().get("use_subtitles", True))
    for idx, text in ai_text.documents_for_video(video, use_subtitles=use_subs):
        if idx == chunk_index:
            return text
    return None


def explain_library_video(
    session: Session,
    video: Video,
    query: str,
    *,
    chunk_index: int | None = None,
) -> dict[str, Any] | None:
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
    reason = explain_match(
        query,
        title=video.title,
        description=video.description,
        tags=tags,
        notes=video.notes,
        caption_chunk=caption,
    )
    if reason:
        return reason
    if video.id is not None and comments_enabled():
        snippet = comment_search.best_snippet(session, video.id, query)
        if snippet:
            return {"source": "comments", "snippet": snippet}
    return {"source": "related", "snippet": None} if chunk_index is not None else None


def hybrid_search(
    session: Session,
    q: str,
    *,
    channel: str | None = None,
    tag: str | None = None,
    sort: str = "added_at",
    order: str = "desc",
    needs_review: bool | None = False,
    seed: int | None = None,
    user_id: int | None = None,
    semantic: bool = True,
    embed_query: Callable[[str], list[float] | None] | None = None,
) -> tuple[list[Video], dict[int, int]]:
    """Merge whole-word keyword hits with embedding nearest neighbors, then add
    videos found only through their saved comments.

    Returns (videos, chunk_index_by_video_id) for match-reason snippets.
    When Ollama/embeddings are unavailable, or the query is too short to
    embed usefully, falls back to keyword-only search. ``semantic=False`` skips the
    embedding half (the caller may not spend AI quota); ``embed_query`` lets the
    caller reuse a cached query vector.
    """
    results, chunks = _metadata_search(
        session,
        q,
        channel=channel,
        tag=tag,
        sort=sort,
        order=order,
        needs_review=needs_review,
        seed=seed,
        user_id=user_id,
        semantic=semantic,
        embed_query=embed_query,
    )
    if not comments_enabled():
        return results, chunks
    found = {v.id for v in results}
    extra = [i for i in comment_search.matching_video_ids(session, q) if i not in found]
    if not extra:
        return results, chunks
    # Comments are a weaker signal than the video's own text: these come last,
    # most matching comments first.
    allowed = {
        v.id: v
        for v in library.query_videos(
            session, channel=channel, tag=tag, needs_review=needs_review, ids=extra
        )
    }
    return results + [allowed[i] for i in extra if i in allowed], chunks


def _metadata_search(
    session: Session,
    q: str,
    *,
    channel: str | None,
    tag: str | None,
    sort: str,
    order: str,
    needs_review: bool | None,
    seed: int | None,
    user_id: int | None,
    semantic: bool,
    embed_query: Callable[[str], list[float] | None] | None,
) -> tuple[list[Video], dict[int, int]]:
    keyword = library.query_videos(
        session,
        q=q,
        channel=channel,
        tag=tag,
        sort=sort,
        order=order,
        needs_review=needs_review,
        seed=seed,
        user_id=user_id,
    )
    chunks: dict[int, int] = {}

    if (
        not semantic
        or get_embed_provider() is None
        or not q.strip()
        or not query_allows_semantic(q)
    ):
        return keyword, chunks

    query_vec = (embed_query or embeddings.embed_query)(q)
    if query_vec is None:
        return keyword, chunks

    semantic_hits = embeddings.similar_video_hits(
        session, query_vec, limit=80, min_score=0.35
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

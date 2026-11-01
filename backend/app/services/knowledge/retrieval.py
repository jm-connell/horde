"""Find the passages that answer a question, across one or more Ask channels.

1. **Expand** the question once with the chat model: spellings and synonyms the
   captions may use ("4Runner", "4 runner", "for runner"), generations, part names.
   Skipped for small local models; on any failure the question's own words are used.
2. **Search each channel** by keyword (FTS5, every passage naming the terms) and by
   meaning (embeddings), merged with reciprocal rank fusion.
3. **Pick** the best videos and their best passages within a character budget
   shared fairly between the channels, and number them in date order, so the model
   can cite ``[n]`` and notice an opinion that changed over time.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from sqlmodel import Session, col, select

from ...models import KbChannel, KbChunk, KbVideo, Video, require_id
from ..ai.embeddings import embed_query
from ..ai.provider import resolve_embed_model
from . import chunking
from . import search as kb_search
from .vectors import VectorCache, top_chunks

logger = logging.getLogger(__name__)

_RRF_K = 60
_CANDIDATES = 60
_PER_VIDEO = 3
_EXPAND_TIMEOUT = 45.0


@dataclass
class Excerpt:
    n: int
    chunk_id: int
    channel_id: int
    channel_name: str
    yt_id: str
    title: str
    published_at: str | None
    start_sec: float
    end_sec: float
    text: str
    is_description: bool
    library_video_id: int | None = None
    kb_video_id: int = 0


@dataclass
class Expansion:
    terms: list[str] = field(default_factory=list)
    search: str = ""


def expand(provider, model: str, question: str, channel_names: list[str]) -> Expansion:
    """Spellings and synonyms to search for. Empty on failure (the caller falls back)."""
    system = (
        "You prepare searches over auto-generated YouTube captions. Return JSON "
        '{"terms": [...], "search": "..."}. "terms": up to 12 short words or '
        "phrases that a video answering the question would say: the key names "
        "and things in the question, with the spellings captions often produce "
        '("4Runner", "4 runner", "for runner"), model generations or year '
        "ranges, part and engine names, and plain synonyms. Leave out the "
        'channel names and filler words. "search": the question rewritten as one '
        "plain search sentence."
    )
    prompt = f"Channels: {', '.join(channel_names)}\nQuestion: {question}"
    try:
        raw = provider.chat(
            prompt,
            model,
            system=system,
            format="json",
            timeout=_EXPAND_TIMEOUT,
            num_predict=300,
            usage_kind="ask",
        )
        data = json.loads(raw)
        raw_terms = data.get("terms") if isinstance(data, dict) else None
        search = data.get("search") if isinstance(data, dict) else None
    except Exception:
        logger.info("Ask: query expansion failed; using the question", exc_info=True)
        return Expansion()
    terms = (
        [str(t).strip() for t in raw_terms if str(t).strip()]
        if isinstance(raw_terms, list)
        else []
    )
    return Expansion(terms=terms[:12], search=str(search or "").strip())


def _fuse(rankings: list[list[int]]) -> dict[int, float]:
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, chunk_id in enumerate(ranking):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (_RRF_K + rank + 1)
    return scores


def _channel_candidates(
    session: Session,
    cache: VectorCache,
    channel: KbChannel,
    terms: list[str],
    query_vector: list[float] | None,
    model: str,
) -> dict[int, float]:
    keyword = [
        h.chunk_id
        for h in kb_search.search(
            session, terms, channel_ids=[require_id(channel)], limit=_CANDIDATES
        )
    ]
    rankings = [keyword]
    if query_vector:
        rankings.append(
            [
                c
                for c, _ in top_chunks(
                    session, cache, channel, query_vector, _CANDIDATES, model=model
                )
            ]
        )
    return _fuse(rankings)


def _pick(
    session: Session, channel: KbChannel, scores: dict[int, float], budget: int
) -> list[tuple[KbChunk, KbVideo]]:
    """Best videos first; per video its best non-overlapping passages, within budget."""
    if not scores:
        return []
    chunks = {
        c.id: c
        for c in session.exec(
            select(KbChunk).where(col(KbChunk.id).in_(list(scores)))
        ).all()
    }
    by_video: dict[int, list[KbChunk]] = {}
    for chunk_id in sorted(scores, key=lambda c: -scores[c]):
        chunk = chunks.get(chunk_id)
        if chunk is not None:
            by_video.setdefault(chunk.kb_video_id, []).append(chunk)

    def video_score(video_id: int) -> float:
        hits = by_video[video_id]
        return scores[hits[0].id or 0] + 0.25 * sum(scores[h.id or 0] for h in hits[1:])

    videos = {
        v.id: v
        for v in session.exec(
            select(KbVideo).where(col(KbVideo.id).in_(list(by_video)))
        ).all()
    }
    picked: list[tuple[KbChunk, KbVideo]] = []
    used = 0
    for video_id in sorted(by_video, key=video_score, reverse=True):
        video = videos.get(video_id)
        if video is None:
            continue
        kept: list[KbChunk] = []
        for chunk in by_video[video_id]:
            if len(kept) >= _PER_VIDEO:
                break
            if any(
                chunk.start_sec < k.end_sec and k.start_sec < chunk.end_sec
                for k in kept
                if k.chunk_index >= 0 and chunk.chunk_index >= 0
            ):
                continue
            if used + len(chunk.text) > budget and picked:
                break
            kept.append(chunk)
            used += len(chunk.text)
        picked.extend((c, video) for c in kept)
        if used >= budget:
            break
    return picked


# Above any fused score (at most about 2 / (k + 1)): the watched video's
# matching passages come first.
_FOCUS_BOOST = 0.05


def _boost_video(
    session: Session, scores: dict[int, float], channel: KbChannel, yt_id: str
) -> None:
    if not scores:
        return
    focus = set(
        session.exec(
            select(KbChunk.id)
            .join(KbVideo, col(KbVideo.id) == col(KbChunk.kb_video_id))
            .where(
                KbVideo.kb_channel_id == require_id(channel),
                KbVideo.yt_id == yt_id,
                col(KbChunk.id).in_(list(scores)),
            )
        ).all()
    )
    for chunk_id in focus:
        if chunk_id is not None:
            scores[chunk_id] += _FOCUS_BOOST


def retrieve(
    session: Session,
    cache: VectorCache,
    channels: list[KbChannel],
    question: str,
    expansion: Expansion,
    *,
    budget_chars: int,
    focus_yt_id: str | None = None,
) -> list[Excerpt]:
    """Numbered excerpts for ``question`` from ``channels``, oldest first.

    ``focus_yt_id`` is the video being watched: its matching passages rank first.
    """
    terms = expansion.terms + kb_search.query_terms(question)
    query_vector = embed_query(expansion.search or question)
    # Only vectors from the current model compare with the query's.
    model = resolve_embed_model()
    share = max(2000, budget_chars // max(1, len(channels)))
    picked: list[tuple[KbChannel, KbChunk, KbVideo]] = []
    for channel in channels:
        scores = _channel_candidates(
            session, cache, channel, terms, query_vector, model
        )
        if focus_yt_id:
            _boost_video(session, scores, channel, focus_yt_id)
        picked.extend(
            (channel, c, v) for c, v in _pick(session, channel, scores, share)
        )
    yt_ids = {v.yt_id for _, _, v in picked}
    library = {
        yt: vid
        for vid, yt in session.exec(
            select(Video.id, Video.youtube_id).where(col(Video.youtube_id).in_(yt_ids))
        ).all()
    }
    picked.sort(key=lambda p: (p[2].published_at or "", p[2].yt_id, p[1].start_sec))
    return [
        Excerpt(
            n=i + 1,
            chunk_id=chunk.id or 0,
            channel_id=channel.id or 0,
            channel_name=channel.channel_name or channel.channel_url,
            yt_id=video.yt_id,
            title=video.title or video.yt_id,
            published_at=video.published_at,
            start_sec=chunk.start_sec,
            end_sec=chunk.end_sec,
            text=chunk.text,
            is_description=chunk.chunk_index == chunking.META_CHUNK_INDEX,
            library_video_id=library.get(video.yt_id),
            kb_video_id=video.id or 0,
        )
        for i, (channel, chunk, video) in enumerate(picked)
    ]


def format_excerpts(excerpts: list[Excerpt]) -> str:
    """Excerpts for the prompt. No times: the model cites numbers, the app adds times."""
    lines = []
    for e in excerpts:
        date = (e.published_at or "")[:10] or "undated"
        kind = " · from the video description" if e.is_description else ""
        lines.append(f'[{e.n}] {e.channel_name} · "{e.title}" ({date}){kind}\n{e.text}')
    return "\n\n".join(lines)

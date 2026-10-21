"""Homepage recommendations and category browse.

Both score whole videos (their profile vectors: metadata plus a share of the
captions) with one matrix product over the library
(``vector_index.video_scores``) rather than one nearest-neighbour search per
seed or per category.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field

import numpy as np
from sqlmodel import Session, col, select

from ...models import AiCategory, UserVideoState, Video, require_id
from .. import app_settings, follows
from . import embeddings, vector_index
from .provider import get_embed_provider

# Stronger threshold so category shelves don't pad with unrelated videos.
CATEGORY_MIN_SCORE = 0.55
CATEGORY_SCORE_FLOOR = 0.35
CATEGORY_RELATIVE_DELTA = 0.08
# A video joins a category only when it scores within this of its best category,
# so a cooking video does not also land on "Homelab Networking" at 0.4.
CATEGORY_COMPETE_MARGIN = 0.04

FOR_YOU_MIN_SCORE = 0.28
# The most recent watches that seed "For you"; each counts less the older it is.
FOR_YOU_SEEDS = 30
FOR_YOU_SEED_DECAY = 0.93
# Score = best single-seed match, plus how well the video fits the history overall.
FOR_YOU_BEST_WEIGHT = 0.75
FOLLOWED_CHANNEL_BOOST = 0.03
# Each pick from a channel lowers that channel's next pick by this much.
CHANNEL_REPEAT_PENALTY = 0.04


def _category_min_score() -> float:
    ai = app_settings.ai_settings()
    return app_settings.clamp_category_min_score(
        ai.get("category_min_score", CATEGORY_MIN_SCORE)
    )


@dataclass
class RecommendationSection:
    title: str
    seed_video_id: int | None
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


def _hidden_video_ids(session: Session) -> set[int]:
    """Videos waiting in review: indexed, but not shown on shelves."""
    return {
        int(vid)
        for vid in session.exec(
            select(Video.id).where(Video.needs_review == True)  # noqa: E712 - SQL column comparison, not a Python truth test
        ).all()
        if vid is not None
    }


def _category_assignments(session: Session) -> dict[str, list[tuple[int, float]]]:
    """Each category's videos, best first.

    A video belongs to a category when it clears the score floor, scores within
    ``CATEGORY_COMPETE_MARGIN`` of its best category, and either clears the
    strictness setting or is within ``CATEGORY_RELATIVE_DELTA`` of the
    category's top hit (cosine ranges differ between embed models).
    """
    rows = session.exec(select(AiCategory).order_by(AiCategory.name)).all()
    named: list[tuple[str, list[float]]] = []
    for row in rows:
        vec = embeddings.unpack_vector(row.embedding, row.dim)
        if vec:
            named.append((row.name, vec))
    if not named:
        return {}
    # Categories are refreshed together, so they share one dimension; any left
    # over from an older embed model cannot be compared and are skipped.
    dim = len(named[-1][1])
    named = [(name, vec) for name, vec in named if len(vec) == dim]

    video_ids, scores = vector_index.video_scores(session, [v for _, v in named])
    hidden = _hidden_video_ids(session)
    if hidden and video_ids.size:
        visible = ~np.isin(video_ids, np.fromiter(hidden, np.int64, len(hidden)))
        video_ids, scores = video_ids[visible], scores[visible]
    if video_ids.size == 0:
        return {}

    min_score = _category_min_score()
    best = scores.max(axis=1)
    out: dict[str, list[tuple[int, float]]] = {}
    for j, (name, _vec) in enumerate(named):
        column = scores[:, j]
        top = float(column.max())
        keep = (
            (column >= CATEGORY_SCORE_FLOOR)
            & (column >= best - CATEGORY_COMPETE_MARGIN)
            & ((column >= min_score) | (column >= top - CATEGORY_RELATIVE_DELTA))
        )
        picked = np.flatnonzero(keep)
        order = picked[np.argsort(-column[picked], kind="stable")]
        hits = [(int(video_ids[i]), float(column[i])) for i in order]
        if hits:
            out[name] = hits
    return out


def list_categories(session: Session, *, nonempty_only: bool = True) -> list[str]:
    if not nonempty_only:
        rows = session.exec(select(AiCategory).order_by(AiCategory.name)).all()
        return [r.name for r in rows]
    return list(_category_assignments(session))


def videos_for_category(
    session: Session,
    category: str,
    *,
    limit: int = 24,
    offset: int = 0,
) -> CategoryBrowsePage:
    """Return a page of category matches (no For You filler)."""
    assignments = _category_assignments(session)
    categories = list(assignments)
    hits = assignments.get(category, [])
    slice_hits = hits[offset : offset + limit + 1]
    has_more = len(slice_hits) > limit

    videos: list[Video] = []
    for vid, _score in slice_hits[:limit]:
        video = session.get(Video, vid)
        if video is None or video.needs_review:
            continue
        videos.append(video)

    return CategoryBrowsePage(videos, has_more, categories)


def _engagement(position_sec: float, duration_sec: float | None) -> float:
    """How much a watch says about the user's taste, from how far they got."""
    if position_sec <= 0:
        # Finished and reset, or an old position that expired: unknown.
        return 0.75
    if duration_sec and duration_sec > 0:
        fraction = position_sec / duration_sec
        if fraction >= 0.5:
            return 1.0
        if fraction < 0.15 and position_sec < 120:
            return 0.35  # Opened and abandoned.
        return 0.7
    return 0.35 if position_sec < 60 else 0.8


def _diversify(scored: dict[int, float], channels: dict[int, str]) -> list[int]:
    """Order by score, lowering each channel's later picks so one channel cannot fill the shelf."""
    heap = [(-score, vid, 0) for vid, score in scored.items()]
    heapq.heapify(heap)
    picked_per_channel: dict[str, int] = {}
    out: list[int] = []
    while heap:
        neg, vid, seen_count = heapq.heappop(heap)
        channel = channels.get(vid, "")
        count = picked_per_channel.get(channel, 0) if channel else 0
        if count != seen_count:
            # The channel gained picks since this entry was scored: re-queue it.
            penalty = CHANNEL_REPEAT_PENALTY * (count - seen_count)
            heapq.heappush(heap, (neg + penalty, vid, count))
            continue
        out.append(vid)
        if channel:
            picked_per_channel[channel] = count + 1
    return out


def _ranked_for_you_ids(session: Session, *, user_id: int) -> list[int]:
    """Unwatched videos scored against this user's history, then the rest.

    Seeds are the most recent watches, weighted by recency and by how much of
    each the user watched. Already-watched videos are never scored; they go last
    so infinite scroll can still page through the whole library.
    """
    history = session.exec(
        select(Video, UserVideoState)
        .join(UserVideoState, col(UserVideoState.video_id) == col(Video.id))
        .where(
            UserVideoState.user_id == user_id,
            col(UserVideoState.last_watched_at).is_not(None),
            Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
        )
        .order_by(col(UserVideoState.last_watched_at).desc())
    ).all()
    watched = [video.id for video, _state in history if video.id is not None]
    watched_set = set(watched)

    recent = history[:FOR_YOU_SEEDS]
    profiles = vector_index.profile_vectors(session, watched[:FOR_YOU_SEEDS])
    seed_vectors: list[list[float]] = []
    weights: list[float] = []
    for rank, (video, state) in enumerate(recent):
        vec = profiles.get(require_id(video))
        if vec is None or (seed_vectors and len(vec) != len(seed_vectors[0])):
            continue
        seed_vectors.append(vec)
        weights.append(
            FOR_YOU_SEED_DECAY**rank
            * _engagement(state.position_sec, video.duration_sec)
        )

    library_rows = session.exec(
        select(Video.id, Video.channel, Video.channel_url)
        .where(Video.needs_review == False)  # noqa: E712 - SQL column comparison, not a Python truth test
        .order_by(col(Video.added_at).desc(), col(Video.id).desc())
    ).all()
    channels = {int(v): (c or "").strip() for v, c, _u in library_rows if v is not None}

    scored: dict[int, float] = {}
    if seed_vectors:
        video_ids, sims = vector_index.video_scores(session, seed_vectors)
        w = np.asarray(weights, dtype=np.float32)
        # Old or abandoned watches still count for the best match, just less.
        best = (sims * (0.6 + 0.4 * w)).max(axis=1)
        breadth = sims @ w / float(w.sum())
        score = FOR_YOU_BEST_WEIGHT * best + (1 - FOR_YOU_BEST_WEIGHT) * breadth
        relevant = sims.max(axis=1) >= FOR_YOU_MIN_SCORE
        followed = follows.followed_urls(session, user_id)
        followed_videos = {
            int(v)
            for v, _c, url in library_rows
            if v is not None and url and follows.normalize_channel_url(url) in followed
        }
        for i in np.flatnonzero(relevant):
            vid = int(video_ids[i])
            if vid in watched_set or vid not in channels:
                continue
            boost = FOLLOWED_CHANNEL_BOOST if vid in followed_videos else 0.0
            scored[vid] = float(score[i]) + boost

    ranked = _diversify(scored, channels)
    ranked_set = set(ranked)
    # Then the unscored, unwatched rest by recency, then what the user has seen.
    ranked.extend(
        vid for vid in channels if vid not in ranked_set and vid not in watched_set
    )
    ranked.extend(vid for vid in watched if vid in channels)
    return ranked


def homepage_recommendations_page(
    session: Session, *, user_id: int, limit: int = 24, offset: int = 0
) -> ForYouPage:
    """The "For you" shelf, seeded from this user's watch history."""
    if get_embed_provider() is None:
        return ForYouPage([], False)
    ranked_ids = _ranked_for_you_ids(session, user_id=user_id)
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
    session: Session, *, user_id: int, limit: int = 36
) -> list[RecommendationSection]:
    """Single For You shelf ordered by recommendation strength."""
    page = homepage_recommendations_page(
        session, user_id=user_id, limit=limit, offset=0
    )
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

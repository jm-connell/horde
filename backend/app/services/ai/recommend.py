"""Homepage recommendations and category browse.

Both score whole videos (their profile vectors: metadata plus a share of the
captions) with one matrix product over the library
(``vector_index.video_scores``) rather than one nearest-neighbour search per
seed or per category.

"For you" also works without AI: then it ranks by what the watch history says
about channels and tags (``_taste``), plus followed channels and freshness. It
can also take in uploads of followed channels that are indexed but not
downloaded (``include_streams``); they are scored on the same scale as the
library (embeddings when AI is on, the taste otherwise) and merged in.
"""

from __future__ import annotations

import heapq
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime

import numpy as np
from sqlmodel import Session, col, select

from ...models import (
    AiCategory,
    ChannelCatalogEmbedding,
    ChannelCatalogVideo,
    UserVideoState,
    Video,
    VideoTag,
    as_utc,
    require_id,
)
from .. import app_settings, follows
from ..channel_catalog import query as catalog_query
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

# Without AI: how much each signal counts (they are each 0..1).
TASTE_CHANNEL_WEIGHT = 0.45
TASTE_TAG_WEIGHT = 0.25
TASTE_FOLLOWED_WEIGHT = 0.15
TASTE_FRESH_WEIGHT = 0.15
# Watches that make up the taste, newest first, each counting less.
TASTE_HISTORY = 200
TASTE_DECAY = 0.97
# A video's freshness halves every this many days after it was published.
FRESH_HALF_LIFE_DAYS = 30.0
# Undownloaded uploads considered per followed channel (its newest ones).
STREAMS_PER_CHANNEL = 30


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
class ForYouItem:
    """One "For you" pick: a library video, or a followed channel's upload."""

    video: Video | None = None
    stream: ChannelCatalogVideo | None = None
    channel: str | None = None


@dataclass
class ForYouPage:
    videos: list[Video]
    has_more: bool
    #: The page in order, library videos and uploads together.
    items: list[ForYouItem] = field(default_factory=list)


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
    dim = Counter(len(vec) for _, vec in named).most_common(1)[0][0]
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
        # The player stores a finished video as 0 (useProgressSaver.finish); an
        # old position that expired is also 0, but recency already discounts it.
        return 1.0
    if duration_sec and duration_sec > 0:
        fraction = position_sec / duration_sec
        if fraction >= 0.5:
            return 1.0
        if fraction < 0.15 and position_sec < 120:
            return 0.35  # Opened and abandoned.
        return 0.7
    return 0.35 if position_sec < 60 else 0.8


def _diversify(scored: dict[int, float], channels: dict[int, str]) -> list[int]:
    """Order by score, lowering each channel's later picks so one channel cannot fill the shelf.

    The penalty is the same for every video of a channel, so each channel keeps
    its own order: merge the channels' queues by their heads' penalised scores.
    """
    queues: dict[str | int, list[tuple[float, int]]] = {}
    for vid, score in scored.items():
        # A video without a channel is its own queue: nothing to spread.
        queues.setdefault(channels.get(vid) or vid, []).append((score, vid))
    heap: list[tuple[float, int, str | int, int]] = []
    for key, queue in queues.items():
        queue.sort(key=lambda item: (-item[0], item[1]))
        heap.append((-queue[0][0], queue[0][1], key, 0))
    heapq.heapify(heap)
    out: list[int] = []
    while heap:
        _neg, vid, key, index = heapq.heappop(heap)
        out.append(vid)
        queue = queues[key]
        if index + 1 < len(queue):
            score, nxt = queue[index + 1]
            penalised = score - CHANNEL_REPEAT_PENALTY * (index + 1)
            heapq.heappush(heap, (-penalised, nxt, key, index + 1))
    return out


def _fresh(when: datetime | None, now: datetime) -> float:
    if when is None:
        return 0.0
    days = max(0.0, (now - as_utc(when)).total_seconds() / 86400)
    return float(0.5 ** (days / FRESH_HALF_LIFE_DAYS))


def _published(raw: str | None) -> datetime | None:
    """A catalog row's publish date: ISO text, or yt-dlp's YYYYMMDD."""
    text = (raw or "").strip()
    if not text:
        return None
    try:
        if len(text) == 8 and text.isdigit():
            return datetime.strptime(text, "%Y%m%d").replace(tzinfo=UTC)
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


@dataclass
class _Taste:
    """What a watch history says, each map scaled so its strongest entry is 1."""

    channels: dict[str, float]
    tags: dict[str, float]

    def channel(self, name: str) -> float:
        return self.channels.get(name, 0.0)

    def tag_match(self, tags: list[str]) -> float:
        # The three strongest shared tags; one strong match is not the whole story.
        best = sorted((self.tags.get(t, 0.0) for t in tags), reverse=True)[:3]
        return sum(best) / 3


def _scaled(weights: dict[str, float]) -> dict[str, float]:
    top = max(weights.values(), default=0.0)
    return {k: v / top for k, v in weights.items()} if top > 0 else {}


def _taste(session: Session, history: list[tuple[Video, UserVideoState]]) -> _Taste:
    channels: dict[str, float] = defaultdict(float)
    weight_of: dict[int, float] = {}
    for rank, (video, state) in enumerate(history[:TASTE_HISTORY]):
        weight = TASTE_DECAY**rank * _engagement(state.position_sec, video.duration_sec)
        name = (video.channel or "").strip()
        if name:
            channels[name] += weight
        weight_of[require_id(video)] = weight
    tags: dict[str, float] = defaultdict(float)
    if weight_of:
        for vid, tag in session.exec(
            select(VideoTag.video_id, VideoTag.tag).where(
                col(VideoTag.video_id).in_(list(weight_of))
            )
        ).all():
            tags[tag.lower()] += weight_of[vid]
    return _Taste(_scaled(channels), _scaled(tags))


def _taste_score(
    taste: _Taste, channel: str, tags: list[str], followed: bool, fresh: float
) -> float | None:
    """The no-AI score, or None when nothing in the history points at it."""
    by_channel = taste.channel(channel)
    by_tags = taste.tag_match(tags)
    if by_channel == 0 and by_tags == 0 and not followed:
        return None
    return (
        TASTE_CHANNEL_WEIGHT * by_channel
        + TASTE_TAG_WEIGHT * by_tags
        + TASTE_FOLLOWED_WEIGHT * (1.0 if followed else 0.0)
        + TASTE_FRESH_WEIGHT * fresh
    )


@dataclass
class _Upload:
    row: ChannelCatalogVideo
    channel: str


def _followed_uploads(
    session: Session, followed: set[str], downloaded: set[str]
) -> list[_Upload]:
    """Newest indexed, not-downloaded uploads of the channels the user follows."""
    out: list[_Upload] = []
    for url in sorted(followed):
        rows, name = catalog_query.visible_channel_videos(
            session, url, limit=STREAMS_PER_CHANNEL, exclude_yt_ids=downloaded
        )
        for row in rows:
            # Live and upcoming broadcasts have their own row on the home page.
            if row.live_status in ("is_live", "is_upcoming"):
                continue
            out.append(_Upload(row, (name or "").strip()))
    return out


def _upload_vectors(
    session: Session, uploads: dict[int, _Upload], dim: int
) -> tuple[list[int], np.ndarray]:
    """(keys, L2-normalised rows) of the uploads' stored embeddings of ``dim``."""
    by_row = {require_id(u.row): key for key, u in uploads.items()}
    keys: list[int] = []
    rows: list[list[float]] = []
    if by_row:
        for emb in session.exec(
            select(ChannelCatalogEmbedding).where(
                col(ChannelCatalogEmbedding.catalog_video_id).in_(list(by_row))
            )
        ).all():
            vec = embeddings.unpack_vector(emb.vector, emb.dim)
            if len(vec) == dim:
                keys.append(by_row[emb.catalog_video_id])
                rows.append(vec)
    matrix = np.asarray(rows, dtype=np.float32).reshape(len(rows), dim)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return keys, matrix / np.where(norms == 0, 1, norms)


def _ranked_for_you_ids(
    session: Session, *, user_id: int, include_streams: bool = False
) -> tuple[list[int], dict[int, _Upload]]:
    """Unwatched videos scored against this user's history, then the rest.

    With AI, seeds are the most recent watches, weighted by recency and by how
    much of each the user watched; without it, the taste (``_taste``) scores
    instead. Already-watched videos are never scored; they go last so infinite
    scroll can still page through the whole library.

    Library videos are listed by id; with ``include_streams``, a followed
    channel's upload by the negated id of its catalog row (the second value
    maps those keys to the uploads).
    """
    history = list(
        session.exec(
            select(Video, UserVideoState)
            .join(UserVideoState, col(UserVideoState.video_id) == col(Video.id))
            .where(
                UserVideoState.user_id == user_id,
                col(UserVideoState.last_watched_at).is_not(None),
                Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
            )
            .order_by(col(UserVideoState.last_watched_at).desc())
        ).all()
    )
    watched = [video.id for video, _state in history if video.id is not None]
    watched_set = set(watched)

    library_rows = session.exec(
        select(Video.id, Video.channel, Video.channel_url, Video.youtube_id)
        .where(Video.needs_review == False)  # noqa: E712 - SQL column comparison, not a Python truth test
        .order_by(col(Video.added_at).desc(), col(Video.id).desc())
    ).all()
    channels = {
        int(row[0]): (row[1] or "").strip()
        for row in library_rows
        if row[0] is not None
    }
    followed = follows.followed_urls(session, user_id)
    followed_videos = {
        int(row[0])
        for row in library_rows
        if row[0] is not None
        and row[2]
        and follows.normalize_channel_url(row[2]) in followed
    }
    uploads: dict[int, _Upload] = {}
    if include_streams and followed:
        downloaded = {row[3] for row in library_rows if row[3]}
        for upload in _followed_uploads(session, followed, downloaded):
            uploads[-require_id(upload.row)] = upload
            channels[-require_id(upload.row)] = upload.channel

    scored: dict[int, float] = {}
    # Without AI, or before any watch has vectors, the taste ranks instead.
    seed_vectors: list[list[float]] = []
    weights: list[float] = []
    if get_embed_provider() is not None:
        recent = history[:FOR_YOU_SEEDS]
        profiles = vector_index.profile_vectors(session, watched[:FOR_YOU_SEEDS])
        for rank, (video, state) in enumerate(recent):
            vec = profiles.get(require_id(video))
            if vec is None or (seed_vectors and len(vec) != len(seed_vectors[0])):
                continue
            seed_vectors.append(vec)
            weights.append(
                FOR_YOU_SEED_DECAY**rank
                * _engagement(state.position_sec, video.duration_sec)
            )
    if seed_vectors:
        w = np.asarray(weights, dtype=np.float32)

        def score_rows(keys, sims, is_followed) -> None:
            # Old or abandoned watches still count for the best match, just less.
            best = (sims * (0.6 + 0.4 * w)).max(axis=1)
            breadth = sims @ w / float(w.sum())
            score = FOR_YOU_BEST_WEIGHT * best + (1 - FOR_YOU_BEST_WEIGHT) * breadth
            for i in np.flatnonzero(sims.max(axis=1) >= FOR_YOU_MIN_SCORE):
                key = int(keys[i])
                if key in watched_set or key not in channels:
                    continue
                boost = FOLLOWED_CHANNEL_BOOST if is_followed(key) else 0.0
                scored[key] = float(score[i]) + boost

        video_ids, sims = vector_index.video_scores(session, seed_vectors)
        score_rows(video_ids, sims, followed_videos.__contains__)
        if uploads:
            seeds = np.asarray(seed_vectors, dtype=np.float32)
            seeds /= np.where(
                (n := np.linalg.norm(seeds, axis=1, keepdims=True)) == 0, 1, n
            )
            keys, matrix = _upload_vectors(session, uploads, seeds.shape[1])
            if keys:
                score_rows(keys, matrix @ seeds.T, lambda _key: True)
    else:
        now = datetime.now(UTC)
        taste = _taste(session, history)
        tags_of: dict[int, list[str]] = defaultdict(list)
        for tagged, tag in session.exec(select(VideoTag.video_id, VideoTag.tag)).all():
            tags_of[tagged].append(tag.lower())
        dates = session.exec(
            select(Video.id, Video.published_at, Video.added_at).where(
                Video.needs_review == False  # noqa: E712 - SQL column comparison, not a Python truth test
            )
        ).all()
        for row_id, published_at, added_at in dates:
            if row_id is None or row_id in watched_set:
                continue
            vid = int(row_id)
            value = _taste_score(
                taste,
                channels.get(vid, ""),
                tags_of.get(vid, []),
                vid in followed_videos,
                _fresh(published_at or added_at, now),
            )
            if value is not None:
                scored[vid] = value
        for key, upload in uploads.items():
            value = _taste_score(
                taste,
                upload.channel,
                [],
                True,
                _fresh(_published(upload.row.published_at), now),
            )
            if value is not None:
                scored[key] = value

    ranked = _diversify(scored, channels)
    ranked_set = set(ranked)
    # Then the unscored, unwatched rest by recency, then what the user has seen.
    ranked.extend(
        key for key in channels if key not in ranked_set and key not in watched_set
    )
    ranked.extend(vid for vid in watched if vid in channels)
    return ranked, uploads


def homepage_recommendations_page(
    session: Session,
    *,
    user_id: int,
    limit: int = 24,
    offset: int = 0,
    include_streams: bool = False,
) -> ForYouPage:
    """The "For you" shelf, seeded from this user's watch history."""
    ranked_ids, uploads = _ranked_for_you_ids(
        session, user_id=user_id, include_streams=include_streams
    )
    slice_ids = ranked_ids[offset : offset + limit + 1]
    has_more = len(slice_ids) > limit
    items: list[ForYouItem] = []
    for key in slice_ids[:limit]:
        if key < 0:
            upload = uploads[key]
            items.append(ForYouItem(stream=upload.row, channel=upload.channel))
            continue
        video = session.get(Video, key)
        if video is None or video.needs_review:
            continue
        items.append(ForYouItem(video=video))
    return ForYouPage([i.video for i in items if i.video is not None], has_more, items)


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

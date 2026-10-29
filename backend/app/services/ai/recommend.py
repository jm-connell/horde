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

A YouTube watch history imported from Google Takeout (``services/takeout``)
feeds it too: those videos count as watched, the channels watched there lift
their videos (recent views far more than old ones), the newest of those views
seed the AI scores, and indexed uploads of those channels join the
not-downloaded picks even when the user does not follow them. Now and then a
"throwback" pick brings back a channel (or, with AI, a topic) the user watched
months ago but not lately.
"""

from __future__ import annotations

import heapq
import random
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime

import numpy as np
from sqlmodel import Session, col, select

from ...models import (
    AiCategory,
    ChannelCatalog,
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
from ..takeout import history as takeout_history
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

# The imported YouTube history (services/takeout/history.py).
#: How much a channel watched on YouTube lifts its videos' AI scores (times 0..1).
YT_CHANNEL_BOOST = 0.06
#: Without AI: a YouTube channel's pull next to the Horde history's (both 0..1).
YT_TASTE_SHARE = 0.8
#: The newest YouTube watches that seed AI "For you", and how much each counts.
YT_SEEDS = 30
YT_SEED_WEIGHT = 0.8
#: Unfollowed channels watched on YouTube whose indexed uploads are suggested.
YT_UPLOAD_CHANNELS = 12
#: One throwback pick in this many, at most this many in the whole shelf.
THROWBACK_EVERY = 20
THROWBACK_MAX = 4
#: A throwback channel: watched this often 6+ months ago, and lately at most
#: this share of the strongest channel's recent pull.
THROWBACK_MIN_OLD_VIEWS = 5
THROWBACK_RECENT_CEILING = 0.15
#: With AI, old watches seed throwback topics; a pick must match one this well.
THROWBACK_TOPIC_MIN_SCORE = 0.4
THROWBACK_SEEDS = 30


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
    #: ``throwback`` for a pick from a channel or topic watched months ago.
    reason: str | None = None


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
    taste: _Taste,
    channel: str,
    tags: list[str],
    followed: bool,
    fresh: float,
    youtube: float = 0.0,
) -> float | None:
    """The no-AI score, or None when nothing in the history points at it.

    ``youtube`` is the channel's pull in the imported YouTube history (0..1).
    """
    by_channel = max(taste.channel(channel), YT_TASTE_SHARE * youtube)
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
    #: The indexed channel's URL (to match it against the YouTube history).
    channel_url: str | None = None


def _channel_uploads(
    session: Session, channel_urls: set[str], downloaded: set[str]
) -> list[_Upload]:
    """Newest indexed, not-downloaded uploads of these channels."""
    out: list[_Upload] = []
    for url in sorted(channel_urls):
        rows, name = catalog_query.visible_channel_videos(
            session, url, limit=STREAMS_PER_CHANNEL, exclude_yt_ids=downloaded
        )
        for row in rows:
            # Live and upcoming broadcasts have their own row on the home page.
            if row.live_status in ("is_live", "is_upcoming"):
                continue
            out.append(_Upload(row, (name or "").strip(), url))
    return out


def _upload_vectors(
    session: Session, uploads: dict[int, _Upload], dim: int
) -> tuple[list[int], np.ndarray]:
    """The uploads' stored embeddings of length ``dim``, as unit rows, with their keys."""
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


@dataclass
class _YoutubeTaste:
    """The imported YouTube history, keyed so Horde's channels can be looked up."""

    profile: takeout_history.Profile
    #: Recent pull of each channel, 0..1 (the strongest is 1), by URL and by name.
    by_url: dict[str, float] = field(default_factory=dict)
    by_name: dict[str, float] = field(default_factory=dict)
    #: Channels watched a lot 6+ months ago and hardly since.
    throwback_urls: set[str] = field(default_factory=set)
    throwback_names: set[str] = field(default_factory=set)

    @property
    def empty(self) -> bool:
        return self.profile.empty

    def pull(self, url: str | None, name: str | None) -> float:
        norm = follows.normalize_channel_url(url) if url else ""
        return max(
            self.by_url.get(norm, 0.0) if norm else 0.0,
            self.by_name.get((name or "").strip().casefold(), 0.0),
        )

    def is_throwback(self, url: str | None, name: str | None) -> bool:
        if self.pull(url, name) > THROWBACK_RECENT_CEILING:
            return False
        norm = follows.normalize_channel_url(url) if url else ""
        return (bool(norm) and norm in self.throwback_urls) or (
            (name or "").strip().casefold() in self.throwback_names
        )


def _youtube_taste(session: Session, user_id: int) -> _YoutubeTaste:
    found = takeout_history.cached_profile(session, user_id)
    out = _YoutubeTaste(found)
    top = max((c.recent for c in found.channels.values()), default=0.0)
    for channel in found.channels.values():
        pull = channel.recent / top if top > 0 else 0.0
        name = (channel.name or "").strip().casefold()
        if channel.url:
            out.by_url[channel.url] = max(out.by_url.get(channel.url, 0.0), pull)
        if name:
            out.by_name[name] = max(out.by_name.get(name, 0.0), pull)
        if (
            channel.old_views >= THROWBACK_MIN_OLD_VIEWS
            and pull <= THROWBACK_RECENT_CEILING
        ):
            if channel.url:
                out.throwback_urls.add(channel.url)
            if name:
                out.throwback_names.add(name)
    return out


def _youtube_channel_catalogs(
    session: Session, yt: _YoutubeTaste, followed: set[str]
) -> set[str]:
    """Indexed channels the user watches on YouTube but does not follow.

    The ones watched most lately, plus a few throwback channels so their
    uploads can be picked too.
    """
    pulls: list[tuple[float, str]] = []
    throwbacks: list[str] = []
    for url, name in session.exec(
        select(ChannelCatalog.channel_url, ChannelCatalog.channel_name)
    ).all():
        if follows.normalize_channel_url(url) in followed:
            continue
        pull = yt.pull(url, name)
        if pull > 0:
            pulls.append((pull, url))
        if yt.is_throwback(url, name):
            throwbacks.append(url)
    pulls.sort(reverse=True)
    return {url for _pull, url in pulls[:YT_UPLOAD_CHANNELS]} | set(
        sorted(throwbacks)[:THROWBACK_MAX]
    )


def _youtube_vectors(
    session: Session, yt_ids: list[str], library_by_yt: dict[str, int]
) -> dict[str, list[float]]:
    """Vectors of videos watched on YouTube: the library copy's, else the index's."""
    out: dict[str, list[float]] = {}
    in_library = {yt: library_by_yt[yt] for yt in yt_ids if yt in library_by_yt}
    if in_library:
        profiles = vector_index.profile_vectors(session, list(in_library.values()))
        for yt, vid in in_library.items():
            if vid in profiles:
                out[yt] = profiles[vid]
    rest = [yt for yt in yt_ids if yt not in out]
    if rest:
        for yt, emb in session.exec(
            select(ChannelCatalogVideo.yt_id, ChannelCatalogEmbedding)
            .join(
                ChannelCatalogEmbedding,
                col(ChannelCatalogEmbedding.catalog_video_id)
                == col(ChannelCatalogVideo.id),
            )
            .where(col(ChannelCatalogVideo.yt_id).in_(rest))
        ).all():
            vec = embeddings.unpack_vector(emb.vector, emb.dim)
            if vec and yt not in out:
                out[yt] = vec
    return out


def _recency(when: datetime, now: datetime) -> float:
    days = max(0.0, (now - as_utc(when)).total_seconds() / 86400)
    return float(0.5 ** (days / takeout_history.RECENT_HALF_LIFE_DAYS))


def _throwback_topics(
    session: Session,
    yt: _YoutubeTaste,
    library_by_yt: dict[str, int],
    uploads: dict[int, _Upload],
    allowed: set[int],
) -> list[int]:
    """With AI: the few keys in ``allowed`` closest to what the user watched long ago."""
    old = [yt_id for yt_id, _when in yt.profile.old_videos[:THROWBACK_SEEDS]]
    vectors = list(_youtube_vectors(session, old, library_by_yt).values())
    if not vectors:
        return []
    dim = Counter(len(v) for v in vectors).most_common(1)[0][0]
    seeds = np.asarray([v for v in vectors if len(v) == dim], dtype=np.float32)
    seeds /= np.where((n := np.linalg.norm(seeds, axis=1, keepdims=True)) == 0, 1, n)
    best: dict[int, float] = {}

    def take(keys, sims) -> None:
        top = sims.max(axis=1)
        for i in np.flatnonzero(top >= THROWBACK_TOPIC_MIN_SCORE):
            key = int(keys[i])
            if key in allowed:
                best[key] = max(best.get(key, 0.0), float(top[i]))

    video_ids, sims = vector_index.video_scores(session, seeds.tolist())
    if video_ids.size:
        take(video_ids, sims)
    if uploads:
        keys, matrix = _upload_vectors(session, uploads, dim)
        if keys:
            take(keys, matrix @ seeds.T)
    return [key for key, _score in sorted(best.items(), key=lambda kv: -kv[1])[:3]]


def _place_throwbacks(
    session: Session,
    ranked: list[int],
    *,
    user_id: int,
    yt: _YoutubeTaste,
    unwatched: set[int],
    channels: dict[int, str],
    channel_urls: dict[int, str | None],
    library_by_yt: dict[str, int],
    uploads: dict[int, _Upload],
) -> dict[int, str]:
    """Move a few throwback picks into ``ranked`` (one in ``THROWBACK_EVERY``).

    A pick comes from a channel watched a lot 6+ months ago and hardly since or,
    with AI, is close to what the user watched back then. A pick only ever
    moves up: one already above its slot stays where it is. The draw is fixed
    per user and day, so paging through the shelf sees one order.
    """
    position = {key: i for i, key in enumerate(ranked)}
    # Only picks below the first slot: moving one up is the point, never down.
    allowed = {
        key
        for key in ranked
        if key in unwatched and position[key] >= THROWBACK_EVERY - 1
    }
    by_channel: dict[str, list[int]] = defaultdict(list)
    for key in ranked:
        if key in allowed and yt.is_throwback(channel_urls.get(key), channels.get(key)):
            by_channel[channels.get(key, "").casefold()].append(key)
    rng = random.Random(f"{user_id}:{datetime.now(UTC).date().isoformat()}")  # noqa: S311 - a stable shuffle per user and day, not a secret
    pool = [rng.choice(keys) for _name, keys in sorted(by_channel.items())]
    if get_embed_provider() is not None:
        pool.extend(
            key
            for key in _throwback_topics(
                session, yt, library_by_yt, uploads, allowed - set(pool)
            )
            if key not in pool
        )
    rng.shuffle(pool)
    chosen: list[int] = []
    for key in pool:
        slot = (len(chosen) + 1) * THROWBACK_EVERY - 1
        if len(chosen) == THROWBACK_MAX:
            break
        if position[key] > slot:
            chosen.append(key)
    if not chosen:
        return {}
    picked = set(chosen)
    ranked[:] = [key for key in ranked if key not in picked]
    for index, key in enumerate(chosen):
        ranked.insert((index + 1) * THROWBACK_EVERY - 1, key)
    return dict.fromkeys(chosen, "throwback")


def _ranked_for_you_ids(
    session: Session, *, user_id: int, include_streams: bool = False
) -> tuple[list[int], dict[int, _Upload], dict[int, str]]:
    """Unwatched videos scored against this user's history, then the rest.

    With AI, seeds are the most recent watches, weighted by recency and by how
    much of each the user watched; without it, the taste (``_taste``) scores
    instead. Already-watched videos are never scored; they go last so infinite
    scroll can still page through the whole library. The imported YouTube
    history joins in (see the module docstring).

    Library videos are listed by id; with ``include_streams``, an indexed
    channel's upload by the negated id of its catalog row (the second value
    maps those keys to the uploads). The third value marks throwback picks.
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
    yt = _youtube_taste(session, user_id)
    library_rows = session.exec(
        select(Video.id, Video.channel, Video.channel_url, Video.youtube_id)
        .where(Video.needs_review == False)  # noqa: E712 - SQL column comparison, not a Python truth test
        .order_by(col(Video.added_at).desc(), col(Video.id).desc())
    ).all()
    library_by_yt = {
        str(row[3]): int(row[0])
        for row in library_rows
        if row[0] is not None and row[3]
    }
    watched = [video.id for video, _state in history if video.id is not None]
    # Videos watched on YouTube count as watched too, after Horde's own.
    seen = set(watched)
    for yt_id, vid in library_by_yt.items():
        if yt_id in yt.profile.watched and vid not in seen:
            watched.append(vid)
            seen.add(vid)
    watched_set = set(watched)

    channels = {
        int(row[0]): (row[1] or "").strip()
        for row in library_rows
        if row[0] is not None
    }
    channel_urls: dict[int, str | None] = {
        int(row[0]): row[2] for row in library_rows if row[0] is not None
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
    followed_uploads: set[int] = set()
    if include_streams:
        downloaded = {row[3] for row in library_rows if row[3]}
        if not yt.empty:
            # Only the indexed videos watched on YouTube: the channel listing
            # reads past every id it is told to leave out.
            downloaded |= yt.profile.watched & set(
                session.exec(select(ChannelCatalogVideo.yt_id)).all()
            )
        watched_there = (
            _youtube_channel_catalogs(session, yt, followed) if not yt.empty else set()
        )
        for urls, is_followed in ((followed, True), (watched_there, False)):
            for upload in _channel_uploads(session, urls, downloaded):
                key = -require_id(upload.row)
                if key in uploads:
                    continue
                uploads[key] = upload
                channels[key] = upload.channel
                channel_urls[key] = upload.channel_url
                if is_followed:
                    followed_uploads.add(key)

    def pull(key: int) -> float:
        return (
            yt.pull(channel_urls.get(key), channels.get(key)) if not yt.empty else 0.0
        )

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
        if not yt.empty:
            now = datetime.now(UTC)
            picks = yt.profile.recent_videos[:YT_SEEDS]
            vectors = _youtube_vectors(
                session, [yt_id for yt_id, _when in picks], library_by_yt
            )
            for yt_id, when in picks:
                vec = vectors.get(yt_id)
                if vec is None or (seed_vectors and len(vec) != len(seed_vectors[0])):
                    continue
                seed_vectors.append(vec)
                weights.append(YT_SEED_WEIGHT * _recency(when, now))
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
                scored[key] = float(score[i]) + boost + YT_CHANNEL_BOOST * pull(key)

        video_ids, sims = vector_index.video_scores(session, seed_vectors)
        score_rows(video_ids, sims, followed_videos.__contains__)
        if uploads:
            seeds = np.asarray(seed_vectors, dtype=np.float32)
            seeds /= np.where(
                (n := np.linalg.norm(seeds, axis=1, keepdims=True)) == 0, 1, n
            )
            keys, matrix = _upload_vectors(session, uploads, seeds.shape[1])
            if keys:
                score_rows(keys, matrix @ seeds.T, followed_uploads.__contains__)
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
                pull(vid),
            )
            if value is not None:
                scored[vid] = value
        for key, upload in uploads.items():
            value = _taste_score(
                taste,
                upload.channel,
                [],
                key in followed_uploads,
                _fresh(_published(upload.row.published_at), now),
                pull(key),
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
    reasons: dict[int, str] = {}
    if not yt.empty:
        reasons = _place_throwbacks(
            session,
            ranked,
            user_id=user_id,
            yt=yt,
            unwatched={key for key in channels if key not in watched_set},
            channels=channels,
            channel_urls=channel_urls,
            library_by_yt=library_by_yt,
            uploads=uploads,
        )
    return ranked, uploads, reasons


def homepage_recommendations_page(
    session: Session,
    *,
    user_id: int,
    limit: int = 24,
    offset: int = 0,
    include_streams: bool = False,
) -> ForYouPage:
    """The "For you" shelf, seeded from this user's watch history."""
    ranked_ids, uploads, reasons = _ranked_for_you_ids(
        session, user_id=user_id, include_streams=include_streams
    )
    slice_ids = ranked_ids[offset : offset + limit + 1]
    has_more = len(slice_ids) > limit
    items: list[ForYouItem] = []
    for key in slice_ids[:limit]:
        if key < 0:
            upload = uploads[key]
            items.append(
                ForYouItem(
                    stream=upload.row, channel=upload.channel, reason=reasons.get(key)
                )
            )
            continue
        video = session.get(Video, key)
        if video is None or video.needs_review:
            continue
        items.append(ForYouItem(video=video, reason=reasons.get(key)))
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

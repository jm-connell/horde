"""The Recommended+ feed: four kinds of picks, ranked separately, then mixed.

Every unwatched candidate (``candidates``) lands in exactly one bucket:

* **subscriptions**: recent uploads of channels the user follows or watches a lot
  right now. The videos they will recognise.
* **similar**: close to what they watched in the last weeks (embeddings, or
  channels and tags without AI), from channels they already know.
* **new**: as close, but from a channel they have never watched: discovery.
* **throwback**: close to an interest they have not touched lately, or from a
  channel they used to watch and stopped.

Each bucket is sorted by its own score, and the feed takes from the buckets in
turn by ``SHARES`` (smooth weighted round robin), spreading channels out. A
small seeded jitter, larger in ``new``, keeps the order from freezing and lets
a less certain new channel through now and then; ``seed`` changes on refresh.
Videos shown on many visits without being watched sink, then drop to the end.
Tuning notes: ``docs/adr/0019-recommended-plus.md``.
"""

from __future__ import annotations

import hashlib
import logging
import math
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np
from sqlmodel import Session, col, select

from ...models import DiscoveryHit, UserVideoState, Video, VideoTag, utcnow
from .. import app_settings, follows
from ..ai import vector_index
from ..ai.provider import get_embed_provider
from ..takeout import history as takeout_history
from .candidates import (
    Candidate,
    catalog_candidates,
    discovered_candidates,
    library_candidates,
)
from .feedback import (
    Exclusions,
    earlier_visits,
    exclusions,
    impression_penalty,
    worn_out,
)
from .history import Watch, watches
from .interests import (
    RECENT_HALF_LIFE_DAYS,
    Interest,
    interests,
    split_history,
    watch_vectors,
    watch_weight,
)
from .runtime import DiscoveryRuntime

logger = logging.getLogger(__name__)

SHARES = {"subscriptions": 0.30, "similar": 0.30, "new": 0.25, "throwback": 0.15}
#: An upload counts as new for "subscriptions" this long after it is published.
SUBSCRIPTION_WINDOW = timedelta(days=21)
#: A channel this strong in the recent history counts like a followed one.
WATCHED_CHANNEL_LEVEL = 0.25
#: A channel this strong long ago, and absent lately, is a throwback channel.
DORMANT_CHANNEL_LEVEL = 0.3
#: The same channel appears at most once in any this many slots...
CHANNEL_GAP = 5
#: ...and at most this often in the whole feed in these buckets (the channel
#: suggestions show more of a new channel).
CHANNEL_CAPS = {"new": 2, "throwback": 3}
#: While other buckets have picks left, none takes more than this times its share.
OVERFILL = 1.3
#: What new channels and throwbacks may grow to when another bucket is empty.
SHARE_CAPS = {"new": 0.35, "throwback": 0.18}
#: See ``mix``: how strongly an under-served interest is pulled forward, and the
#: least share any recent interest is owed.
TOPIC_BONUS = 0.06
MIN_TOPIC_SHARE = 0.08
#: The same "Because you watched ..." is shown at most this often.
SEED_REASON_MAX = 2
#: Below these a pick waits at the end of the feed instead of in its bucket.
#: With embeddings, relevance is calibrated (``_calibrated``): 1 is as close as
#: the user's own recent watches are to each other. New channels must be clearly
#: relevant; known ones may be a little less.
FLOORS = {"similar": 0.45, "new": 0.6, "throwback": 0.55}
#: Without embeddings relevance is the channel and tag taste (0..1).
TASTE_FLOORS = {"similar": 0.15, "new": 0.3, "throwback": 0.3}
JITTER = 0.02
NEW_JITTER = 0.06
FEED_MAX = 800
#: Seeds read from the recent history (by weight).
MAX_SEEDS = 40


@dataclass
class Reason:
    kind: str  # subscription | similar | new_channel | throwback | library
    text: str
    detail: str | None = None


@dataclass
class FeedItem:
    candidate: Candidate
    bucket: str
    score: float
    reason: Reason
    #: The recent interest it matches (see ``mix``), when known.
    topic: int | None = None
    #: From a channel the user follows.
    followed: bool = False


@dataclass
class ChannelStat:
    """A channel new to the user, as the feed saw it (for suggestions)."""

    name: str
    url: str
    scores: list[float] = field(default_factory=list)
    items: list[Candidate] = field(default_factory=list)
    seeds: set[str] = field(default_factory=set)


@dataclass
class Feed:
    items: list[FeedItem]
    new_channels: dict[str, ChannelStat]
    cold: bool


def _name(text: str) -> str:
    return " ".join((text or "").lower().split())


def _scaled(weights: dict[str, float]) -> dict[str, float]:
    top = max(weights.values(), default=0.0)
    return {k: v / top for k, v in weights.items()} if top > 0 else {}


def _fresh(when: datetime | None, now: datetime, half_life_days: float) -> float:
    if when is None:
        return 0.0
    days = max(0.0, (now - when).total_seconds() / 86400)
    return float(0.5 ** (days / half_life_days))


def _quality(views: int | None) -> float:
    """A popularity prior: 1k views or fewer 0, a few million 1; unknown 0.5."""
    if views is None:
        return 0.5
    return float(min(1.0, max(0.0, (math.log10(views + 1) - 3.0) / 3.5)))


def _short(title: str, limit: int = 60) -> str:
    title = " ".join((title or "").split())
    return title if len(title) <= limit else title[: limit - 1].rstrip() + "…"


def _rng(user_id: int, seed: int) -> np.random.Generator:
    digest = hashlib.blake2b(f"{user_id}:{seed}".encode(), digest_size=8).digest()
    return np.random.default_rng(int.from_bytes(digest, "big"))


def _household(session: Session, user_id: int) -> tuple[list[Watch], dict[int, float]]:
    """Other users' watches, and how alike each user's channels are to this one's."""
    others = session.exec(
        select(UserVideoState.user_id)
        .where(UserVideoState.user_id != user_id)
        .distinct()
    ).all()
    mine: dict[str, float] = defaultdict(float)
    for w in watches(session, user_id, limit=300):
        mine[_name(w.channel)] += w.engagement
    pooled: list[Watch] = []
    similarity: dict[int, float] = {}
    for other in others:
        theirs = watches(session, other, limit=300, include_youtube=False)
        pooled.extend(theirs)
        counts: dict[str, float] = defaultdict(float)
        for w in theirs:
            counts[_name(w.channel)] += w.engagement
        dot = sum(v * counts.get(k, 0.0) for k, v in mine.items())
        norm = math.sqrt(sum(v * v for v in mine.values())) * math.sqrt(
            sum(v * v for v in counts.values())
        )
        similarity[other] = dot / norm if norm else 0.0
    return pooled, similarity


def _cowatch(session: Session, user_id: int) -> dict[int, float]:
    """Library videos people with similar taste here liked, scaled 0..1."""
    if not app_settings.load().get("discovery_household", True):
        return {}
    _pooled, similarity = _household(session, user_id)
    weights: dict[int, float] = defaultdict(float)
    for other, sim in similarity.items():
        if sim < 0.1:
            continue
        for w in watches(session, other, limit=300, include_youtube=False):
            if w.video_id is not None and w.engagement >= 0.7:
                weights[w.video_id] += sim * w.engagement
    top = max(weights.values(), default=0.0)
    return {k: v / top for k, v in weights.items()} if top else {}


def taste_history(session: Session, user_id: int) -> tuple[list[Watch], bool]:
    """The user's watches, or (cold start) also what the household watched,
    when ``discovery_household`` allows it."""
    own = watches(session, user_id)
    if len(own) >= 3:
        return own, False
    if not app_settings.load().get("discovery_household", True):
        return own, True
    pooled, _sim = _household(session, user_id)
    if pooled:
        pooled.sort(key=lambda w: w.watched_at, reverse=True)
        return own + pooled[:100], True
    return own, True


def _channel_maps(
    history: list[Watch], now: datetime
) -> tuple[dict[str, float], dict[str, float], dict[str, float]]:
    """(recent, all-time, long-ago) channel strengths by lowercased name, 0..1."""
    recent, older = split_history(history, now)
    recent_w: dict[str, float] = defaultdict(float)
    for w in recent:
        recent_w[_name(w.channel)] += watch_weight(w, now, RECENT_HALF_LIFE_DAYS)
    all_w: dict[str, float] = defaultdict(float)
    for w in history:
        all_w[_name(w.channel)] += watch_weight(w, now, 120.0)
    old_w: dict[str, float] = defaultdict(float)
    for w in older:
        old_w[_name(w.channel)] += w.engagement
    for maps in (recent_w, all_w, old_w):
        maps.pop("", None)
    return _scaled(recent_w), _scaled(all_w), _scaled(old_w)


def _fit(sims: np.ndarray, w: np.ndarray, centre_sims: np.ndarray) -> np.ndarray:
    """How well each row fits an interest: its closest watch and closest group.

    The closest single watch catches a series or a very specific topic; the
    closest group centre (``interests``) is steadier. How *much* of each interest
    the feed shows is the mixer's job (``mix``), so a small interest's videos fit
    as well as a big one's. A watch counts a little less when it is old or was
    half watched (``w``). Rows without a vector (all NaN) stay NaN.
    """
    best = np.max(np.nan_to_num(sims * (0.85 + 0.15 * w), nan=-np.inf), axis=1)
    usable = ~np.all(np.isnan(sims), axis=1)
    if centre_sims.shape[1]:
        centre = np.max(np.nan_to_num(centre_sims, nan=-np.inf), axis=1)
        fit = 0.6 * best + 0.4 * centre
    else:
        fit = best
    out: np.ndarray = np.where(usable, fit, np.nan)
    return out


def _calibrated(
    raw: np.ndarray, seeds: np.ndarray, w: np.ndarray, centres: np.ndarray
) -> np.ndarray:
    """Fit on a scale embed models agree on: 1 is "as close as the user's own
    watches are to each other", 0 is the bottom tenth of all candidates.

    Cosines differ a lot between models (some put unrelated text at 0.5), and a
    pool can be mostly relevant (found videos all are), so neither a fixed
    cut-off nor a percentile of the pool works on its own.
    """
    finite = raw[np.isfinite(raw)]
    if finite.size == 0:
        return np.zeros_like(raw)
    lo = float(np.percentile(finite, 10))
    hi = float("nan")
    if len(seeds) >= 3:
        among = seeds @ seeds.T
        np.fill_diagonal(among, np.nan)
        hi = float(np.nanmedian(_fit(among, w, seeds @ centres.T)))
    if not math.isfinite(hi) or hi <= lo:
        hi = float(np.percentile(finite, 99))
    span = max(hi - lo, 0.02)
    out: np.ndarray = np.where(
        np.isfinite(raw), np.clip((raw - lo) / span, 0.0, 1.25), 0.0
    )
    return out


@dataclass
class _Similarity:
    """Per candidate: fit to recent and to dormant interests, and why."""

    recent: np.ndarray
    recent_raw: np.ndarray
    recent_seed: list[str | None]
    dormant: np.ndarray
    dormant_seed: list[str | None]
    #: The recent interest (``interests``) each candidate fits best, and each
    #: interest's share of the recent history.
    topic: list[int | None]
    topic_shares: dict[int, float]


def _seed_matrix(
    picked: list[Watch], weights: list[float], vectors: dict[str, np.ndarray]
) -> tuple[np.ndarray, np.ndarray, list[Watch]]:
    rows = [(w, wt) for w, wt in zip(picked, weights, strict=True) if w.key in vectors]
    rows.sort(key=lambda r: -r[1])
    rows = rows[:MAX_SEEDS]
    if not rows:
        return np.zeros((0, 0), dtype=np.float32), np.zeros(0, dtype=np.float32), []
    matrix = np.asarray([vectors[w.key] for w, _ in rows], dtype=np.float32)
    w = np.asarray([wt for _, wt in rows], dtype=np.float32)
    return matrix, w / max(float(w.max()), 1e-6), [w for w, _ in rows]


def _candidate_sims(
    session: Session,
    runtime: DiscoveryRuntime,
    cands: list[Candidate],
    seeds: np.ndarray,
) -> np.ndarray:
    """(len(cands), len(seeds)) cosines; NaN rows for candidates without a vector."""
    out = np.full((len(cands), len(seeds)), np.nan, dtype=np.float32)
    if len(seeds) == 0:
        return out
    ids, scores = vector_index.video_scores(session, seeds.tolist())
    row_of = {int(v): i for i, v in enumerate(ids)}
    store = runtime.vectors.matrix(session)
    for i, c in enumerate(cands):
        if c.video_id is not None and c.video_id in row_of:
            out[i] = scores[row_of[c.video_id]]
    if store.dim == seeds.shape[1] and store.keys:
        need = [
            (i, store.index[c.yt_id])
            for i, c in enumerate(cands)
            if c.video_id is None and c.yt_id and c.yt_id in store.index
        ]
        if need:
            rows = np.asarray([r for _, r in need])
            sims = store.rows[rows] @ seeds.T
            for (i, _r), s in zip(need, sims, strict=True):
                out[i] = s
    return out


@dataclass
class _Interests:
    """Seeds (watches) and group centres of one part of the history."""

    seeds: np.ndarray
    weights: np.ndarray
    watches: list[Watch]
    centres: np.ndarray
    shares: list[float]


def _interest_matrix(
    groups: list[Interest],
    vectors: dict[str, np.ndarray],
    weight: Callable[[Watch], float],
) -> _Interests:
    members = [w for g in groups for w in g.watches]
    seeds, w, seed_watches = _seed_matrix(
        members, [weight(x) for x in members], vectors
    )
    centred = [
        g
        for g in groups
        if g.centroid is not None and len(g.centroid) == seeds.shape[1]
    ]
    centres = (
        np.asarray([g.centroid for g in centred], dtype=np.float32)
        if centred
        else np.zeros((0, seeds.shape[1] if len(seeds) else 0), dtype=np.float32)
    )
    total = sum(g.weight for g in centred) or 1.0
    return _Interests(
        seeds, w, seed_watches, centres, [g.weight / total for g in centred]
    )


def _similarity(
    session: Session,
    runtime: DiscoveryRuntime,
    cands: list[Candidate],
    history: list[Watch],
    now: datetime,
) -> _Similarity | None:
    """Embedding fit, or None without embeddings."""
    if get_embed_provider() is None or app_settings.ai_settings().get("paused"):
        return None
    recent_groups, dormant_groups = interests(session, runtime, history, now)
    recent, older = split_history(history, now)
    vectors = watch_vectors(session, runtime, recent + older)
    mine = _interest_matrix(
        recent_groups, vectors, lambda x: watch_weight(x, now, RECENT_HALF_LIFE_DAYS)
    )
    if len(mine.seeds) == 0:
        return None
    sims = _candidate_sims(session, runtime, cands, mine.seeds)
    centre_sims = _candidate_sims(session, runtime, cands, mine.centres)
    raw = _fit(sims, mine.weights, centre_sims)
    best_seed = np.argmax(np.nan_to_num(sims, nan=-np.inf), axis=1)
    best_centre = (
        np.argmax(np.nan_to_num(centre_sims, nan=-np.inf), axis=1)
        if len(mine.centres)
        else None
    )
    recent_seed: list[str | None] = []
    topic: list[int | None] = []
    for i in range(len(cands)):
        usable = bool(np.isfinite(raw[i]))
        recent_seed.append(mine.watches[int(best_seed[i])].title if usable else None)
        topic.append(
            int(best_centre[i]) if usable and best_centre is not None else None
        )

    old = _interest_matrix(dormant_groups, vectors, lambda x: x.engagement)
    dormant = np.zeros(len(cands), dtype=np.float32)
    dormant_seed: list[str | None] = [None] * len(cands)
    if len(old.seeds) and old.seeds.shape[1] == mine.seeds.shape[1]:
        old_sims = _candidate_sims(session, runtime, cands, old.seeds)
        old_centres = _candidate_sims(session, runtime, cands, old.centres)
        dormant = _calibrated(
            _fit(old_sims, old.weights, old_centres),
            old.seeds,
            old.weights,
            old.centres,
        )
        idx = np.argmax(np.nan_to_num(old_sims, nan=-np.inf), axis=1)
        dormant_seed = [
            None if np.all(np.isnan(old_sims[i])) else old.watches[int(idx[i])].title
            for i in range(len(cands))
        ]
    return _Similarity(
        recent=_calibrated(raw, mine.seeds, mine.weights, mine.centres),
        recent_raw=raw,
        recent_seed=recent_seed,
        dormant=dormant,
        dormant_seed=dormant_seed,
        topic=topic,
        topic_shares=dict(enumerate(mine.shares)),
    )


def _taste_relevance(
    session: Session,
    cands: list[Candidate],
    history: list[Watch],
    all_channels: dict[str, float],
) -> np.ndarray:
    """Without AI: the watched channels and tags a candidate shares, 0..1."""
    rank_of = {w.video_id: r for r, w in enumerate(history[:200]) if w.video_id}
    engagement = {w.video_id: w.engagement for w in history if w.video_id}
    tag_w: dict[str, float] = defaultdict(float)
    if rank_of:
        for vid, tag in session.exec(
            select(VideoTag.video_id, VideoTag.tag).where(
                col(VideoTag.video_id).in_(list(rank_of))
            )
        ).all():
            tag_w[tag.lower()] += 0.97 ** rank_of[vid] * engagement[vid]
    tags = _scaled(tag_w)
    out = np.zeros(len(cands), dtype=np.float32)
    for i, c in enumerate(cands):
        best = sorted((tags.get(t, 0.0) for t in c.tags), reverse=True)[:3]
        out[i] = 0.6 * all_channels.get(_name(c.channel), 0.0) + 0.4 * sum(best) / 3
    return out


@dataclass
class _Hit:
    rank: int
    era: str
    source: str
    seed: str
    seed_title: str | None


def _hits(session: Session, user_id: int) -> dict[int, _Hit]:
    best: dict[int, _Hit] = {}
    for row in session.exec(
        select(DiscoveryHit).where(DiscoveryHit.user_id == user_id)
    ).all():
        current = best.get(row.discovery_video_id)
        if current is None or row.rank < current.rank:
            best[row.discovery_video_id] = _Hit(
                row.rank, row.era, row.source, row.seed, row.seed_title
            )
    return best


def build_feed(
    session: Session, runtime: DiscoveryRuntime, user_id: int, seed: int
) -> Feed:
    now = utcnow()
    history, cold = taste_history(session, user_id)
    own = watches(session, user_id)
    # Everything watched on YouTube is seen, not only the newest part ``own`` holds.
    own_keys = {w.key for w in own} | takeout_history.cached_profile(
        session, user_id
    ).watched
    excluded: Exclusions = exclusions(session, user_id)
    visits = earlier_visits(session, user_id)
    followed_urls: set[str] = set()
    followed_names: set[str] = set()
    for f in follows.list_follows(session, user_id):
        followed_urls.add(f.channel_url)
        if f.channel_name:
            followed_names.add(_name(f.channel_name))

    hits = _hits(session, user_id)
    cands = library_candidates(session)
    taken = {c.yt_id for c in cands if c.yt_id}
    cands += catalog_candidates(session, taken)
    cands += discovered_candidates(session, taken, set(hits))
    cands = [
        c
        for c in cands
        if c.key not in own_keys
        and not excluded.blocks(c.key, c.channel_url, c.channel)
    ]
    hit_of = {
        c.key: hits[c.discovery_id]
        for c in cands
        if c.discovery_id is not None and c.discovery_id in hits
    }

    # Channel strengths (and the reasons that name them) come from the user's
    # own watching, even when the household stands in for a short history.
    recent_ch, all_ch, old_ch = _channel_maps(own, now)
    sim = _similarity(session, runtime, cands, history, now)
    if sim is None:
        relevance = _taste_relevance(session, cands, history, all_ch)
        has_vector = np.zeros(len(cands), dtype=bool)
        recent_seed: list[str | None] = [None] * len(cands)
        dormant = np.zeros(len(cands), dtype=np.float32)
        dormant_seed: list[str | None] = [None] * len(cands)
        topic: list[int | None] = [None] * len(cands)
        topic_shares: dict[int, float] = {}
        floors = TASTE_FLOORS
    else:
        relevance, has_vector = sim.recent, np.isfinite(sim.recent_raw)
        recent_seed, dormant, dormant_seed = (
            sim.recent_seed,
            sim.dormant,
            sim.dormant_seed,
        )
        topic, topic_shares = sim.topic, sim.topic_shares
        floors = FLOORS
    cowatch = _cowatch(session, user_id) if not cold else {}

    rng = _rng(user_id, seed)
    jitter = rng.normal(0.0, 1.0, size=len(cands))
    buckets: dict[str, list[FeedItem]] = {name: [] for name in SHARES}
    leftovers: list[FeedItem] = []
    worn: list[FeedItem] = []
    new_channels: dict[str, ChannelStat] = {}

    for i, c in enumerate(cands):
        name = _name(c.channel)
        followed = bool(c.channel_url and c.channel_url in followed_urls) or (
            name in followed_names
        )
        known = all_ch.get(name, 0.0)
        lately = recent_ch.get(name, 0.0)
        long_ago = old_ch.get(name, 0.0)
        rel = float(relevance[i])
        back = float(dormant[i])
        hit = hit_of.get(c.key)
        if hit is not None and not has_vector[i]:
            # Found by a search or an up next list but not embedded (yet): the
            # source's own ranking stands in, just under the "new" floor's reach.
            rel = max(rel, floors["new"] + 0.3 * 0.9**hit.rank)
        quality = _quality(c.view_count)
        published = c.published
        recent_upload = published is not None and now - published <= SUBSCRIPTION_WINDOW
        seed_title = recent_seed[i] or (hit.seed_title if hit else None)

        if (followed or lately >= WATCHED_CHANNEL_LEVEL) and recent_upload:
            bucket = "subscriptions"
            score = (
                0.55 * _fresh(published, now, 10.0)
                + 0.25 * max(lately, 0.6 if followed else 0.0)
                + 0.20 * min(rel, 1.0)
            )
            text = (
                f"New from {c.channel}"
                if followed
                else f"New from {c.channel}, which you watch"
            )
            reason = Reason("subscription", text)
            eligible = True
        elif long_ago >= DORMANT_CHANNEL_LEVEL and lately == 0 and not followed:
            bucket = "throwback"
            score = 0.45 * long_ago + 0.35 * back + 0.2 * _fresh(published, now, 180.0)
            reason = Reason("throwback", f"You used to watch {c.channel}")
            eligible = True
        elif (back >= floors["throwback"] and back > rel + 0.15) or (
            hit is not None
            and hit.era == "throwback"
            and (not has_vector[i] or rel < floors["similar"])
        ):
            bucket = "throwback"
            title = dormant_seed[i] or (hit.seed_title if hit else None)
            score = (
                0.7 * max(back, rel)
                + 0.15 * quality
                + 0.15 * _fresh(published, now, 365.0)
            )
            reason = Reason(
                "throwback",
                f"Like {_short(title, 50)}, from a while back"
                if title and not cold
                else "From your older interests",
            )
            eligible = max(back, rel) >= floors["throwback"]
        elif known == 0 and not followed:
            bucket = "new"
            score = rel + 0.08 * quality + 0.05 * _fresh(published, now, 90.0)
            reason = Reason(
                "new_channel",
                "New channel for you",
                f"Because you watched {_short(seed_title)}"
                if seed_title and not cold
                else None,
            )
            eligible = rel >= floors["new"]
            if eligible:
                stat = new_channels.setdefault(
                    c.channel_url or name, ChannelStat(c.channel, c.channel_url)
                )
                stat.scores.append(score)
                stat.items.append(c)
                if seed_title:
                    stat.seeds.add(seed_title)
        else:
            bucket = "similar"
            boost = 0.1 * cowatch.get(c.video_id, 0.0) if c.video_id else 0.0
            score = (
                rel
                + 0.08 * known
                + 0.04 * _fresh(published, now, 60.0)
                + 0.04 * quality
                + boost
            )
            if cold:
                reason = (
                    Reason("library", "Picked from your library")
                    if c.pool == "library"
                    else Reason("similar", "Recommended for you")
                )
            elif seed_title and rel >= floors["similar"]:
                reason = Reason("similar", f"Because you watched {_short(seed_title)}")
            else:
                reason = Reason(
                    "similar", f"More from {c.channel}" if c.channel else "For you"
                )
            eligible = rel >= floors["similar"] or boost >= 0.05

        score += float(jitter[i]) * (NEW_JITTER if bucket == "new" else JITTER)
        seen = visits.get(c.key, 0)
        score -= impression_penalty(seen)
        item = FeedItem(c, bucket, score, reason, topic[i], followed)
        if worn_out(seen):
            worn.append(item)
        elif eligible:
            buckets[bucket].append(item)
        else:
            leftovers.append(item)

    for items in buckets.values():
        items.sort(key=lambda it: -it.score)
    leftovers.sort(key=lambda it: -it.score)
    worn.sort(key=lambda it: -it.score)
    mixed = mix(buckets, topic_shares)
    _vary_reasons(mixed, all_ch)
    mixed.extend(leftovers[: max(0, FEED_MAX - len(mixed))])
    mixed.extend(worn[: max(0, FEED_MAX - len(mixed))])
    return Feed(mixed[:FEED_MAX], new_channels, cold)


def effective_shares(present: set[str]) -> dict[str, float]:
    """``SHARES`` over the buckets that still have picks, summing to 1.

    The share of an empty bucket goes to the others in proportion, except that
    new channels and throwbacks stay a sprinkle (``SHARE_CAPS``): what they
    cannot take goes to the familiar buckets.
    """
    total = sum(SHARES[n] for n in present)
    out = {n: SHARES[n] / total for n in present}
    spare = 0.0
    for name, cap in SHARE_CAPS.items():
        if name in out and out[name] > cap:
            spare += out[name] - cap
            out[name] = cap
    familiar = [n for n in ("subscriptions", "similar") if n in out]
    if spare and familiar:
        base = sum(out[n] for n in familiar)
        for n in familiar:
            out[n] += spare * out[n] / base
    return out


def mix(
    buckets: dict[str, list[FeedItem]], topic_shares: dict[int, float] | None = None
) -> list[FeedItem]:
    """Interleave the buckets by ``SHARES`` (smooth weighted round robin).

    A pick must keep its channel ``CHANNEL_GAP`` slots from its last showing and
    its bucket within ``OVERFILL`` times its share; when no bucket can pick that
    way, the spacing and share give way, but ``CHANNEL_CAPS`` never do: picks
    past a cap wait at the end, best first.

    Within a bucket, a pick from an interest that has had less than its share
    of the history (``topic_shares``, at least ``MIN_TOPIC_SHARE``) gets
    ``TOPIC_BONUS`` per missing slot, so a smaller interest still shows up
    between the big ones.
    """
    shares = {t: max(v, MIN_TOPIC_SHARE) for t, v in (topic_shares or {}).items()}
    topic_picks: Counter[int] = Counter()
    #: Picks past their channel's cap: they go after everything else.
    overflow: list[FeedItem] = []
    queues = {name: list(items) for name, items in buckets.items() if items}
    credit = dict.fromkeys(queues, 0.0)
    picks: Counter[str] = Counter()
    shown: dict[str, Counter[str]] = defaultdict(Counter)
    out: list[FeedItem] = []
    last_channels: list[str] = []

    def capped(item: FeedItem) -> bool:
        cap = CHANNEL_CAPS.get(item.bucket)
        name = _name(item.candidate.channel)
        return cap is not None and bool(name) and shown[item.bucket][name] >= cap

    def spaced(item: FeedItem) -> bool:
        name = _name(item.candidate.channel)
        return not name or name not in last_channels[-(CHANNEL_GAP - 1) :]

    def within_share(bucket: str) -> bool:
        if len(queues) == 1:
            return True
        limit = max(1, math.floor(share[bucket] * OVERFILL * (len(out) + 1)))
        return picks[bucket] < limit

    def priority(item: FeedItem) -> float:
        if item.topic is None or item.topic not in shares:
            return item.score
        owed = shares[item.topic] * (len(out) + 1) - topic_picks[item.topic]
        return item.score + TOPIC_BONUS * max(0.0, owed)

    def choose(order: list[str], strict: bool) -> tuple[str, int] | None:
        for name in order:
            if strict and not within_share(name):
                continue
            usable = [
                (priority(item), -j, j)
                for j, item in enumerate(queues[name][:12])
                if not capped(item) and (not strict or spaced(item))
            ]
            if usable:
                return name, max(usable)[2]
        return None

    share: dict[str, float] = {}
    while queues:
        share = effective_shares(set(queues))
        for name in queues:
            credit[name] += share[name]
        order = sorted(queues, key=lambda n: -credit[n])
        picked = choose(order, strict=True) or choose(order, strict=False)
        if picked is None:
            # Only capped picks at the heads: set every capped pick aside, go again.
            for name in list(queues):
                overflow.extend(it for it in queues[name] if capped(it))
                kept = [it for it in queues[name] if not capped(it)]
                if kept:
                    queues[name] = kept
                else:
                    del queues[name]
                    credit.pop(name, None)
            continue
        name, j = picked
        item = queues[name].pop(j)
        credit[name] -= 1.0
        picks[name] += 1
        out.append(item)
        channel = _name(item.candidate.channel)
        last_channels.append(channel)
        shown[item.bucket][channel] += 1
        if item.topic is not None:
            topic_picks[item.topic] += 1
        if not queues[name]:
            del queues[name]
            credit.pop(name, None)
    overflow.sort(key=lambda it: -it.score)
    return out + overflow


def _vary_reasons(items: list[FeedItem], known: dict[str, float]) -> None:
    """Name the same watched video in at most ``SEED_REASON_MAX`` reasons."""
    used: Counter[str] = Counter()
    for item in items:
        reason = item.reason
        if reason.kind == "similar" and reason.text.startswith("Because you watched"):
            used[reason.text] += 1
            if used[reason.text] > SEED_REASON_MAX:
                channel = item.candidate.channel
                reason.text = (
                    f"More from {channel}"
                    if channel and known.get(_name(channel), 0.0) > 0
                    else "Recommended for you"
                )
        elif reason.kind == "new_channel" and reason.detail:
            used[reason.detail] += 1
            if used[reason.detail] > SEED_REASON_MAX:
                reason.detail = None


def history_fingerprint(session: Session, user_id: int) -> tuple[object, ...]:
    """Changes when the user watches something (their feed is then ranked again)."""
    from sqlalchemy import func

    from ...models import RecFeedback, UserStreamState

    lib = session.exec(
        select(func.max(col(UserVideoState.last_watched_at))).where(
            UserVideoState.user_id == user_id
        )
    ).one()
    streamed = session.exec(
        select(func.max(col(UserStreamState.last_watched_at))).where(
            UserStreamState.user_id == user_id
        )
    ).one()
    hits = session.exec(
        select(
            func.count(col(DiscoveryHit.id)), func.max(col(DiscoveryHit.found_at))
        ).where(DiscoveryHit.user_id == user_id)
    ).one()
    feedback = session.exec(
        select(func.count(col(RecFeedback.id)), func.max(col(RecFeedback.id))).where(
            RecFeedback.user_id == user_id
        )
    ).one()
    videos = session.exec(
        select(func.count(col(Video.id)), func.max(col(Video.id)))
    ).one()
    return (lib, streamed, *hits, *feedback, *videos)


def ranked_feed(
    session: Session,
    runtime: DiscoveryRuntime,
    user_id: int,
    seed: int,
    *,
    fresh: bool = True,
) -> Feed:
    """The feed for this user and seed.

    ``fresh`` (a first page): ranked again when anything it depends on changed.
    Otherwise (the next pages of a visit) the visit's ranking is kept even if
    the user watched something meanwhile, so an offset cursor never skips.
    """
    key = (user_id, seed)
    fingerprint = history_fingerprint(session, user_id)
    cached = runtime.feed(key)
    if (
        isinstance(cached, tuple)
        and isinstance(cached[1], Feed)
        and (not fresh or cached[0] == fingerprint)
    ):
        return cached[1]
    feed = build_feed(session, runtime, user_id, seed)
    runtime.store_feed(key, (fingerprint, feed))
    return feed

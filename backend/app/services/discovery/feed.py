"""The Recommended feed: six kinds of picks, ranked separately, then mixed.

Every candidate (``candidates``) lands in exactly one bucket:

* **subscriptions**: recent uploads of channels the user follows or watches a lot
  right now. The videos they will recognise.
* **similar**: close to what they watched in the last weeks (embeddings, or
  channels and tags without AI), from channels they already know, or already
  downloaded.
* **new**: as close, but from a channel they have never watched: discovery.
* **throwback**: close to an interest they have not touched lately, or from a
  channel they used to watch and stopped.
* **interest**: matches a topic they typed in (``topics``).
* **rewatch**: finished a while ago; the one bucket that shows watched videos.

``build_feed`` decides the bucket and the reason shown; what a pick is scored
on is its recipe (``scoring``), how well it fits is ``relevance``, and ``mix``
takes from the buckets in turn by the user's shares, spreading channels out.
A small seeded jitter, larger in ``new``, keeps the order from freezing and
lets a less certain new channel through now and then; ``seed`` changes on
refresh. Videos shown on many visits without being watched sink, then drop to
the end. Design: ``docs/adr/0019-recommended-plus.md`` and
``docs/adr/0024-tunable-recommended-plus.md``.
"""

from __future__ import annotations

import hashlib
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import numpy as np
from sqlmodel import Session, col, select

from ...models import DiscoveryHit, UserVideoState, Video, utcnow
from .. import follows
from ..ai.provider import get_embed_provider
from ..pagination import SEED_RANGE
from ..takeout import history as takeout_history
from . import scoring
from . import topics as topic_store
from .candidates import (
    Candidate,
    catalog_candidates,
    discovered_candidates,
    library_candidates,
)
from .feedback import (
    IMPRESSION_STEP,
    Exclusions,
    earlier_visits,
    exclusions,
    impression_penalty,
)
from .history import (
    PastFavorite,
    Watch,
    counts_as_taste,
    past_favorites,
    watch_log,
    watched_keys,
)
from .household import cowatched, taste_history
from .mix import FEED_MAX, mix, mix_stats
from .picks import ChannelStat, Feed, FeedItem, Reason, name_key, short
from .relevance import Vectors, channel_maps, similarity, taste_relevance
from .runtime import FEED_CACHE_TTL_SEC, DiscoveryRuntime
from .tuning import DEFAULTS, Tuning
from .tuning import for_user as load_tuning

#: The same "Because you watched ..." is shown at most this often.
SEED_REASON_MAX = 2
PAST_LIVE = frozenset({"was_live", "post_live"})


def _rng(user_id: int, seed: int) -> np.random.Generator:
    digest = hashlib.blake2b(f"{user_id}:{seed}".encode(), digest_size=8).digest()
    return np.random.default_rng(int.from_bytes(digest, "big"))


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


def _allowed(c: Candidate, t: Tuning, now: datetime, *, rewatch: bool = False) -> bool:
    """The user's hard filters: sources, past live streams, length, age.

    A rewatch keeps to the source switches (a library video is a library pick)
    but not to the upload age: an old favorite is old by design.
    """
    if c.pool == "library" and not t.use_library:
        return False
    if c.pool == "catalog" and not t.use_catalogs:
        return False
    if c.pool == "discovery" and not t.use_youtube:
        return False
    if (
        not rewatch
        and t.max_age_days
        and (c.published is None or now - c.published > timedelta(days=t.max_age_days))
    ):
        return False
    duration = c.duration
    if t.hide_past_live and c.live_status in PAST_LIVE:
        return False
    if duration is not None:
        if t.min_minutes and duration < 60 * t.min_minutes:
            return False
        if t.max_minutes and duration > 60 * t.max_minutes:
            return False
    return True


def _wear(seen: int, t: Tuning) -> tuple[float, bool]:
    """(score penalty, worn out) for a pick shown on ``seen`` earlier visits."""
    if t.worn_after == 0:
        return impression_penalty(seen), False
    return IMPRESSION_STEP * min(seen, t.worn_after), seen >= t.worn_after


def _ago(when: datetime, now: datetime) -> str:
    days = max(0, (now - when).days)
    if days >= 730:
        return f"{days // 365} years ago"
    if days >= 365:
        return "a year ago"
    if days >= 60:
        return f"{days // 30} months ago"
    return f"{max(days // 7, 1)} weeks ago"


def _found_by(c: Candidate, hit: _Hit | None) -> str:
    if c.pool == "library":
        return "Your library"
    if c.pool == "history":
        return "Your watch history"
    if c.pool == "catalog":
        return (
            f"The listed uploads of {c.channel}"
            if c.channel
            else "A channel video list"
        )
    if hit is not None:
        if hit.source == "search":
            return f"YouTube search: {hit.seed}"
        if hit.seed_title:
            return f"Up next from {short(hit.seed_title, 50)}"
        return "YouTube's up next"
    return "Found on YouTube"


def _history_candidate(fav: PastFavorite) -> Candidate:
    w = fav.watch
    yt_id = w.yt_id or ""
    return Candidate(
        key=w.key,
        pool="history",
        title=w.title,
        channel=w.channel,
        channel_url=w.channel_url,
        yt_id=yt_id or None,
        url=f"https://www.youtube.com/watch?v={yt_id}",
        source_channel_url=w.channel_url or None,
        duration=fav.duration,
    )


def _topic_fits(
    runtime: DiscoveryRuntime,
    cands: list[Candidate],
    vectors_of: Vectors,
    topics: topic_store.Topics,
    hit_of: dict[str, _Hit],
) -> tuple[list[topic_store.Topic | None], np.ndarray, list[topic_store.Topic | None]]:
    """Per candidate: the interest it matches best and how well (0..1), and the
    "similar" block that leaves it out, if any (see ``topics``)."""
    n = len(cands)
    best: list[topic_store.Topic | None] = [None] * n
    fit = np.zeros(n, dtype=np.float32)
    blocked: list[topic_store.Topic | None] = [None] * n
    if not topics.interests and not topics.blocks:
        return best, fit, blocked
    # Words, and searches made for the interest, are sure matches.
    for i, c in enumerate(cands):
        text = topic_store.haystack(c.title, c.channel, c.tags)
        hit = hit_of.get(c.key)
        for t in topics.interests:
            sure = t.in_text(text) or (
                hit is not None and hit.seed.strip().lower() == t.text.strip().lower()
            )
            if sure and fit[i] < 1.0:
                best[i], fit[i] = t, 1.0
    meaning = [*topics.interests, *(t for t in topics.blocks if t.match == "similar")]
    if not meaning or get_embed_provider() is None:
        return best, fit, blocked
    vectors = list(
        zip(
            meaning,
            topic_store.topic_vectors(runtime, [t.text for t in meaning]),
            strict=True,
        )
    )
    usable = [(t, v) for t, v in vectors if v is not None]
    if not usable:
        return best, fit, blocked
    dim = Counter(len(v) for _t, v in usable).most_common(1)[0][0]
    usable = [(t, v) for t, v in usable if len(v) == dim]
    matrix = np.asarray([v for _t, v in usable], dtype=np.float32)
    sims = vectors_of.sims(matrix)
    z = topic_store.standout(sims)
    raw = np.nan_to_num(sims, nan=-1.0)
    for j, (t, _v) in enumerate(usable):
        column = np.nan_to_num(z[:, j], nan=-np.inf)
        if t.kind == "block":
            for row in np.flatnonzero(
                (column >= topic_store.BLOCK_Z)
                & (raw[:, j] >= topic_store.MIN_TOPIC_COSINE)
            ).tolist():
                blocked[row] = blocked[row] or t
            continue
        for row in np.flatnonzero(
            (column >= topic_store.INTEREST_Z)
            & (raw[:, j] >= topic_store.MIN_TOPIC_COSINE)
        ).tolist():
            close = float(min(1.0, 0.5 + (column[row] - topic_store.INTEREST_Z) / 2))
            if close > fit[row]:
                best[row], fit[row] = t, close
    return best, fit, blocked


def build_feed(
    session: Session,
    runtime: DiscoveryRuntime,
    user_id: int,
    seed: int,
    tuning: Tuning = DEFAULTS,
) -> Feed:
    t = tuning
    now = utcnow()
    window = t.window
    topics = topic_store.active(session, user_id, now)
    # Hand-added interests get their own share; the rest scales down to fit.
    interest_share = topics.interest_share
    shares = {k: v * (1 - interest_share) for k, v in t.shares.normalized().items()}
    shares["interest"] = interest_share
    #: Per block (topic id), the candidates it left out (each once).
    blocked: defaultdict[int, set[str]] = defaultdict(set)

    def word_blocked(c: Candidate) -> bool:
        hit = topics.word_block(topic_store.haystack(c.title, c.channel, c.tags))
        if hit is not None:
            blocked[hit.id].add(c.key)
        return hit is not None

    excluded: Exclusions = exclusions(session, user_id)

    def shapes_taste(w: Watch) -> bool:
        return counts_as_taste(w, t.min_watched_pct) and w.key not in excluded.taste

    throwback_line = now - timedelta(days=window.throwback_after_days)
    history, cold = taste_history(session, user_id, throwback_line)
    history = [w for w in history if shapes_taste(w)]
    log = watch_log(session, user_id)
    # Everything watched on YouTube is seen, not only the part read for taste.
    own_keys = (
        watched_keys(session, user_id)
        | takeout_history.cached_profile(session, user_id).watched
    )
    visits = earlier_visits(session, user_id)
    followed_urls: set[str] = set()
    followed_names: set[str] = set()
    for f in follows.list_follows(session, user_id):
        followed_urls.add(f.channel_url)
        if f.channel_name:
            followed_names.add(name_key(f.channel_name))

    hits = _hits(session, user_id)
    pool = library_candidates(session)
    taken = {c.yt_id for c in pool if c.yt_id}
    pool += catalog_candidates(session, taken, runtime.catalog)
    pool += discovered_candidates(session, taken, set(hits))
    cands = [
        c
        for c in pool
        if c.key not in own_keys
        and not excluded.blocks(c.key, c.channel_url, c.channel)
        and _allowed(c, t, now)
        and not word_blocked(c)
    ]
    # Old favorites come back only through the rewatch bucket.
    favorite_of: dict[str, PastFavorite] = {}
    if shares["rewatch"] > 0:
        before = now - timedelta(days=t.rewatch_after_days)
        recent_keys = {w.key for w in log if w.watched_at >= before}
        by_key = {c.key: c for c in pool}
        # Already a candidate (never the case unless the history lost it): once.
        taken_keys = {c.key for c in cands}
        for favorite in past_favorites(session, user_id, before=before):
            key = favorite.watch.key
            if (
                key in recent_keys
                or key in favorite_of
                or key in taken_keys
                or key in excluded.taste
            ):
                continue
            c = by_key.get(key) or _history_candidate(favorite)
            if (
                excluded.blocks(key, c.channel_url, c.channel)
                or not _allowed(c, t, now, rewatch=True)
                or word_blocked(c)
            ):
                continue
            favorite_of[key] = favorite
            cands.append(c)
    hit_of = {
        c.key: hits[c.discovery_id]
        for c in cands
        if c.discovery_id is not None and c.discovery_id in hits
    }

    # Channel strengths (and the reasons that name them) come from the user's
    # own watching, even when the household stands in for a short history.
    recent_ch, all_ch, old_ch = channel_maps(
        [w for w in log if shapes_taste(w)], now, window
    )
    vectors_of = Vectors(session, runtime, cands)
    sim = similarity(session, runtime, cands, vectors_of, history, now, window)
    base_floors: dict[str, float]
    if sim is None:
        relevance = taste_relevance(session, cands, history, all_ch)
        has_vector = np.zeros(len(cands), dtype=bool)
        recent_seed: list[str | None] = [None] * len(cands)
        dormant = np.zeros(len(cands), dtype=np.float32)
        dormant_seed: list[str | None] = [None] * len(cands)
        topic: list[int | None] = [None] * len(cands)
        topic_shares: dict[int, float] = {}
        base_floors = scoring.TASTE_FLOORS
    else:
        relevance, has_vector = sim.recent, np.isfinite(sim.recent_raw)
        recent_seed, dormant, dormant_seed = (
            sim.recent_seed,
            sim.dormant,
            sim.dormant_seed,
        )
        topic, topic_shares = sim.topic, sim.topic_shares
        base_floors = scoring.FLOORS
    floors = {k: v * t.floor_multiplier(k) for k, v in base_floors.items()}
    # "Prefer downloaded videos" also takes looser matches from the library.
    library_floors = {k: v * t.library_floor_scale for k, v in floors.items()}
    interest_of, interest_fit, similar_block = _topic_fits(
        runtime, cands, vectors_of, topics, hit_of
    )
    cowatch = cowatched(session, user_id) if not cold and t.use_household else {}

    rng = _rng(user_id, seed)
    jitter = rng.normal(0.0, 1.0, size=len(cands))
    buckets: dict[str, list[FeedItem]] = {name: [] for name in shares}
    leftovers: list[FeedItem] = []
    worn: list[FeedItem] = []
    new_channels: dict[str, ChannelStat] = {}
    sub_window = timedelta(days=t.subscription_window_days)
    scorer = scoring.Scorer(t, now)

    for i, c in enumerate(cands):
        name = name_key(c.channel)
        floor = library_floors if c.pool == "library" else floors
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
            # source's own ranking stands in.
            rel = max(rel, scoring.unembedded_hit(floors["new"], hit.rank))
        published = c.published
        recent_upload = published is not None and now - published <= sub_window
        seed_title = recent_seed[i] or (hit.seed_title if hit else None)
        fav = favorite_of.get(c.key)
        block = similar_block[i]
        if block is not None:
            blocked[block.id].add(c.key)
            continue
        interest = interest_of[i]
        lift = cowatch.get(c.video_id, 0.0) if c.video_id else 0.0
        signals = {
            "taste": rel,
            "taste_capped": min(rel, 1.0),
            "known": known,
            "channel_now": max(
                lately, scoring.FOLLOWED_CHANNEL_LEVEL if followed else 0.0
            ),
            "long_ago": long_ago,
            "older": back,
            "older_or_taste": max(back, rel),
            "interest": float(interest_fit[i]),
            "cowatch": lift,
        }
        labels: dict[str, str] = {}
        if fav is not None:
            bucket = recipe = "rewatch"
            age = (now - fav.watch.watched_at).days
            signals["rewatched"] = 1.0 if fav.views > 1 else 0.0
            signals["time_away"] = min(1.0, age / 365)
            reason = Reason(
                "rewatch", f"You watched this {_ago(fav.watch.watched_at, now)}"
            )
            eligible = True
        elif (followed or lately >= scoring.WATCHED_CHANNEL_LEVEL) and recent_upload:
            bucket = recipe = "subscriptions"
            if followed:
                labels["channel_now"] = "Followed channel"
            text = (
                f"New from {c.channel}"
                if followed
                else f"New from {c.channel}, which you watch"
            )
            reason = Reason("subscription", text)
            eligible = True
        elif interest is not None:
            bucket = recipe = "interest"
            labels["interest"] = f"Match to your interest “{short(interest.text, 40)}”"
            reason = Reason("interest", f"For your interest: {interest.text}")
            eligible = True
        elif long_ago >= scoring.DORMANT_CHANNEL_LEVEL and lately == 0 and not followed:
            bucket, recipe = "throwback", "throwback_channel"
            reason = Reason("throwback", f"You used to watch {c.channel}")
            eligible = True
        elif (back >= floor["throwback"] and back > rel + scoring.THROWBACK_LEAD) or (
            hit is not None
            and hit.era == "throwback"
            and (not has_vector[i] or rel < floor["similar"])
        ):
            bucket, recipe = "throwback", "throwback_interest"
            title = dormant_seed[i] or (hit.seed_title if hit else None)
            reason = Reason(
                "throwback",
                f"Like {short(title, 50)}, from a while back"
                if title and not cold
                else "From your older interests",
            )
            eligible = max(back, rel) >= floor["throwback"]
        elif known == 0 and not followed and c.pool != "library":
            # A downloaded video is not a discovery, even from a channel the
            # user has yet to watch: it ranks with the familiar picks below.
            bucket = recipe = "new"
            reason = Reason(
                "new_channel",
                "New channel for you",
                f"Because you watched {short(seed_title)}"
                if seed_title and not cold
                else None,
            )
            eligible = rel >= floor["new"]
        else:
            bucket = recipe = "similar"
            if cold:
                reason = (
                    Reason("library", "Picked from your library")
                    if c.pool == "library"
                    else Reason("similar", "Recommended for you")
                )
            elif seed_title and rel >= floor["similar"]:
                reason = Reason("similar", f"Because you watched {short(seed_title)}")
            elif known == 0 and not followed and c.pool == "library":
                reason = Reason("library", "Picked from your library")
            else:
                reason = Reason(
                    "similar", f"More from {c.channel}" if c.channel else "For you"
                )
            eligible = rel >= floor["similar"] or lift >= scoring.COWATCH_QUALIFIES
        parts = scorer.parts(
            recipe, signals, published, scoring.quality(c.view_count), labels
        )

        if c.pool == "library" and t.library_bonus:
            parts.append(("Already downloaded", t.library_bonus))
        spread = (
            scoring.NEW_JITTER if bucket == "new" else scoring.JITTER
        ) * t.jitter_scale
        if spread:
            parts.append(("Shuffle", float(jitter[i]) * spread))
        penalty, tired = _wear(visits.get(c.key, 0), t)
        if penalty:
            parts.append(("Shown before without a watch", -penalty))
        parts = [(label, value) for label, value in parts if value]
        score = sum(value for _label, value in parts)
        item = FeedItem(
            c,
            bucket,
            score,
            reason,
            topic[i],
            followed,
            parts=parts,
            found_by=_found_by(c, hit),
            eligible=eligible,
        )
        if shares[bucket] <= 0:
            continue  # The user turned this kind of pick off.
        if bucket == "new" and eligible:
            stat = new_channels.setdefault(
                c.channel_url or name, ChannelStat(c.channel, c.channel_url)
            )
            stat.scores.append(score)
            stat.items.append(c)
            if seed_title:
                stat.seeds.add(seed_title)
            if hit is not None and hit.source == "search" and hit.seed:
                stat.queries[hit.seed] += 1
        if tired:
            worn.append(item)
        elif eligible:
            buckets[bucket].append(item)
        else:
            leftovers.append(item)

    for items in buckets.values():
        items.sort(key=lambda it: -it.score)
    leftovers.sort(key=lambda it: -it.score)
    worn.sort(key=lambda it: -it.score)
    mixed = mix(buckets, topic_shares, t, interest_share)
    _vary_reasons(mixed, all_ch)
    placed = len(mixed)
    mixed.extend(leftovers[: max(0, FEED_MAX - len(mixed))])
    mixed.extend(worn[: max(0, FEED_MAX - len(mixed))])
    left_out = {key for keys in blocked.values() for key in keys}
    return Feed(
        mixed[:FEED_MAX],
        new_channels,
        cold,
        mix_stats(mixed[:placed], shares),
        {tid: len(keys) for tid, keys in blocked.items()},
        # A rewatch is a video already seen; a category is for what is not.
        pool=[c for c in cands if c.key not in favorite_of and c.key not in left_out],
        known_channels=set(all_ch) | followed_names,
        followed_urls=followed_urls,
    )


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
                    if channel and known.get(name_key(channel), 0.0) > 0
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


def today_seed() -> int:
    """The default ordering seed: the same all day, so a plain reload is stable."""
    return date.today().toordinal() % SEED_RANGE


@dataclass(frozen=True)
class FeedState:
    """What a kept ranking is filed under, and what it is current for."""

    key: tuple[Any, ...]
    fingerprint: tuple[object, ...]
    seed: int
    tuning: Tuning


def feed_state(
    session: Session, user_id: int, seed: int, tuning: Tuning | None = None
) -> FeedState:
    tuned = tuning if tuning is not None else load_tuning(session, user_id)
    # A different tuning is a different feed: changing a slider never pages
    # through a ranking made with the old values.
    # Topics too: one that expires (or is added) ranks the feed again.
    topic_ids = topic_store.active_ids(session, user_id)
    return FeedState(
        (user_id, seed, tuned.model_dump_json(), topic_ids),
        history_fingerprint(session, user_id),
        seed,
        tuned,
    )


def kept_feed(
    runtime: DiscoveryRuntime,
    state: FeedState,
    *,
    fresh: bool = True,
    max_age: float = FEED_CACHE_TTL_SEC,
) -> Feed | None:
    """The ranking kept for ``state``; with ``fresh`` only one that is current."""
    cached = runtime.feed(state.key, max_age, paging=not fresh)
    if (
        isinstance(cached, tuple)
        and isinstance(cached[1], Feed)
        and (not fresh or cached[0] == state.fingerprint)
    ):
        return cached[1]
    return None


def rank(
    session: Session, runtime: DiscoveryRuntime, user_id: int, state: FeedState
) -> Feed:
    """Rank the feed and keep it. The caller holds ``runtime.ranking(user_id)``."""
    feed = build_feed(session, runtime, user_id, state.seed, state.tuning)
    runtime.store_feed(state.key, (state.fingerprint, feed))
    return feed


def ranked_feed(
    session: Session,
    runtime: DiscoveryRuntime,
    user_id: int,
    seed: int,
    *,
    fresh: bool = True,
    tuning: Tuning | None = None,
) -> Feed:
    """The feed for this user and seed.

    ``fresh`` (a first page): ranked again when anything it depends on changed.
    Otherwise (the next pages of a visit) the visit's ranking is kept even if
    the user watched something meanwhile, so an offset cursor never skips.
    For today's seed a current ranking is usually there already (``warm``).
    """
    state = feed_state(session, user_id, seed, tuning)
    feed = kept_feed(runtime, state, fresh=fresh)
    if feed is not None:
        return feed
    with runtime.ranking(user_id):
        # A request that arrived beside this one may have ranked it meanwhile.
        feed = kept_feed(runtime, state, fresh=fresh)
        if feed is None:
            feed = rank(session, runtime, user_id, state)
    return feed

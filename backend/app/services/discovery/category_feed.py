"""What each of a user's categories shows on Recommended.

A category (``category_store``: one of the user's interests) is not a filter
over the ranked feed. Its list is drawn from every candidate the feed
considered (``Feed.pool``: the library, listed channels' uploads and videos
found on YouTube, after the feed's exclusions), measured against the category's
centre:

- **Fit.** A candidate's closeness is placed between what the embed model gives
  unrelated videos (the pool's bottom tenth) and the category's nearest videos
  (``_position``), so the cuts hold across models. A *close* match clears
  ``CLOSE`` and has this category as its best, or nearly (``COMPETE``): a
  hardware video near "Programming" but nearer "PC hardware" is only in the
  latter. Anything else above ``LOOSE`` is a *loose* match, listed after the
  close ones ("Further afield"), so a category thins out instead of ending.
- **Age.** Where the user watches recent uploads (``RecCategory.half_life_days``)
  an old video's fit is cut down (never below ``AGE_FLOOR`` of it), which moves
  it from close to loose; where they watch old ones it is not.
- **Channels.** No channel twice within ``SPREAD`` places while others have
  something to show (``spread``).
- **Familiar and new.** Videos from the library, a listed channel, or a channel
  the user has watched or follows lead; channels new to them are woven in as
  related lists weave in other interests (``other_interests.weave``, ADR 0043):
  the share follows the user's algorithm (``Tuning.category_new_share``), grows
  when the category has little that is familiar, and rises down the list.

Design: ``docs/adr/0044-personal-categories.md``.
"""

from __future__ import annotations

import heapq
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import partial

import numpy as np
from sqlmodel import Session

from ...models import RecCategory, as_utc, require_id
from . import category_store, scoring
from .candidates import Candidate
from .other_interests import _crowding, weave
from .picks import ChannelStat, Feed, FeedItem, Reason, name_key
from .relevance import candidate_sims
from .runtime import DiscoveryRuntime
from .tuning import Tuning

#: Where a close match starts, on the scale of ``_position`` (0: as near as an
#: unrelated video, 1: as near as the category's nearest ones).
CLOSE = 0.55
#: ... and how far below its best category a candidate may be and still count.
COMPETE = 0.1
LOOSE = 0.3
#: The nearest videos whose mean closeness is "in the category".
_NEAREST = 10
#: A pool whose closeness spans less than this is all one topic.
_MIN_SPAN = 0.05
#: Age never takes more than this off a video's fit (as a factor).
AGE_FLOOR = 0.25
#: A channel shows once in any run of this many places.
SPREAD = 4
#: Close matches a category needs before it is offered as a chip.
MIN_CATEGORY_PICKS = 12
MAX_CHIPS = 8
QUALITY_WEIGHT = 0.05
SHUFFLE_WEIGHT = 0.03
#: Opening a category again within this does not write its row again.
_WANTED_STAMP_EVERY = timedelta(minutes=10)


@dataclass(frozen=True)
class Chip:
    """A category as the feed keeps it (the feed outlives the request's rows)."""

    id: int
    name: str
    half_life_days: float | None


def _position(col: np.ndarray) -> tuple[np.ndarray, float, float]:
    """``col`` (cosines to one centre, NaN without a vector) on the 0..1 scale,
    with the scale's zero and span (kept to place later arrivals)."""
    known = np.sort(col[np.isfinite(col)])
    if not known.size:
        return np.full(col.shape, np.nan, dtype=np.float32), 0.0, 0.0
    unrelated = float(np.percentile(known, 10))
    span = float(known[-_NEAREST:].mean()) - unrelated
    if span < _MIN_SPAN:
        # Everything known is about as near: one topic, all of it close.
        return (
            np.where(np.isfinite(col), 1.0, np.nan).astype(np.float32),
            unrelated,
            0.0,
        )
    return ((col - unrelated) / span).astype(np.float32), unrelated, span


def _age_factor(c: Candidate, half_life_days: float | None, now: datetime) -> float:
    if half_life_days is None or c.published is None:
        return 1.0
    age = max(0.0, (now - c.published).total_seconds() / 86400)
    return max(AGE_FLOOR, float(0.5 ** (age / half_life_days)))


def _spread(items: list[tuple[str, int]], window: int = SPREAD) -> list[int]:
    """``items`` are (channel, index) in ranked order; returns the indexes with
    no channel twice in any ``window`` places while another channel has one to
    show. Nothing is dropped: a held-back video takes the next place it may.
    """
    queues: dict[str, deque[tuple[int, int]]] = defaultdict(deque)
    for rank, (name, index) in enumerate(items):
        queues[name].append((rank, index))
    heap = [(queue[0][0], name) for name, queue in queues.items()]
    heapq.heapify(heap)
    lately: deque[str] = deque(maxlen=max(0, window - 1))
    out: list[int] = []
    while heap:
        held: list[tuple[int, str]] = []
        while heap and heap[0][1] in lately:
            held.append(heapq.heappop(heap))
        # Only channels just shown are left: the best of them, all the same.
        _rank, name = heapq.heappop(heap) if heap else held.pop(0)
        for entry in held:
            heapq.heappush(heap, entry)
        _r, index = queues[name].popleft()
        out.append(index)
        lately.append(name)
        if queues[name]:
            heapq.heappush(heap, (queues[name][0][0], name))
    return out


def _turns(items: list[tuple[str, int]]) -> list[int]:
    """(channel, index) in ranked order, each channel taking a turn: no channel
    a second place before every other has had one."""
    queues: dict[str, deque[int]] = defaultdict(deque)
    for name, index in items:
        queues[name].append(index)
    out: list[int] = []
    while queues:
        for name in list(queues):
            out.append(queues[name].popleft())
            if not queues[name]:
                del queues[name]
    return out


@dataclass
class Listing:
    """One category's list, in order. Only ever added to at the end, so a
    visit's offsets stay good."""

    items: list[FeedItem]
    #: Channels new to the user among the close matches (for suggestions).
    channels: dict[str, ChannelStat]
    keys: set[str]


@dataclass
class _Measured:
    row: Chip
    centre: np.ndarray
    #: Aged fit of every pool candidate (NaN without a vector).
    aged: np.ndarray
    fit: np.ndarray
    close: np.ndarray
    loose: np.ndarray
    unrelated: float
    span: float


@dataclass
class Browse:
    """The user's categories measured against one ranked feed's pool."""

    version: object
    feed: Feed
    user_id: int
    seed: int
    tuning: Tuning
    now: datetime
    measured: dict[int, _Measured] = field(default_factory=dict)
    #: The categories offered as chips, in order.
    listed: list[Chip] = field(default_factory=list)
    _lists: dict[int, Listing] = field(default_factory=dict)

    def _familiar(self, c: Candidate) -> bool:
        return (
            c.pool in ("library", "catalog")
            or name_key(c.channel) in self.feed.known_channels
            or bool(c.channel_url and c.channel_url in self.feed.followed_urls)
        )

    def _item(
        self,
        m: _Measured,
        c: Candidate,
        fit: float,
        aged: float,
        extra: float,
        *,
        loose: bool,
    ) -> FeedItem:
        familiar = self._familiar(c)
        parts = [
            (f"Match to “{m.row.name}”", fit),
            ("Older than what you watch here", aged - fit),
            ("Popularity and shuffle", extra),
        ]
        parts = [(label, float(value)) for label, value in parts if value]
        return FeedItem(
            c,
            "similar" if familiar else "new",
            float(sum(value for _label, value in parts)),
            Reason(
                "category",
                f"In {m.row.name}",
                f"Loosely related to {m.row.name}"
                if loose
                else f"Close to what you watch in {m.row.name}",
            ),
            followed=bool(c.channel_url and c.channel_url in self.feed.followed_urls),
            parts=parts,
            loose=loose,
        )

    def listing(self, category_id: int) -> Listing | None:
        """The category's list, built the first time it is asked for."""
        with self.feed.lock:
            if category_id not in self._lists:
                m = self.measured.get(category_id)
                if m is None:
                    return None
                self._lists[category_id] = self._build(category_id, m)
            return self._lists[category_id]

    def _build(self, category_id: int, m: _Measured) -> Listing:
        pool = self.feed.pool
        rng = np.random.default_rng([self.user_id, self.seed, category_id])
        jitter = rng.normal(0.0, 1.0, size=len(pool))
        extra = np.asarray(
            [QUALITY_WEIGHT * scoring.quality(c.view_count) for c in pool],
            dtype=np.float32,
        ) + SHUFFLE_WEIGHT * jitter.astype(np.float32)
        score = m.aged + extra
        familiar = np.asarray([self._familiar(c) for c in pool], dtype=bool)
        new_share = self.tuning.category_new_share
        # Little that is familiar: more of the list goes to channels new to them.
        share = new_share + (1 - new_share) * (
            1 - _crowding(int((m.close & familiar).sum()))
        )
        items: list[FeedItem] = []
        channels: dict[str, ChannelStat] = {}

        def add(i: int, *, loose: bool) -> bool:
            items.append(
                self._item(
                    m,
                    pool[i],
                    float(m.fit[i]),
                    float(m.aged[i]),
                    float(extra[i]),
                    loose=loose,
                )
            )
            return True

        for tier, loose in ((m.close, False), (m.loose, True)):
            ranked = sorted(np.flatnonzero(tier).tolist(), key=lambda i: -score[i])
            known = _spread(
                [(name_key(pool[i].channel), i) for i in ranked if familiar[i]]
            )
            fresh = iter(
                _turns(
                    [(name_key(pool[i].channel), i) for i in ranked if not familiar[i]]
                )
            )
            weave(known, fresh, partial(add, loose=loose), share)
            # No familiar video left to follow: the rest of the new ones.
            for i in fresh:
                add(i, loose=loose)
            if not loose:
                for i in ranked:
                    c = pool[i]
                    if familiar[i]:
                        continue
                    stat = channels.setdefault(
                        c.channel_url or name_key(c.channel),
                        ChannelStat(c.channel, c.channel_url),
                    )
                    stat.scores.append(float(m.aged[i]))
                    stat.items.append(c)
        return Listing(items, channels, {item.candidate.key for item in items})

    def append(
        self,
        session: Session,
        runtime: DiscoveryRuntime,
        category_id: int,
        candidates: list[Candidate],
    ) -> int:
        """Add later arrivals (a top-up's finds) that fit the category to the
        end of its list, closest first; returns how many."""
        made = self.listing(category_id)
        m = self.measured.get(category_id)
        if made is None or m is None:
            return 0
        with self.feed.lock:
            return self._append(session, runtime, m, made, candidates)

    def _append(
        self,
        session: Session,
        runtime: DiscoveryRuntime,
        m: _Measured,
        made: Listing,
        candidates: list[Candidate],
    ) -> int:
        # What the feed itself would not show (watched, too short, a source
        # turned off, ...) is not added here either.
        fresh = [
            c for c in candidates if c.key not in made.keys and self.feed.admits(c)
        ]
        if not fresh:
            return 0
        sims = candidate_sims(session, runtime, fresh, m.centre[None, :])[:, 0]
        placed: list[tuple[float, float, Candidate]] = []
        for c, sim in zip(fresh, sims, strict=True):
            if not np.isfinite(sim):
                continue
            if m.span > 0:
                fit = float((sim - m.unrelated) / m.span)
            else:
                # Everything known was about as near (one topic): as near, or not.
                fit = 1.0 if sim >= m.unrelated - _MIN_SPAN else 0.0
            aged = (
                fit * _age_factor(c, m.row.half_life_days, self.now) if fit > 0 else fit
            )
            if aged >= LOOSE:
                placed.append((aged, fit, c))
        placed.sort(key=lambda entry: -entry[0])
        # Past the divider everything is "further afield", however close.
        past = any(item.loose for item in made.items)
        for aged, fit, c in placed:
            made.items.append(
                self._item(m, c, fit, aged, 0.0, loose=past or aged < CLOSE)
            )
            made.keys.add(c.key)
        return len(placed)


def _version(rows: list[RecCategory]) -> object:
    """What a visit sees of the categories: which there are, their names and
    how age counts. Not their centres, which move a little with every watch:
    the lists made for a feed stay as they are for as long as it is kept."""
    return tuple((r.id, r.name, r.half_life_days) for r in rows)


def prepare(
    session: Session,
    runtime: DiscoveryRuntime,
    feed: Feed,
    user_id: int,
    seed: int,
    tuning: Tuning,
    now: datetime,
) -> Browse:
    """The user's categories measured against ``feed``; kept on the feed until
    the categories change."""
    rows = category_store.rows(session, user_id)
    version = _version(rows)
    # One at a time: the first page and the channel suggestions ask together.
    with feed.lock:
        kept = feed.browse
        if isinstance(kept, Browse) and kept.version == version:
            return kept
        browse = _measure(session, runtime, feed, user_id, seed, tuning, now, rows)
        browse.version = version
        feed.browse = browse
        return browse


def _measure(
    session: Session,
    runtime: DiscoveryRuntime,
    feed: Feed,
    user_id: int,
    seed: int,
    tuning: Tuning,
    now: datetime,
    rows: list[RecCategory],
) -> Browse:
    browse = Browse(None, feed, user_id, seed, tuning, now)
    dims = [r.dim for r in rows if r.dim > 0]
    pool = feed.pool
    if not dims or not pool:
        return browse
    dim = max(set(dims), key=dims.count)
    rows = [r for r in rows if r.dim == dim]
    centres = np.asarray([category_store.centre(r) for r in rows], dtype=np.float32)
    norms = np.linalg.norm(centres, axis=1, keepdims=True)
    centres = (centres / np.maximum(norms, 1e-12)).astype(np.float32)
    sims = candidate_sims(session, runtime, pool, centres)
    fits = np.full(sims.shape, np.nan, dtype=np.float32)
    aged = np.full(sims.shape, np.nan, dtype=np.float32)
    scales: list[tuple[float, float]] = []
    for j, row in enumerate(rows):
        fits[:, j], unrelated, span = _position(sims[:, j])
        scales.append((unrelated, span))
        factor = np.asarray(
            [_age_factor(c, row.half_life_days, now) for c in pool], dtype=np.float32
        )
        aged[:, j] = np.where(fits[:, j] > 0, fits[:, j] * factor, fits[:, j])
    has = np.isfinite(aged).all(axis=1)
    best = np.where(has, np.nan_to_num(aged, nan=-np.inf).max(axis=1), np.inf)
    for j, stored in enumerate(rows):
        chip = Chip(require_id(stored), stored.name, stored.half_life_days)
        col = np.nan_to_num(aged[:, j], nan=-np.inf)
        close = has & (col >= CLOSE) & (col >= best - COMPETE)
        loose = has & (col >= LOOSE) & ~close
        browse.measured[chip.id] = _Measured(
            chip, centres[j], aged[:, j], fits[:, j], close, loose, *scales[j]
        )
        if int(close.sum()) >= MIN_CATEGORY_PICKS and len(browse.listed) < MAX_CHIPS:
            browse.listed.append(chip)
    return browse


def wanted(session: Session, row: RecCategory, now: datetime) -> None:
    """The user opened this category: its searches go first for a while."""
    if row.wanted_at is None or now - as_utc(row.wanted_at) > _WANTED_STAMP_EVERY:
        row.wanted_at = now
        session.add(row)
        session.commit()

"""Places in a related list for the viewer's other interests.

A related list ranked only by closeness to the playing video is one topic deep:
under a Counter-Strike stream, with enough Counter-Strike downloaded or listed,
every place is Counter-Strike. ``weave`` gives some places to picks from the
viewer's Recommended feed that are about something else
(``other_interest_picks``), so the list stays mostly on the video's topic
without being only that.

How many places, and where, is not fixed:

- **The more crowded the topic, the more places** (``Others.share``). A topic
  with a handful of videos runs out by itself and the list drifts to other
  things anyway; one with hundreds would fill every place.
- **The viewer's algorithm sets the most** (``Tuning.related_other_share``):
  Explorer leaves the topic more, Familiar less.
- **Deeper in the list, more often** (``_rate``). The first places are always
  on the topic (what autoplay plays next); the end of a long list is where
  someone done with the topic looks.
- **Nearby interests first, every interest a turn** (``_order``). Picks close to
  the video without being on its topic (another shooter under Counter-Strike)
  come before unrelated ones, and no interest gets a second place before each
  has had one.

Design: ``docs/adr/0043-related-lists-adapt-to-the-topic.md``.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

import numpy as np
from sqlmodel import Session

from ..ai import vector_index
from ..parental import AllowList
from .candidates import Candidate
from .feed import ranked_feed, today_seed
from .picks import FeedItem, name_key
from .relevance import candidate_sims
from .runtime import DiscoveryRuntime
from .tuning import for_user as load_tuning

#: Places at the top of a list that are always on the video's topic.
LEAD = 3
#: Over this many places after ``LEAD`` the rate of other interests grows from
#: ``RAMP_FROM`` to ``RAMP_TO`` times the list's share (about the share overall).
RAMP_PLACES = 16
RAMP_FROM = 0.6
RAMP_TO = 1.4
#: A pick is about something else when it sits in the lower part of the range
#: between "unrelated" and "as close as the video's nearest neighbours" (0..1).
OTHER_TOPIC_BELOW = 0.5
#: ... and nearby (close to the video, but not its topic) above this part.
NEARBY_ABOVE = 0.25
#: The nearest neighbours whose mean closeness is "on the video's topic".
_NEAREST = 10
#: Videos known on the video's topic at which a list starts to give places to
#: other interests, and at which it gives its full share.
THIN_TOPIC = 6
CROWDED_TOPIC = 48
#: Picks handed to a list. The same for every page of a list (a page that got
#: fewer would order its videos differently from the next), and more than the
#: longest list has places for, since a pick already in the list is passed over.
MAX_PICKS = 48


@dataclass(frozen=True)
class Viewer:
    """Whose other interests a related list shows."""

    user_id: int
    runtime: DiscoveryRuntime
    #: Parental controls: only these channels' picks (None: every channel).
    allowed: AllowList | None = None


@dataclass
class Others:
    """What a related list mixes in: the picks, in order, and how many places."""

    picks: list[Candidate] = field(default_factory=list)
    #: The share of the list (0..1) other interests get, before ``_rate``.
    share: float = 0.0


def _rate(share: float, place: int) -> float:
    """How much of the place after the first ``place`` is owed to other
    interests (``weave`` adds them up and gives a place per whole one), so
    ``share`` is about the part of a long list they get."""
    if place < LEAD:
        return 0.0
    ramp = min(place - LEAD, RAMP_PLACES) / RAMP_PLACES
    return share * (RAMP_FROM + (RAMP_TO - RAMP_FROM) * ramp)


def weave[T](
    on_topic: Iterable[T],
    others: Iterable[T],
    add: Callable[[T], bool],
    share: float,
) -> None:
    """Hand ``add`` the on-topic items, with one of ``others`` after one
    whenever the places filled so far owe a whole place to other interests
    (``_rate``).

    ``add`` returns False for an item it did not take (a duplicate, or the list
    is full); that item does not count as a place. The places depend only on
    their position, so every page of a list is a slice of one sequence.
    """
    spare = iter(others)
    # Half a place up front: the first other interest comes soon after the
    # lead instead of waiting for a whole place to add up.
    owed = 0.5 if share > 0 else 0.0
    place = 0
    for item in on_topic:
        if not add(item):
            continue
        place += 1
        owed += _rate(share, place)
        # Never two in a row: what is still owed waits for the next on-topic one.
        if owed >= 1 and any(add(other) for other in spare):
            owed -= 1
            place += 1
            owed += _rate(share, place)


@dataclass(frozen=True)
class _Scale:
    """Closeness to the playing video, measured against what this embed model
    gives everything Horde knows (cosines differ a lot between models)."""

    #: Below this a video is about something else.
    other: float
    #: Above this (and below ``other``) a video is a nearby interest.
    nearby: float
    #: Known videos on the video's topic (at or above ``other``).
    depth: int


def _scale(
    session: Session, runtime: DiscoveryRuntime, unit: np.ndarray
) -> _Scale | None:
    """``_Scale`` for ``unit``, placed between what the model gives unrelated
    videos (the bottom tenth of every vector known: library, channel video
    lists, found videos) and the video's nearest neighbours. None when no
    vector can be compared."""
    _ids, library = vector_index.video_scores(session, [unit.tolist()])
    parts = [library[:, 0]] if library.size else []
    store = runtime.vectors.matrix(session)
    if store.dim == unit.shape[0] and len(store.rows):
        parts.append(store.rows @ unit)
    known = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    known = np.sort(known[np.isfinite(known)])
    if not known.size:
        return None
    unrelated = float(np.percentile(known, 10))
    span = float(known[-_NEAREST:].mean()) - unrelated
    other = unrelated + OTHER_TOPIC_BELOW * span
    return _Scale(
        other=other,
        nearby=unrelated + NEARBY_ABOVE * span,
        depth=int(known.size - np.searchsorted(known, other, side="left")),
    )


def _crowding(depth: int) -> float:
    """0 for a topic too thin to fill a list .. 1 for a crowded one."""
    return float(np.clip((depth - THIN_TOPIC) / (CROWDED_TOPIC - THIN_TOPIC), 0, 1))


def _interest(item: FeedItem) -> tuple[str, object]:
    """Which of the viewer's interests a pick belongs to: its recent interest
    when the feed knows it, else its channel."""
    if item.topic is not None:
        return ("topic", item.topic)
    return ("channel", name_key(item.candidate.channel))


def _order(items: list[FeedItem], nearby: list[bool]) -> list[Candidate]:
    """``items`` (feed order) taking turns by interest: each round gives every
    interest one place, nearby picks first (within an interest and across them),
    then the feed's order."""
    queues: dict[tuple[str, object], list[tuple[bool, int]]] = defaultdict(list)
    for rank, (item, near) in enumerate(zip(items, nearby, strict=True)):
        queues[_interest(item)].append((not near, rank))
    for queue in queues.values():
        queue.sort()
    ordered: list[Candidate] = []
    while queues:
        heads = sorted(queues, key=lambda key: queues[key][0])
        for key in heads:
            _far, rank = queues[key].pop(0)
            ordered.append(items[rank].candidate)
            if not queues[key]:
                del queues[key]
    return ordered


def other_interest_picks(
    session: Session,
    viewer: Viewer,
    *,
    vector: list[float] | None,
    channel: str | None,
    library_only: bool = False,
) -> Others:
    """The viewer's Recommended picks that are not about the video with this
    embedding ``vector`` and ``channel`` (``MAX_PICKS`` at most, in ``_order``),
    and the share of the list they get.

    Never from the video's own channel. With a vector, only picks clearly less
    close to it than its nearest neighbours (``_scale``); a pick without a
    vector could be on the same topic and is left out. Without one (no AI), the
    other channels' picks, at the full share: the list is then the channel's
    videos, as one topic as a list gets. The day's ranking is used as it is
    cached: a related list does not rank the feed again for every video opened.
    """
    tuning = load_tuning(session, viewer.user_id)
    feed = ranked_feed(
        session,
        viewer.runtime,
        viewer.user_id,
        today_seed(),
        fresh=False,
        tuning=tuning,
    )
    own = name_key(channel or "")
    items = [
        item
        for item in feed.items
        if item.eligible
        and name_key(item.candidate.channel) != own
        and (item.candidate.video_id is not None or not library_only)
        and _allowed(viewer.allowed, item.candidate)
    ]
    most = tuning.related_other_share
    if vector is None:
        return Others(_order(items, [False] * len(items))[:MAX_PICKS], most)
    unit = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(unit))
    if not norm > 0:
        return Others()
    unit = unit / norm
    scale = _scale(session, viewer.runtime, unit)
    if scale is None:
        return Others()
    share = most * _crowding(scale.depth)
    if not items or share <= 0:
        return Others(share=share)
    sims = candidate_sims(
        session, viewer.runtime, [i.candidate for i in items], unit[None, :]
    )[:, 0]
    # NaN (no vector) fails both comparisons and is left out.
    kept = [
        (item, bool(sim >= scale.nearby))
        for item, sim in zip(items, sims, strict=True)
        if sim < scale.other
    ]
    ordered = _order([item for item, _ in kept], [near for _, near in kept])
    return Others(ordered[:MAX_PICKS], share)


def _allowed(allowed: AllowList | None, c: Candidate) -> bool:
    """Parental controls, as the related endpoints apply them to their lists."""
    if allowed is None:
        return True
    if c.video_id is not None:
        return allowed.allows_library(c.channel_url, c.channel)
    return allowed.allows(c.source_channel_url, c.channel)

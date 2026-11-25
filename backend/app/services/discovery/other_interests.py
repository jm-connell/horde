"""A few places in a related list for the viewer's other interests.

A related list ranked only by closeness to the playing video is one topic deep:
under a Counter-Strike stream, with enough Counter-Strike downloaded or listed,
every place is Counter-Strike. ``weave`` gives every fourth place to a pick
from the viewer's Recommended feed that is about something else
(``other_interest_picks``), so the list stays mostly on the video's topic
without being only that. Design: ``docs/adr/0041-related-lists-keep-other-interests.md``.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass

import numpy as np
from sqlmodel import Session

from ..ai import vector_index
from ..parental import AllowList
from .candidates import Candidate
from .feed import ranked_feed, today_seed
from .picks import name_key
from .relevance import candidate_sims
from .runtime import DiscoveryRuntime

#: On-topic videos between two picks from another interest (one place in four).
ON_TOPIC_RUN = 3
#: A pick is about something else when it sits in the lower part of the range
#: between "unrelated" and "as close as the video's nearest neighbours" (0..1).
OTHER_TOPIC_BELOW = 0.5
#: The nearest neighbours whose mean closeness is "on the video's topic".
_NEAREST = 10
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


def weave[T](
    on_topic: Iterable[T], others: Iterable[T], add: Callable[[T], bool]
) -> None:
    """Hand ``add`` the on-topic items, and one of ``others`` after every
    ``ON_TOPIC_RUN`` of them it took.

    ``add`` returns False for an item it did not take (a duplicate, or the list
    is full); that item does not count as a place.
    """
    spare = iter(others)
    run = 0
    for item in on_topic:
        if not add(item):
            continue
        run += 1
        if run == ON_TOPIC_RUN:
            run = 0
            any(add(other) for other in spare)


def _topic_cut(
    session: Session, runtime: DiscoveryRuntime, unit: np.ndarray
) -> float | None:
    """The closeness to ``unit`` under which a video is about something else.

    Cosines differ a lot between embed models, so the cut is placed between
    what this model gives unrelated videos (the bottom tenth of every vector
    known: library, channel video lists, found videos) and the video's nearest
    neighbours. None when no vector can be compared.
    """
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
    nearest = float(known[-_NEAREST:].mean())
    return unrelated + OTHER_TOPIC_BELOW * (nearest - unrelated)


def other_interest_picks(
    session: Session,
    viewer: Viewer,
    *,
    vector: list[float] | None,
    channel: str | None,
    library_only: bool = False,
) -> list[Candidate]:
    """The viewer's Recommended picks that are not about the video with this
    embedding ``vector`` and ``channel``, best first (``MAX_PICKS`` at most).

    Never from the video's own channel. With a vector, only picks clearly less
    close to it than its nearest neighbours (``_topic_cut``); a pick without a
    vector could be on the same topic and is left out. Without one (no AI), the
    other channels' picks. The day's ranking is used as it is cached: a related
    list does not rank the feed again for every video opened.
    """
    feed = ranked_feed(
        session, viewer.runtime, viewer.user_id, today_seed(), fresh=False
    )
    own = name_key(channel or "")
    cands = [
        item.candidate
        for item in feed.items
        if item.eligible
        and name_key(item.candidate.channel) != own
        and (item.candidate.video_id is not None or not library_only)
        and _allowed(viewer.allowed, item.candidate)
    ]
    if vector is None or not cands:
        return cands[:MAX_PICKS]
    unit = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(unit))
    if not norm > 0:
        return []
    unit = unit / norm
    cut = _topic_cut(session, viewer.runtime, unit)
    if cut is None:
        return []
    sims = candidate_sims(session, viewer.runtime, cands, unit[None, :])[:, 0]
    return [c for c, sim in zip(cands, sims, strict=True) if sim < cut][:MAX_PICKS]


def _allowed(allowed: AllowList | None, c: Candidate) -> bool:
    """Parental controls, as the related endpoints apply them to their lists."""
    if allowed is None:
        return True
    if c.video_id is not None:
        return allowed.allows_library(c.channel_url, c.channel)
    return allowed.allows(c.source_channel_url, c.channel)

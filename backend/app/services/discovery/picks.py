"""What a ranking is made of: the picks, why each is there, and the feed."""

from __future__ import annotations

import threading
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from .candidates import Candidate


@dataclass
class Reason:
    kind: str  # subscription | similar | new_channel | throwback | rewatch | library
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
    #: What the score is made of, for "Why this?" (they add up to ``score``).
    parts: list[tuple[str, float]] = field(default_factory=list)
    #: Where the candidate came from (a search, an up next list, the library).
    found_by: str | None = None
    #: Close enough to the user's taste for its bucket (else it waits at the end).
    eligible: bool = True
    #: In a category's list: past the close matches ("Further afield").
    loose: bool = False


@dataclass
class ChannelStat:
    """A channel new to the user, as the feed saw it (for suggestions)."""

    name: str
    url: str
    scores: list[float] = field(default_factory=list)
    items: list[Candidate] = field(default_factory=list)
    seeds: set[str] = field(default_factory=set)
    #: The YouTube searches that found its videos, and how many each found.
    queries: Counter[str] = field(default_factory=Counter)


@dataclass
class MixStat:
    bucket: str
    #: The share the user asked for (0..1).
    target: float
    #: The share it got among the top ``MIX_STATS_TOP`` picks.
    actual: float


@dataclass
class Feed:
    items: list[FeedItem]
    new_channels: dict[str, ChannelStat]
    cold: bool
    mix: list[MixStat] = field(default_factory=list)
    #: Candidates each block (by topic id) left out of this ranking.
    blocked: dict[int, int] = field(default_factory=dict)
    #: Each AI category's picks (keys), measured once per version of the
    #: categories (``categories.py``): (version, picks by category).
    categories: tuple[object, dict[str, set[str]]] | None = None
    #: Every candidate that passed the feed's filters, placed or not: what a
    #: category's list is drawn from (``category_feed.py``).
    pool: list[Candidate] = field(default_factory=list)
    #: Channels (``name_key``) the user has watched or follows, and the URLs of
    #: those they follow: a video of theirs is familiar, not new.
    known_channels: set[str] = field(default_factory=set)
    followed_urls: set[str] = field(default_factory=set)
    #: The user's categories measured against ``pool`` (a
    #: ``category_feed.Browse``), made once per version of the categories.
    browse: Any = None
    #: Whether the feed's own filters let a candidate in (watched, blocked,
    #: the algorithm's sources, lengths and ages): for videos that arrive
    #: after the ranking (a category's top-up).
    admits: Callable[[Candidate], bool] = lambda _c: True
    #: Held while ``browse`` is made or one of its lists is built or added to.
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


@lru_cache(maxsize=16384)
def name_key(text: str) -> str:
    # Cached: ranking asks for the same channel names many thousands of times.
    return " ".join((text or "").lower().split())


def short(title: str, limit: int = 60) -> str:
    title = " ".join((title or "").split())
    return title if len(title) <= limit else title[: limit - 1].rstrip() + "…"

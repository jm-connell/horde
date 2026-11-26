"""What Recommended keeps in memory: one ``DiscoveryRuntime`` on the ``AppContext``."""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from ..workers import BackgroundWorker
from .candidates import CatalogPool, VectorStore

#: Ranked feeds kept (one per user and refresh): for paging, and ahead of a visit.
FEED_CACHE_SIZE = 16
FEED_CACHE_TTL_SEC = 15 * 60
#: Hand-added topics' vectors kept (every user's together).
TOPIC_VECTOR_CACHE_SIZE = 512


@dataclass
class _CachedFeed:
    at: float
    value: Any
    #: When a visit last read a further page from it.
    paged_at: float | None = None


@dataclass
class TopUp:
    """More of one category, asked for at the end of its list (``topup``)."""

    #: queued | running | idle
    state: str = "queued"
    #: Nothing more for now until this (monotonic seconds).
    exhausted_until: float = 0.0


class DiscoveryRuntime:
    """The gatherer's worker and back-off, the vector matrix, and ranked feeds.

    Ranked feeds are cached by (user, seed) with the history fingerprint they
    were ranked for (``feed.ranked_feed``), so the pages of one visit come from
    one ranking; a first page re-ranks when the fingerprint changed. Today's
    feed of the people who use Recommended is ranked ahead of them (``warm``).
    """

    def __init__(self) -> None:
        self.vectors = VectorStore()
        self.catalog = CatalogPool()
        self._lock = threading.Lock()
        self._feeds: OrderedDict[tuple[Any, ...], _CachedFeed] = OrderedDict()
        self._ranking: dict[int, threading.Lock] = {}
        self.worker: BackgroundWorker | None = None
        #: No YouTube request before this (monotonic seconds) after a bot check
        #: or rate limit; ``backoff_sec`` doubles each time it happens again.
        self.paused_until = 0.0
        self.backoff_sec = 0.0
        #: Request timestamps (monotonic) of the last hour, for the hourly cap.
        self.recent_requests: list[float] = []
        #: The user being gathered for now (status for the UI).
        self.gathering_for: int | None = None
        #: Vectors of hand-added topics by (embed model, text); see ``topics``.
        self._topic_vectors: OrderedDict[tuple[str, str], Any] = OrderedDict()
        #: Category top-ups by (user, category); see ``topup``.
        self._topups: dict[tuple[int, int], TopUp] = {}

    def queue_topup(self, key: tuple[int, int], now: float) -> bool:
        """Queue a top-up; False when the last one found the category exhausted
        and that still holds. True also when it is queued or running already."""
        with self._lock:
            entry = self._topups.get(key)
            if entry is not None and entry.state != "idle":
                return True
            if entry is not None and now < entry.exhausted_until:
                return False
            self._topups[key] = TopUp()
            return True

    def next_topup(self) -> tuple[int, int] | None:
        """The next queued top-up, now marked running."""
        with self._lock:
            for key, entry in self._topups.items():
                if entry.state == "queued":
                    entry.state = "running"
                    return key
        return None

    def finish_topup(self, key: tuple[int, int], exhausted_until: float | None) -> None:
        with self._lock:
            self._topups[key] = TopUp("idle", exhausted_until or 0.0)

    def feeds_of(self, user_id: int) -> list[Any]:
        """Every ranked feed kept for a user, as stored."""
        with self._lock:
            return [hit.value for k, hit in self._feeds.items() if k[0] == user_id]

    def topic_vector(self, key: tuple[str, str]) -> Any | None:
        with self._lock:
            return self._topic_vectors.get(key)

    def store_topic_vector(self, key: tuple[str, str], value: Any) -> None:
        with self._lock:
            self._topic_vectors[key] = value
            self._topic_vectors.move_to_end(key)
            while len(self._topic_vectors) > TOPIC_VECTOR_CACHE_SIZE:
                self._topic_vectors.popitem(last=False)

    def wake(self) -> None:
        if self.worker is not None:
            self.worker.wake()

    def ranking(self, user_id: int) -> threading.Lock:
        """Held while a user's feed is ranked, so requests that arrive together
        (the first page and the channel suggestions) share one ranking."""
        with self._lock:
            return self._ranking.setdefault(user_id, threading.Lock())

    def feed(
        self,
        key: tuple[Any, ...],
        max_age: float = FEED_CACHE_TTL_SEC,
        *,
        paging: bool = False,
    ) -> Any | None:
        now = time.monotonic()
        with self._lock:
            hit = self._feeds.get(key)
            if hit is None or now - hit.at > max_age:
                return None
            self._feeds.move_to_end(key)
            if paging:
                hit.paged_at = now
            return hit.value

    def paged_within(self, key: tuple[Any, ...], seconds: float) -> bool:
        """A visit read a further page of this feed lately: its offsets count
        on the ranking staying as it is."""
        now = time.monotonic()
        with self._lock:
            hit = self._feeds.get(key)
            return (
                hit is not None
                and hit.paged_at is not None
                and now - hit.paged_at < seconds
            )

    def store_feed(self, key: tuple[Any, ...], value: Any) -> None:
        with self._lock:
            self._feeds[key] = _CachedFeed(time.monotonic(), value)
            self._feeds.move_to_end(key)
            while len(self._feeds) > FEED_CACHE_SIZE:
                self._feeds.popitem(last=False)

    def forget_feeds(self, user_id: int) -> None:
        """Drop a user's ranked feeds (their feedback changed what may be shown)."""
        with self._lock:
            for key in [k for k in self._feeds if k[0] == user_id]:
                del self._feeds[key]

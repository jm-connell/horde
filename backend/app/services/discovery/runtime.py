"""What Recommended+ keeps in memory: one ``DiscoveryRuntime`` on the ``AppContext``."""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from ..workers import BackgroundWorker
from .candidates import VectorStore

#: Ranked feeds kept for paging (one per user and refresh).
FEED_CACHE_SIZE = 16
FEED_CACHE_TTL_SEC = 15 * 60
#: Hand-added topics' vectors kept (every user's together).
TOPIC_VECTOR_CACHE_SIZE = 512


@dataclass
class _CachedFeed:
    at: float
    value: Any


class DiscoveryRuntime:
    """The gatherer's worker and back-off, the vector matrix, and ranked feeds.

    Ranked feeds are cached by (user, seed) with the history fingerprint they
    were ranked for (``feed.ranked_feed``), so the pages of one visit come from
    one ranking; a first page re-ranks when the fingerprint changed.
    """

    def __init__(self) -> None:
        self.vectors = VectorStore()
        self._lock = threading.Lock()
        self._feeds: OrderedDict[tuple[Any, ...], _CachedFeed] = OrderedDict()
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

    def feed(self, key: tuple[Any, ...]) -> Any | None:
        now = time.monotonic()
        with self._lock:
            hit = self._feeds.get(key)
            if hit is None or now - hit.at > FEED_CACHE_TTL_SEC:
                return None
            self._feeds.move_to_end(key)
            return hit.value

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

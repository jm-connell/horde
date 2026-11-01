"""The comment fetcher's per-instance state, held on ``AppContext.comments``."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .fetch import FetchResult

#: How long a deeper (live) fetch is served from memory.
LIVE_TTL_SEC = 30 * 60
#: Live fetches kept at once (each is up to ``fetch.LIVE_MAX`` comments).
LIVE_KEEP = 16


@dataclass
class CommentsRuntime:
    #: Set to cut the worker's pause short (a download finished, the setting is on).
    wake: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    #: Monotonic time before which the worker makes no YouTube request (rate limit).
    _paused_until: float = 0.0
    #: (YouTube id, limit) -> (monotonic time fetched, result).
    _live: dict[tuple[str, int], tuple[float, FetchResult]] = field(
        default_factory=dict
    )
    #: One read per (YouTube id, limit) at a time; the others wait for its result.
    _live_reads: dict[tuple[str, int], threading.Lock] = field(default_factory=dict)

    def pause(self, seconds: float) -> None:
        with self._lock:
            self._paused_until = max(self._paused_until, time.monotonic() + seconds)

    def seconds_paused(self) -> float:
        with self._lock:
            return max(0.0, self._paused_until - time.monotonic())

    def live_read_lock(self, yt_id: str, limit: int) -> threading.Lock:
        with self._lock:
            # Locks of reads that are over and no longer cached are dropped.
            for key in [k for k in self._live_reads if k not in self._live]:
                if not self._live_reads[key].locked():
                    del self._live_reads[key]
            return self._live_reads.setdefault((yt_id, limit), threading.Lock())

    def live_get(self, yt_id: str, limit: int) -> FetchResult | None:
        with self._lock:
            hit = self._live.get((yt_id, limit))
            if hit is None:
                return None
            if time.monotonic() - hit[0] > LIVE_TTL_SEC:
                del self._live[(yt_id, limit)]
                return None
            return hit[1]

    def live_put(self, yt_id: str, limit: int, result: FetchResult) -> None:
        with self._lock:
            self._live[(yt_id, limit)] = (time.monotonic(), result)
            while len(self._live) > LIVE_KEEP:
                oldest = min(self._live, key=lambda k: self._live[k][0])
                del self._live[oldest]

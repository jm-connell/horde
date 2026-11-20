"""Ask's per-instance state, held on ``AppContext.knowledge``."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

from .vectors import VectorCache

# Seconds between SponsorBlock requests (``sponsorblock.py``).
SPACING_SEC = 3.0


@dataclass
class SponsorPacer:
    """At most one SponsorBlock request per ``SPACING_SEC``, and none for a
    while after one failed."""

    _lock: threading.Lock = field(default_factory=threading.Lock)
    _next_at: float = 0.0

    def try_reserve(self, spacing: float = SPACING_SEC) -> bool:
        with self._lock:
            now = time.monotonic()
            if now < self._next_at:
                return False
            self._next_at = now + spacing
            return True

    def pause(self, seconds: float) -> None:
        with self._lock:
            self._next_at = max(self._next_at, time.monotonic() + seconds)

    def seconds_until_free(self) -> float:
        with self._lock:
            return max(0.0, self._next_at - time.monotonic())


@dataclass
class KnowledgeRuntime:
    #: Set to cut the worker's pause short (a channel was added or resumed).
    wake: threading.Event = field(default_factory=threading.Event)
    #: Passage vectors per channel for semantic search.
    vectors: VectorCache = field(default_factory=VectorCache)
    #: Spacing of SponsorBlock requests.
    sponsor: SponsorPacer = field(default_factory=SponsorPacer)

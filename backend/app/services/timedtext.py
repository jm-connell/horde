"""Pacing for YouTube's caption endpoint (timedtext), shared by every caption fetch.

Two clocks, held on ``AppContext.timedtext``:

* the **block**: after a 429 (or between library caption retries) nobody calls
  timedtext until it passes. Library caption work (``subtitle_retry``,
  ``metadata_sync``) reads and sets only this one.
* the **background slot**: Ask's caption indexing (``services/knowledge``) runs only
  when the block has passed *and* its own spacing has, and its fetches never set
  the block. So hours of indexing never make library caption work wait; only a
  429 that indexing hits pushes everyone back.
"""

from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta


class TimedtextPacer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._blocked_until: datetime | None = None
        self._background_next: datetime | None = None

    def block(self, delay_sec: float) -> None:
        """No timedtext call for anyone until ``delay_sec`` from now (max wins)."""
        if delay_sec <= 0:
            return
        until = datetime.now(UTC) + timedelta(seconds=delay_sec)
        with self._lock:
            if self._blocked_until is None or until > self._blocked_until:
                self._blocked_until = until

    def seconds_blocked(self) -> float:
        with self._lock:
            return self._seconds_left(self._blocked_until)

    def try_reserve_background(self, spacing_sec: float) -> bool:
        """Take the background slot if free; the next one opens ``spacing_sec`` later."""
        now = datetime.now(UTC)
        with self._lock:
            if self._seconds_left(self._blocked_until) > 0:
                return False
            if self._background_next is not None and now < self._background_next:
                return False
            self._background_next = now + timedelta(seconds=spacing_sec)
            return True

    def seconds_until_background(self) -> float:
        with self._lock:
            return max(
                self._seconds_left(self._blocked_until),
                self._seconds_left(self._background_next),
            )

    @staticmethod
    def _seconds_left(until: datetime | None) -> float:
        if until is None:
            return 0.0
        return max(0.0, (until - datetime.now(UTC)).total_seconds())

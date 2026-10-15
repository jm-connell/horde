"""Login throttling: exponential backoff per (client address, username).

An in-process object owned by the app (``app.state.auth``), not module state, so
tests and the CLI get a fresh one. After ``FREE_ATTEMPTS`` failures the key is
locked out for ``BASE_DELAY * 2**(failures - FREE_ATTEMPTS)`` seconds (capped).
A second counter keyed on the address alone stops one client from walking
through usernames to dodge the per-name counter.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

FREE_ATTEMPTS = 5
BASE_DELAY_SEC = 5.0
MAX_DELAY_SEC = 15 * 60.0
#: A key with no failure for this long starts over.
FORGET_AFTER_SEC = 60 * 60.0
#: The address-only counter tolerates more failures (shared NATs, typos).
ADDRESS_FREE_ATTEMPTS = 20
MAX_TRACKED_KEYS = 10_000


@dataclass
class _Entry:
    failures: int = 0
    last_failure: float = 0.0
    locked_until: float = 0.0


class LoginLimiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, str | None], _Entry] = {}

    @staticmethod
    def _keys(
        address: str, username_norm: str
    ) -> list[tuple[tuple[str, str | None], int]]:
        return [
            ((address, username_norm), FREE_ATTEMPTS),
            ((address, None), ADDRESS_FREE_ATTEMPTS),
        ]

    def retry_after(self, address: str, username_norm: str) -> int:
        """Seconds the caller must wait before trying again (0 = go ahead)."""
        now = self._clock()
        with self._lock:
            wait = 0.0
            for key, _free in self._keys(address, username_norm):
                entry = self._entries.get(key)
                if entry is not None and entry.locked_until > now:
                    wait = max(wait, entry.locked_until - now)
        return int(wait) + 1 if wait > 0 else 0

    def record_failure(self, address: str, username_norm: str) -> None:
        now = self._clock()
        with self._lock:
            self._prune(now)
            for key, free in self._keys(address, username_norm):
                entry = self._entries.setdefault(key, _Entry())
                entry.failures += 1
                entry.last_failure = now
                over = entry.failures - free
                if over >= 0:
                    delay = min(MAX_DELAY_SEC, BASE_DELAY_SEC * 2**over)
                    entry.locked_until = now + delay

    def record_success(self, address: str, username_norm: str) -> None:
        with self._lock:
            self._entries.pop((address, username_norm), None)

    def _prune(self, now: float) -> None:
        stale = [
            key
            for key, entry in self._entries.items()
            if now - entry.last_failure > FORGET_AFTER_SEC
        ]
        for key in stale:
            del self._entries[key]
        if len(self._entries) > MAX_TRACKED_KEYS:
            oldest = sorted(self._entries, key=lambda k: self._entries[k].last_failure)
            for key in oldest[: len(self._entries) - MAX_TRACKED_KEYS]:
                del self._entries[key]

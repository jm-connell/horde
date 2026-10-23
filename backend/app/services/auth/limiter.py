"""Login throttling: exponential backoff per (client address, username).

An in-process object owned by the app (``app.state.auth``), not module state, so
tests and the CLI get a fresh one. After ``FREE_ATTEMPTS`` failures the key is
locked out for ``BASE_DELAY * 2**(failures - FREE_ATTEMPTS)`` seconds (capped).
A second counter keyed on the address alone stops one client from walking
through usernames to dodge the per-name counter.

A third entry per username, shared by every address, only *slows*: after any
failure beyond the first ``FREE_ATTEMPTS`` in a minute the next attempt on that name waits ``USERNAME_SLOWDOWN_SEC`` whoever
makes it. That caps guessing across many addresses without letting one client
lock a user out. The escalating lockouts are per address; behind a proxy that
is not trusted every client shares one address, so set ``HORDE_TRUST_PROXY``.

A fourth, for a login that faces the internet, is a **daily ceiling** per name:
once ``DAILY_CEILING`` failures fall inside ``DAILY_WINDOW_SEC`` (counted from
every address), each further failure leaves the name accepting one attempt per
``DAILY_SLOWDOWN_SEC``, again from anywhere. It is slower than the per-minute
slowdown but still not a lockout, and a successful sign-in does not clear it
(only time does), so an attacker cannot reset it by signing in elsewhere. The
price: while an attack runs, the real user's attempts compete with the
attacker's for those slots. Signed-in browsers are unaffected, and the CLI
(``python -m app.cli reset-password``) always works.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

FREE_ATTEMPTS = 5
BASE_DELAY_SEC = 5.0
MAX_DELAY_SEC = 15 * 60.0
#: A key with no failure for this long starts over.
FORGET_AFTER_SEC = 60 * 60.0
#: The address-only counter tolerates more failures (shared NATs, typos).
ADDRESS_FREE_ATTEMPTS = 20
MAX_TRACKED_KEYS = 10_000
USERNAME_SLOWDOWN_SEC = 1.0
#: Failures against one name, from anywhere, are counted over this window.
USERNAME_WINDOW_SEC = 60.0
#: Failures against one name within ``DAILY_WINDOW_SEC`` before the slow lane starts.
DAILY_CEILING = 50
DAILY_WINDOW_SEC = 24 * 60 * 60.0
DAILY_SLOWDOWN_SEC = 10.0


@dataclass
class _Entry:
    failures: int = 0
    last_failure: float = 0.0
    locked_until: float = 0.0


@dataclass
class _Daily:
    """The last ``DAILY_CEILING`` failure times of one name, and its slow lane."""

    times: deque[float] = field(default_factory=lambda: deque(maxlen=DAILY_CEILING))
    locked_until: float = 0.0


class LoginLimiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[tuple[str | None, str | None], _Entry] = {}
        self._daily: dict[str, _Daily] = {}

    @staticmethod
    def _keys(
        address: str, username_norm: str
    ) -> list[tuple[tuple[str | None, str | None], int]]:
        return [
            ((address, username_norm), FREE_ATTEMPTS),
            ((address, None), ADDRESS_FREE_ATTEMPTS),
        ]

    def retry_after(self, address: str, username_norm: str) -> int:
        """Seconds the caller must wait before trying again (0 = go ahead)."""
        now = self._clock()
        with self._lock:
            wait = 0.0
            slow = self._entries.get((None, username_norm))
            if slow is not None and slow.locked_until > now:
                wait = slow.locked_until - now
            daily = self._daily.get(username_norm)
            if daily is not None and daily.locked_until > now:
                wait = max(wait, daily.locked_until - now)
            for key, _free in self._keys(address, username_norm):
                entry = self._entries.get(key)
                if entry is not None and entry.locked_until > now:
                    wait = max(wait, entry.locked_until - now)
        return int(wait) + 1 if wait > 0 else 0

    def record_failure(self, address: str, username_norm: str) -> None:
        now = self._clock()
        with self._lock:
            self._prune(now)
            slow = self._entries.setdefault((None, username_norm), _Entry())
            if now - slow.last_failure > USERNAME_WINDOW_SEC:
                slow.failures = 0
            slow.failures += 1
            slow.last_failure = now
            if slow.failures > FREE_ATTEMPTS:
                slow.locked_until = now + USERNAME_SLOWDOWN_SEC
            daily = self._daily.setdefault(username_norm, _Daily())
            daily.times.append(now)
            if (
                len(daily.times) == DAILY_CEILING
                and now - daily.times[0] <= DAILY_WINDOW_SEC
            ):
                daily.locked_until = now + DAILY_SLOWDOWN_SEC
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
            self._entries.pop((None, username_norm), None)

    def _prune(self, now: float) -> None:
        old = [
            name
            for name, daily in self._daily.items()
            if now - daily.times[-1] > DAILY_WINDOW_SEC
        ]
        for name in old:
            del self._daily[name]
        if len(self._daily) > MAX_TRACKED_KEYS:
            oldest_names = sorted(self._daily, key=lambda n: self._daily[n].times[-1])
            for name in oldest_names[: len(self._daily) - MAX_TRACKED_KEYS]:
                del self._daily[name]
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

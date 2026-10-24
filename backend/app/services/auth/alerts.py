"""Telling the administrator that somebody is guessing at an account.

``FailureWatch`` counts the failed sign-ins (a wrong password or a wrong second
step) of each username over the last hour. When one name reaches ``THRESHOLD`` it
says so once, then stays quiet for that name until ``COOLDOWN_SEC`` has passed, so
a long attack is one message per hour per account, not a flood. It only counts and
decides; ``api/auth.py`` sends the notification. In memory on the ``AuthRuntime``
(a restart forgets it), bounded, and keyed by the name as typed, so an attacker
spraying made-up names cannot grow it past ``MAX_NAMES``.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

#: Failures for one name within ``WINDOW_SEC`` before the administrator hears of it.
THRESHOLD = 10
WINDOW_SEC = 60 * 60.0
COOLDOWN_SEC = 60 * 60.0
MAX_NAMES = 1_000
#: Failures remembered per name (more than ``THRESHOLD`` only to report a bigger count).
MAX_REMEMBERED = 500


@dataclass
class _Name:
    #: (time, address), oldest first.
    failures: deque[tuple[float, str]] = field(
        default_factory=lambda: deque(maxlen=MAX_REMEMBERED)
    )
    last_alert: float | None = None


class FailureWatch:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._names: dict[str, _Name] = {}

    def note(self, username_norm: str, address: str) -> dict[str, Any] | None:
        """Record a failure; the alert payload if this one crossed the line, else None."""
        now = self._clock()
        with self._lock:
            self._prune(now)
            entry = self._names.get(username_norm)
            if entry is None:
                if len(self._names) >= MAX_NAMES:
                    return None
                entry = self._names[username_norm] = _Name()
            entry.failures.append((now, address))
            if len(entry.failures) < THRESHOLD:
                return None
            if entry.last_alert is not None and now - entry.last_alert < COOLDOWN_SEC:
                return None
            entry.last_alert = now
            return {
                "username": username_norm,
                "count": len(entry.failures),
                "addresses": len({addr for _t, addr in entry.failures}),
            }

    def _prune(self, now: float) -> None:
        for name in list(self._names):
            entry = self._names[name]
            while entry.failures and now - entry.failures[0][0] > WINDOW_SEC:
                entry.failures.popleft()
            quiet = entry.last_alert is None or now - entry.last_alert >= COOLDOWN_SEC
            if not entry.failures and quiet:
                del self._names[name]

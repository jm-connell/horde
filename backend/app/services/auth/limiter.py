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
attacker's for those slots; a *known device* (below) is the way round that.
Signed-in browsers are unaffected, and the CLI
(``python -m app.cli reset-password``) always works.

Every guess goes through ``begin``, which **reserves** one try before the password
or code is hashed and checked, and settles it afterwards (``Attempt.failure`` /
``success``). A reservation counts against the budget like a failure already
recorded, so concurrent guesses cannot all slip past a check made before any of
them finished: with 5 free tries, 80 simultaneous requests judge exactly 5 and
the other 75 are refused at once, without hashing anything. At most
``INFLIGHT_PER_NAME`` tries on one name are in flight at once, from any address,
and ``INFLIGHT_PER_ADDRESS`` from one address, whatever the names.

Client addresses are keyed by network, not host (``throttle_address``): an IPv6
address by its /64, since one subscriber is routinely handed a whole /64 and can
rotate through it; an IPv4-mapped IPv6 address as the IPv4 address it wraps.

Two things protect the *real* accounts. ``begin(known=False)`` marks the entries
it creates as belonging to a made-up name, and when the tables are full those are
evicted first, so spraying junk names cannot flush a victim's state. And a
**known device** (a valid ``horde_device`` cookie for that account, see
``device_cookie.py``) is exempt from the name-wide lanes (the daily ceiling, the
per-name slowdown and the per-name concurrency cap): it keeps its own per-device
and per-address back-off, so a stranger hammering a name does not shut out its
owner's usual browser.

Finally a **code-step counter** per name, fed only by wrong second-step codes
(authenticator or recovery) and cleared only by a right code or 24 hours of
quiet: every ``CODE_LOCK_EVERY`` failures the name's code step waits twice as
long (up to an hour). A right password does not clear it and a known device is
not exempt, because a six-digit code is small enough to be worth guessing for
weeks.
"""

from __future__ import annotations

import ipaddress
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TypeVar

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
#: Tries on one name that may be judged at the same time, from every address together.
INFLIGHT_PER_NAME = 5
#: Tries from one address (whatever the names) that may be judged at the same time.
INFLIGHT_PER_ADDRESS = 2
#: Wrong second-step codes against one name before its code step starts to wait,
#: and again after each further ``CODE_LOCK_EVERY``: 30 s, 60 s, 2 min ... 1 h.
CODE_LOCK_EVERY = 10
CODE_BASE_DELAY_SEC = 30.0
CODE_MAX_DELAY_SEC = 60 * 60.0
#: A name whose code step saw no failure for this long starts over.
CODE_FORGET_AFTER_SEC = 24 * 60 * 60.0

_Key = tuple[str | None, str | None]
_K = TypeVar("_K")
_V = TypeVar("_V")


def throttle_address(address: str) -> str:
    """The key a client address is throttled under: IPv6 by /64, mapped IPv4 as IPv4."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return address  # "unknown", or anything a proxy put there
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(ip), 64), strict=False))
    return str(ip)


class Throttled(Exception):
    """``begin`` refused a try. ``wait`` is whole seconds until one may be made."""

    def __init__(self, wait: int) -> None:
        super().__init__(f"try again in {wait} seconds")
        self.wait = wait


@dataclass
class _Entry:
    failures: int = 0
    last_failure: float = 0.0
    locked_until: float = 0.0
    #: The name belongs to a real account (made-up names are evicted first).
    known: bool = True


@dataclass
class _Daily:
    """The last ``DAILY_CEILING`` failure times of one name, and its slow lane."""

    times: deque[float] = field(default_factory=lambda: deque(maxlen=DAILY_CEILING))
    locked_until: float = 0.0
    known: bool = True


@dataclass
class _Code:
    """Wrong second-step codes against one name."""

    failures: int = 0
    last_failure: float = 0.0
    locked_until: float = 0.0
    known: bool = True


class Attempt:
    """One reserved try. Settle it with ``failure`` or ``success``.

    Used as a context manager, leaving the block without settling gives the
    reservation back (a right password that still has a code step to pass, an
    error that judged nothing).
    """

    def __init__(
        self,
        limiter: LoginLimiter,
        keys: tuple[_Key, ...],
        address: str,
        name: str,
        device: str | None,
        known: bool,
        code_name: str | None,
    ) -> None:
        self._limiter = limiter
        self._keys = keys
        self.address = address
        self.name = name
        self.device = device
        self.known = known
        #: The name whose code counter a second-step failure feeds (None: no code step).
        self.code_name = code_name
        self._settled = False

    def failure(self, *, code_step: bool = False) -> None:
        """A wrong guess. ``code_step`` also counts against the name's code counter."""
        self._limiter._settle(
            self, failed=True, code=self.code_name if code_step else None
        )

    def password_accepted(self) -> None:
        """A right password whose second step is still due.

        Counted against the tries like a wrong guess (on the address+name and
        device lanes and the name-wide slowdown, not the address-only lane or the
        daily ceiling), so a phished password cannot be hashed at will. A right
        code (``success``) forgives it.
        """
        self._limiter._settle(self, failed=True, code=None, password_ok=True)

    def success(self, *, code_step: bool = False) -> None:
        """A right guess: forget the failures (and the code counter if ``code_step``)."""
        self._limiter._settle(
            self, failed=False, code=self.code_name if code_step else None
        )

    def release(self) -> None:
        """Give the reservation back without counting anything."""
        self._limiter._settle(self, failed=None, code=None)

    def __enter__(self) -> Attempt:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()


class LoginLimiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[_Key, _Entry] = {}
        self._daily: dict[str, _Daily] = {}
        self._code: dict[str, _Code] = {}
        self._inflight: dict[_Key, int] = {}

    @staticmethod
    def _lanes(address: str, name: str, device: str | None) -> list[tuple[_Key, int]]:
        lanes: list[tuple[_Key, int]] = [
            ((address, name), FREE_ATTEMPTS),
            ((address, None), ADDRESS_FREE_ATTEMPTS),
        ]
        if device is not None:
            lanes.append(((f"device:{device}", name), FREE_ATTEMPTS))
        return lanes

    # --- Reserving a try --------------------------------------------------

    def begin(
        self,
        address: str,
        name: str,
        *,
        known: bool = True,
        device: str | None = None,
        code_name: str | None = None,
    ) -> Attempt:
        """Reserve a try for ``name`` from ``address`` or raise ``Throttled``.

        ``known``: ``name`` belongs to a real account. ``device``: the id from a
        valid known-device cookie for that account (exempts the name-wide lanes).
        ``code_name``: this try may judge a second-step code for that account, so
        its code counter applies too (the same name whatever key ``name`` is).
        """
        address = throttle_address(address)
        now = self._clock()
        with self._lock:
            wait = self._wait(now, address, name, device, code_name)
            if wait > 0:
                raise Throttled(int(wait) + 1)
            lanes = self._lanes(address, name, device)
            for key, free in lanes:
                entry = self._entries.get(key)
                # Tries still in flight count like failures already recorded; once
                # the free tries are used up (and the lockout has run out) one try
                # at a time is let through.
                room = max(1, free - (entry.failures if entry else 0))
                if key[1] is None:
                    # The address lane: one client hashes a couple at a time.
                    room = min(room, INFLIGHT_PER_ADDRESS)
                if self._inflight.get(key, 0) >= room:
                    raise Throttled(1)
            name_key: _Key = (None, name)
            if device is None and self._inflight.get(name_key, 0) >= INFLIGHT_PER_NAME:
                raise Throttled(1)
            keys = (*(key for key, _free in lanes), name_key)
            for key in keys:
                self._inflight[key] = self._inflight.get(key, 0) + 1
        return Attempt(self, keys, address, name, device, known, code_name)

    def _settle(
        self,
        attempt: Attempt,
        *,
        failed: bool | None,
        code: str | None,
        password_ok: bool = False,
    ) -> None:
        now = self._clock()
        with self._lock:
            if attempt._settled:
                return
            attempt._settled = True
            for key in attempt._keys:
                left = self._inflight.get(key, 0) - 1
                if left > 0:
                    self._inflight[key] = left
                else:
                    self._inflight.pop(key, None)
            if failed is True:
                self._fail(
                    now,
                    attempt.address,
                    attempt.name,
                    attempt.device,
                    attempt.known,
                    code,
                    password_ok=password_ok,
                )
            elif failed is False:
                self._ok(attempt.address, attempt.name, attempt.device, code)

    # --- Counting, without a reservation ------------------------------------

    def retry_after(
        self,
        address: str,
        username_norm: str,
        *,
        device: str | None = None,
        code_name: str | None = None,
    ) -> int:
        """Seconds the caller must wait before trying again (0 = go ahead)."""
        with self._lock:
            wait = self._wait(
                self._clock(),
                throttle_address(address),
                username_norm,
                device,
                code_name,
            )
        return int(wait) + 1 if wait > 0 else 0

    def record_failure(
        self,
        address: str,
        username_norm: str,
        *,
        known: bool = True,
        device: str | None = None,
        code_name: str | None = None,
    ) -> None:
        now = self._clock()
        with self._lock:
            self._fail(
                now, throttle_address(address), username_norm, device, known, code_name
            )

    def record_success(
        self,
        address: str,
        username_norm: str,
        *,
        device: str | None = None,
        code_name: str | None = None,
    ) -> None:
        with self._lock:
            self._ok(throttle_address(address), username_norm, device, code_name)

    # --- Internals (call with the lock held) ----------------------------------

    def _wait(
        self,
        now: float,
        address: str,
        name: str,
        device: str | None,
        code_name: str | None,
    ) -> float:
        wait = 0.0
        if device is None:  # a known device skips the name-wide lanes
            slow = self._entries.get((None, name))
            if slow is not None and slow.locked_until > now:
                wait = slow.locked_until - now
            daily = self._daily.get(name)
            if daily is not None and daily.locked_until > now:
                wait = max(wait, daily.locked_until - now)
        if code_name is not None:
            code = self._code.get(code_name)
            if code is not None and code.locked_until > now:
                wait = max(wait, code.locked_until - now)
        for key, _free in self._lanes(address, name, device):
            entry = self._entries.get(key)
            if entry is not None and entry.locked_until > now:
                wait = max(wait, entry.locked_until - now)
        return wait

    def _fail(
        self,
        now: float,
        address: str,
        name: str,
        device: str | None,
        known: bool,
        code_name: str | None,
        *,
        password_ok: bool = False,
    ) -> None:
        self._prune(now)
        slow = self._entries.setdefault((None, name), _Entry(known=known))
        if now - slow.last_failure > USERNAME_WINDOW_SEC:
            slow.failures = 0
        slow.failures += 1
        slow.last_failure = now
        if slow.failures > FREE_ATTEMPTS:
            slow.locked_until = now + USERNAME_SLOWDOWN_SEC
        if not password_ok:
            daily = self._daily.setdefault(name, _Daily(known=known))
            daily.times.append(now)
            if (
                len(daily.times) == DAILY_CEILING
                and now - daily.times[0] <= DAILY_WINDOW_SEC
            ):
                daily.locked_until = now + DAILY_SLOWDOWN_SEC
        for key, free in self._lanes(address, name, device):
            if password_ok and key[1] is None:
                continue  # a right password is no sign of walking through names
            entry = self._entries.setdefault(key, _Entry(known=known))
            entry.failures += 1
            entry.last_failure = now
            over = entry.failures - free
            if over >= 0:
                delay = min(MAX_DELAY_SEC, BASE_DELAY_SEC * 2**over)
                entry.locked_until = now + delay
        if code_name is not None:
            code = self._code.setdefault(code_name, _Code(known=known))
            if now - code.last_failure > CODE_FORGET_AFTER_SEC:
                code.failures = 0
                code.locked_until = 0.0
            code.failures += 1
            code.last_failure = now
            if code.failures % CODE_LOCK_EVERY == 0:
                doublings = code.failures // CODE_LOCK_EVERY - 1
                delay = min(CODE_MAX_DELAY_SEC, CODE_BASE_DELAY_SEC * 2**doublings)
                code.locked_until = now + delay

    def _ok(
        self, address: str, name: str, device: str | None, code_name: str | None
    ) -> None:
        for key, _free in self._lanes(address, name, device):
            if key != (address, None):
                self._entries.pop(key, None)
        self._entries.pop((None, name), None)
        if code_name is not None:
            self._code.pop(code_name, None)

    @staticmethod
    def _evict(
        table: dict[_K, _V], limit: int, rank: Callable[[_V], tuple[bool, float]]
    ) -> None:
        """Drop the lowest ranked entries beyond ``limit``: made-up names, then the oldest."""
        if len(table) <= limit:
            return
        for key in sorted(table, key=lambda k: rank(table[k]))[: len(table) - limit]:
            del table[key]

    def _prune(self, now: float) -> None:
        for name in [
            n for n, d in self._daily.items() if now - d.times[-1] > DAILY_WINDOW_SEC
        ]:
            del self._daily[name]
        self._evict(self._daily, MAX_TRACKED_KEYS, lambda d: (d.known, d.times[-1]))
        for key in [
            k
            for k, e in self._entries.items()
            if now - e.last_failure > FORGET_AFTER_SEC
        ]:
            del self._entries[key]
        self._evict(
            self._entries, MAX_TRACKED_KEYS, lambda e: (e.known, e.last_failure)
        )
        for name in [
            n
            for n, c in self._code.items()
            if now - c.last_failure > CODE_FORGET_AFTER_SEC
        ]:
            del self._code[name]
        self._evict(self._code, MAX_TRACKED_KEYS, lambda c: (c.known, c.last_failure))

"""The ticket between the password step and the code step of a two-step sign-in.

A correct password for an account with two-step sign-in does not start a session.
It returns a *ticket* instead, and ``POST /api/auth/login/totp`` trades the ticket
plus a code for the session. A ticket is:

* **signed**: ``v1.<expiry>.<user id>.<nonce>.<hmac>``, an HMAC-SHA256 with the key
  in ``DATA_DIR/secret_key`` (the one media URLs use, under its own message prefix);
* **short lived**: five minutes;
* **bound to the account's credentials**: the HMAC covers ``ticket_epoch``, which
  changes when the password does (and when the second factor is switched), so a
  ticket outlives neither a password reset nor turning two-step sign-in off or on;
* **single use** and **tried at most five times**: the registry below (in memory,
  on the ``AuthRuntime``; a restart forgets it, so tickets die with the process)
  lets a nonce succeed once, and five wrong codes burn it. Someone who knows the
  password must then enter it again for five more guesses, on top of the
  per-address and per-username throttle that counts every wrong code.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from ...models import User

TICKET_TTL_SEC = 5 * 60
MAX_ATTEMPTS = 5
#: Tickets waiting at once; the oldest is forgotten beyond this.
MAX_OUTSTANDING = 1_000

_TICKET_RE = re.compile(r"v1\.(\d{1,12})\.(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})")


@dataclass(frozen=True)
class ParsedTicket:
    expiry: int
    user_id: int
    nonce: str
    mac: str


def ticket_epoch(user: User) -> str:
    """Changes with the password and with the second factor; a ticket is bound to it."""
    state = "|".join(
        [
            user.password_hash,
            user.totp_secret or "",
            user.totp_enabled_at.isoformat() if user.totp_enabled_at else "",
        ]
    )
    return hashlib.sha256(state.encode("utf-8")).hexdigest()[:16]


def _mac(secret: bytes, expiry: int, user_id: int, nonce: str, epoch: str) -> str:
    message = f"login-2fa|{expiry}|{user_id}|{nonce}|{epoch}".encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def parse(token: str) -> ParsedTicket | None:
    """Strict shape check; anything else (including non-ASCII) is not a ticket."""
    match = _TICKET_RE.fullmatch(token)
    if match is None:
        return None
    return ParsedTicket(int(match[1]), int(match[2]), match[3], match[4])


def verify(
    secret: bytes, parsed: ParsedTicket, epoch: str, now: float | None = None
) -> bool:
    """True if the ticket was signed for this account state and has not expired."""
    expected = _mac(secret, parsed.expiry, parsed.user_id, parsed.nonce, epoch)
    if not hmac.compare_digest(parsed.mac.encode("ascii"), expected.encode("ascii")):
        return False
    return parsed.expiry >= int(time.time() if now is None else now)


@dataclass
class _Outstanding:
    expiry: int
    attempts: int = 0


class PendingLogins:
    """The tickets that were issued and not yet used up."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._tickets: dict[str, _Outstanding] = {}

    def issue(self, secret: bytes, user: User) -> str:
        """A new ticket for ``user`` (who has just proven their password)."""
        if user.id is None:
            raise RuntimeError("user has not been saved yet")
        now = self._clock()
        expiry = int(now) + TICKET_TTL_SEC
        nonce = secrets.token_hex(16)
        mac = _mac(secret, expiry, user.id, nonce, ticket_epoch(user))
        with self._lock:
            self._prune(now)
            while len(self._tickets) >= MAX_OUTSTANDING:
                del self._tickets[next(iter(self._tickets))]
            self._tickets[nonce] = _Outstanding(expiry)
        return f"v1.{expiry}.{user.id}.{nonce}.{mac}"

    def attempt(self, ticket: ParsedTicket) -> bool:
        """Count a try of ``ticket``; False if it is unknown, spent or out of tries."""
        now = self._clock()
        with self._lock:
            self._prune(now)
            entry = self._tickets.get(ticket.nonce)
            if entry is None or entry.attempts >= MAX_ATTEMPTS:
                return False
            entry.attempts += 1
            return True

    def finish(self, ticket: ParsedTicket) -> bool:
        """Use the ticket up. True for exactly one caller, however many race."""
        with self._lock:
            return self._tickets.pop(ticket.nonce, None) is not None

    def _prune(self, now: float) -> None:
        for nonce in [n for n, t in self._tickets.items() if t.expiry < now]:
            del self._tickets[nonce]

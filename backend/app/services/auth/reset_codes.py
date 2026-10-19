"""One-time password reset codes, delivered through the server log.

"Forgot password?" on the sign-in page asks for a code; the server writes it to
its log, which only whoever runs Horde can read (``docker logs horde``). Entering
the code with a new password resets the account. So the log is the second
factor: anyone on the network can ask for a code, nobody but the operator can
see it, and asking never changes the password by itself.

Codes live in memory on the app's ``AuthRuntime`` (a restart forgets them) and
are stored as SHA-256 hashes. Each one:

* expires after ``CODE_TTL_SEC`` and works once (``redeem`` checks and removes it
  under one lock, so two requests cannot both use it);
* is bound to the account it was issued for: its id and current password hash.
  A password change, an admin reset, or deleting and recreating the name makes
  outstanding codes useless;
* shares ``MAX_ATTEMPTS`` wrong guesses with the other codes of that account.

Asking again keeps the previous codes working (up to ``KEEP_CODES``), so someone
asking on your behalf cannot replace the code you just read. An account gets at
most one new code per ``REISSUE_COOLDOWN_SEC``, also after its guesses ran out,
so the log cannot be flooded.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

CODE_TTL_SEC = 15 * 60.0
MAX_ATTEMPTS = 5
REISSUE_COOLDOWN_SEC = 30.0
#: Codes of one account that stay valid at once (the newest ones).
KEEP_CODES = 3
#: No 0/O, 1/I/L: the code is read off a terminal and typed.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_CODE_LEN = 10
MAX_PENDING = 1_000


def normalize_code(raw: str) -> str:
    """Upper-case and drop separators and spaces, as people type them."""
    return "".join(ch for ch in raw.upper() if ch.isalnum())


def format_code(code: str) -> str:
    return f"{code[:5]}-{code[5:]}"


def account_binding(user_id: int, password_hash: str) -> bytes:
    """What a code is tied to: this account, with this password."""
    return hashlib.sha256(f"{user_id}:{password_hash}".encode()).digest()


def _hash(code: str) -> bytes:
    return hashlib.sha256(code.encode()).digest()


@dataclass
class _Account:
    binding: bytes
    last_issued: float
    #: (code hash, issued at), oldest first.
    codes: list[tuple[bytes, float]] = field(default_factory=list)
    attempts: int = 0


class ResetCodes:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._accounts: dict[str, _Account] = {}

    def issue(self, username_norm: str, binding: bytes) -> str | None:
        """A new code, or None inside the reissue cooldown (or when full)."""
        now = self._clock()
        with self._lock:
            self._prune(now)
            entry = self._accounts.get(username_norm)
            if entry and now - entry.last_issued < REISSUE_COOLDOWN_SEC:
                return None
            if entry is None or entry.binding != binding:
                if entry is None and len(self._accounts) >= MAX_PENDING:
                    return None
                entry = _Account(binding=binding, last_issued=now)
                self._accounts[username_norm] = entry
            code = "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LEN))
            entry.codes = [*entry.codes, (_hash(code), now)][-KEEP_CODES:]
            entry.last_issued = now
            entry.attempts = 0
            return format_code(code)

    def redeem(self, username_norm: str, raw_code: str, binding: bytes) -> bool:
        """Use a code: True (and every code of the account is gone) if it is valid.

        A wrong guess counts against the account; after ``MAX_ATTEMPTS`` its
        codes are dropped, but the cooldown still applies to asking again.
        """
        now = self._clock()
        with self._lock:
            self._prune(now)
            entry = self._accounts.get(username_norm)
            if entry is None or not entry.codes:
                return False
            digest = _hash(normalize_code(raw_code))
            match = any(hmac.compare_digest(d, digest) for d, _ in entry.codes)
            if match and hmac.compare_digest(entry.binding, binding):
                entry.codes = []
                return True
            entry.attempts += 1
            if entry.attempts >= MAX_ATTEMPTS:
                entry.codes = []
            return False

    def discard(self, username_norm: str) -> None:
        """Forget the account's codes (it signed in, so it was not lost)."""
        with self._lock:
            entry = self._accounts.get(username_norm)
            if entry is not None:
                entry.codes = []

    def _prune(self, now: float) -> None:
        for name in list(self._accounts):
            entry = self._accounts[name]
            entry.codes = [
                (d, issued) for d, issued in entry.codes if now - issued < CODE_TTL_SEC
            ]
            if not entry.codes and now - entry.last_issued >= REISSUE_COOLDOWN_SEC:
                del self._accounts[name]

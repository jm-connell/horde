"""Time-based one-time passwords (RFC 6238) from the standard library.

SHA-1, six digits, a 30 second step: the combination every authenticator app
supports. A code is accepted for the current step and the one either side of it
(clock drift, the time it takes to type). The step that was accepted is returned
so the caller can refuse a replay: a code that was used once must not work again
inside its window.

Nothing here touches the database or the clock on its own; ``services/auth/two_factor.py``
stores the secret and the last used step.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
from urllib.parse import quote, urlencode

STEP_SECONDS = 30
DIGITS = 6
#: Steps either side of the current one that still count.
DRIFT_STEPS = 1
SECRET_BYTES = 20
ISSUER = "Horde"


def new_secret() -> str:
    """A fresh 160-bit secret as unpadded base32 (what authenticator apps display)."""
    return (
        base64.b32encode(secrets.token_bytes(SECRET_BYTES)).decode("ascii").rstrip("=")
    )


def _key(secret_b32: str) -> bytes:
    cleaned = "".join(secret_b32.split()).upper()
    return base64.b32decode(cleaned + "=" * (-len(cleaned) % 8))


def hotp(key: bytes, counter: int, digits: int = DIGITS) -> str:
    """RFC 4226 HOTP: the ``digits``-digit code for ``counter``."""
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10**digits).zfill(digits)


def step_at(unix_time: float) -> int:
    return int(unix_time // STEP_SECONDS)


def code_at(secret_b32: str, unix_time: float, digits: int = DIGITS) -> str:
    """The code an authenticator shows at ``unix_time`` (tests and the e2e suite use it)."""
    return hotp(_key(secret_b32), step_at(unix_time), digits)


def normalize(code: str) -> str:
    """The digits of what the user typed: spaces and dashes (``123 456``) are fine."""
    return "".join(ch for ch in code if ch not in " - ")


def looks_like_totp(code: str) -> bool:
    cleaned = normalize(code)
    return len(cleaned) == DIGITS and cleaned.isascii() and cleaned.isdigit()


def match_step(
    secret_b32: str, code: str, unix_time: float, last_step: int | None = None
) -> int | None:
    """The step ``code`` is valid for, or ``None``.

    Only steps after ``last_step`` count, so a code that was already accepted (or
    an older one) is refused. Every candidate is compared in constant time.
    """
    cleaned = normalize(code)
    if not looks_like_totp(cleaned):
        return None
    try:
        key = _key(secret_b32)
    except ValueError:
        return None
    now = step_at(unix_time)
    matched: int | None = None
    for step in range(now - DRIFT_STEPS, now + DRIFT_STEPS + 1):
        if hmac.compare_digest(hotp(key, step).encode(), cleaned.encode()) and (
            last_step is None or step > last_step
        ):
            matched = step
    return matched


def provisioning_uri(secret_b32: str, account: str, issuer: str = ISSUER) -> str:
    """The ``otpauth://`` link an authenticator app reads from a QR code."""
    label = quote(f"{issuer}:{account}", safe="")
    query = urlencode(
        {
            "secret": secret_b32,
            "issuer": issuer,
            "algorithm": "SHA1",
            "digits": DIGITS,
            "period": STEP_SECONDS,
        },
        quote_via=quote,
    )
    return f"otpauth://totp/{label}?{query}"


def group_secret(secret_b32: str) -> str:
    """The secret in blocks of four, for typing it into an app by hand."""
    return " ".join(secret_b32[i : i + 4] for i in range(0, len(secret_b32), 4))

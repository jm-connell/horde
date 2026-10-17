"""Password hashing and policy.

``hashlib.scrypt`` from the standard library, no new dependency. A stored hash
is ``scrypt$n$r$p$salt_b64$hash_b64`` so the cost can be raised later:
``verify_password`` accepts any parameters it finds and ``needs_rehash`` tells
the login path to re-store the password under the current ones.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass

logger = logging.getLogger(__name__)

SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 64
SALT_BYTES = 16
SCHEME = "scrypt"

MIN_PASSWORD_LENGTH = 8
#: Generous cap; it only exists so a request cannot make us hash megabytes.
MAX_PASSWORD_LENGTH = 1024

#: Refuse stored parameters far above ours (a corrupt row must not allocate GiBs).
_MAX_N = 2**20
_MAX_R = 32
_MAX_P = 16


class PasswordPolicyError(ValueError):
    """The password is not acceptable; the message is safe to show the user."""


@dataclass(frozen=True)
class ScryptParams:
    n: int = SCRYPT_N
    r: int = SCRYPT_R
    p: int = SCRYPT_P
    dklen: int = SCRYPT_DKLEN


CURRENT_PARAMS = ScryptParams()


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _derive(password: str, salt: bytes, params: ScryptParams) -> bytes:
    # scrypt needs 128 * n * r bytes; the default limit is exactly that for our
    # n and r, so give it headroom.
    maxmem = 128 * params.n * params.r * params.p * 2 + (1 << 20)
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=params.n,
        r=params.r,
        p=params.p,
        dklen=params.dklen,
        maxmem=maxmem,
    )


def hash_password(password: str, params: ScryptParams | None = None) -> str:
    params = params or CURRENT_PARAMS
    salt = secrets.token_bytes(SALT_BYTES)
    digest = _derive(password, salt, params)
    return f"{SCHEME}${params.n}${params.r}${params.p}${_b64(salt)}${_b64(digest)}"


def _parse(stored: str) -> tuple[ScryptParams, bytes, bytes] | None:
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != SCHEME:
        return None
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt = base64.b64decode(parts[4], validate=True)
        digest = base64.b64decode(parts[5], validate=True)
    except ValueError:
        return None
    if not (1 < n <= _MAX_N and n & (n - 1) == 0):
        return None
    if not (1 <= r <= _MAX_R and 1 <= p <= _MAX_P and digest and salt):
        return None
    return ScryptParams(n=n, r=r, p=p, dklen=len(digest)), salt, digest


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check. A malformed stored hash never matches."""
    parsed = _parse(stored)
    if parsed is None:
        logger.warning("Unparseable password hash in the users table")
        return False
    params, salt, expected = parsed
    return hmac.compare_digest(_derive(password, salt, params), expected)


def needs_rehash(stored: str) -> bool:
    parsed = _parse(stored)
    return parsed is None or parsed[0] != CURRENT_PARAMS


def validate_password(password: str, username: str) -> None:
    """Minimum length, no composition rules, and not the username."""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordPolicyError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise PasswordPolicyError(
            f"Password must be at most {MAX_PASSWORD_LENGTH} characters"
        )
    if password.strip().lower() == username.strip().lower():
        raise PasswordPolicyError("Password must not be the same as the username")

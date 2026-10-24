"""The known-device cookie: a browser that has signed in as an account before.

After a complete sign-in (the second step included) the browser gets a signed,
long-lived ``horde_device`` cookie for that account. A sign-in attempt that
presents a valid one for the account it names is exempt from the throttle's
*name-wide* lanes (see ``limiter.py``): a stranger hammering a username can no
longer make the owner's usual browser wait too. The cookie does not skip the
password or the code, only the part of the throttle that other people's guesses
feed; the device keeps its own per-device and per-address back-off.

``v1.<user id>.<device id>.<hmac>``: an HMAC-SHA256 with the key in
``DATA_DIR/secret_key`` over the account, a random device id and the account's
password epoch (``media_token.token_epoch``), so changing or resetting the
password retires every device cookie of that account. It names no secret and
grants no access by itself; stealing it gains an attacker only what it gives
the owner: freedom from the name-wide slowdown for that one account, still
limited per device and per address.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets

from ...models import User
from .media_token import token_epoch

COOKIE = "horde_device"
MAX_AGE_SEC = 365 * 24 * 60 * 60

_RE = re.compile(r"v1\.(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})")


def _mac(secret: bytes, user_id: int, device_id: str, epoch: str) -> str:
    message = f"known-device|{user_id}|{device_id}|{epoch}".encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def new_device_id() -> str:
    return secrets.token_hex(16)


def sign(secret: bytes, user: User, device_id: str) -> str:
    """The cookie value that makes the holder ``device_id`` for ``user``."""
    if user.id is None:
        raise RuntimeError("user has not been saved yet")
    mac = _mac(secret, user.id, device_id, token_epoch(user.password_hash))
    return f"v1.{user.id}.{device_id}.{mac}"


def verify(secret: bytes, value: str | None, user: User | None) -> str | None:
    """The device id if ``value`` is a current device cookie for ``user``, else None."""
    if not value or user is None or user.id is None:
        return None
    match = _RE.fullmatch(value)
    if match is None or int(match[1]) != user.id:
        return None
    expected = _mac(secret, user.id, match[2], token_epoch(user.password_hash))
    if not hmac.compare_digest(match[3].encode("ascii"), expected.encode("ascii")):
        return None
    return match[2]

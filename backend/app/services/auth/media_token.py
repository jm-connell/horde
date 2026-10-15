"""Signed media URLs and the app secret key.

Chromecast and AirPlay receivers fetch media themselves and send no cookies. The
SPA asks ``GET /api/videos/{id}/media-token`` and appends ``?mt=<token>`` to the
stream, subtitle and thumbnail URLs it hands to the receiver. A token is
``<expiry>.<user_id>.<hmac>``, an HMAC-SHA256 over ``video_id|expiry|user_id``
with the key in ``DATA_DIR/secret_key``. The video id is not in the token: it
comes from the URL being fetched, so a token cannot be replayed for a different
video.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

TOKEN_TTL = timedelta(hours=12)
SECRET_BYTES = 32


def load_or_create_secret(path: Path) -> bytes:
    """Read the key, creating it (mode 600) on first use. Never stored in the DB."""
    try:
        data = path.read_bytes()
        if len(data) >= SECRET_BYTES:
            return data
    except FileNotFoundError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(SECRET_BYTES)
    tmp = path.with_name(f"{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(key)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        # link() fails if another process won the race; then use its key.
        os.link(tmp, path)
    except FileExistsError:
        return path.read_bytes()
    finally:
        tmp.unlink(missing_ok=True)
    path.chmod(0o600)
    return key


def _mac(secret: bytes, video_id: int, expiry: int, user_id: int) -> str:
    message = f"{video_id}|{expiry}|{user_id}".encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def sign(
    secret: bytes, video_id: int, user_id: int, now: datetime | None = None
) -> tuple[str, datetime]:
    expires_at = (now or datetime.now(UTC)) + TOKEN_TTL
    expiry = int(expires_at.timestamp())
    token = f"{expiry}.{user_id}.{_mac(secret, video_id, expiry, user_id)}"
    return token, datetime.fromtimestamp(expiry, UTC)


def verify(
    secret: bytes, token: str, video_id: int, now: datetime | None = None
) -> int | None:
    """The user id the token was issued to, or ``None`` if it is not valid here."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        expiry, user_id = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not hmac.compare_digest(parts[2], _mac(secret, video_id, expiry, user_id)):
        return None
    if expiry < int((now or datetime.now(UTC)).timestamp()):
        return None
    return user_id

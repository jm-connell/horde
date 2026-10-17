"""Signed media URLs and the app secret key.

Chromecast and AirPlay receivers fetch media themselves and send no cookies. The
SPA asks ``GET /api/videos/{id}/media-token`` and appends ``?mt=<token>`` to the
stream, subtitle and thumbnail URLs it hands to the receiver. A token is
``<expiry>.<user_id>.<hmac>``, an HMAC-SHA256 over
``video_id|expiry|user_id|epoch`` (``epoch`` is derived from the user's password hash,
so resetting the password voids their tokens)
with the key in ``DATA_DIR/secret_key``. The video id is not in the token: it
comes from the URL being fetched, so a token cannot be replayed for a different
video.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

TOKEN_TTL = timedelta(hours=12)
SECRET_BYTES = 32


def load_or_create_secret(path: Path) -> bytes:
    """Read the key, creating it (mode 600) on first use. Never stored in the DB.

    A file shorter than ``SECRET_BYTES`` (truncated by a crash, or edited) is
    refused rather than used or silently replaced: replacing it would void every
    outstanding token without anyone noticing, and a short key is weak.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        key = secrets.token_bytes(SECRET_BYTES)
        tmp = path.with_name(f"{path.name}.{secrets.token_hex(4)}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(key)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # link() is atomic and fails if another process created it first.
            os.link(tmp, path)
        except FileExistsError:
            pass  # lost the race: read the winner's key below
        finally:
            tmp.unlink(missing_ok=True)
    data = path.read_bytes()
    if len(data) < SECRET_BYTES:
        raise SecretKeyError(
            f"{path} is {len(data)} bytes; it must be at least {SECRET_BYTES}. "
            "Delete it to generate a new key (outstanding cast links stop working)."
        )
    return data


class SecretKeyError(RuntimeError):
    """The signing key file is unusable."""


_TOKEN_RE = re.compile(r"(\d{1,12})\.(\d{1,12})\.([0-9a-f]{64})")


@dataclass(frozen=True)
class ParsedToken:
    expiry: int
    user_id: int
    mac: str


def token_epoch(password_hash: str) -> str:
    """Changes whenever the user's password does, so a reset voids their tokens."""
    return hashlib.sha256(password_hash.encode("utf-8")).hexdigest()[:16]


def _mac(secret: bytes, video_id: int, expiry: int, user_id: int, epoch: str) -> str:
    message = f"{video_id}|{expiry}|{user_id}|{epoch}".encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def sign(
    secret: bytes,
    video_id: int,
    user_id: int,
    epoch: str,
    now: datetime | None = None,
) -> tuple[str, datetime]:
    expires_at = (now or datetime.now(UTC)) + TOKEN_TTL
    expiry = int(expires_at.timestamp())
    mac = _mac(secret, video_id, expiry, user_id, epoch)
    return f"{expiry}.{user_id}.{mac}", datetime.fromtimestamp(expiry, UTC)


def parse(token: str) -> ParsedToken | None:
    """Strict shape check; anything else (including non-ASCII) is not a token."""
    match = _TOKEN_RE.fullmatch(token)
    if match is None:
        return None
    return ParsedToken(int(match[1]), int(match[2]), match[3])


def verify(
    secret: bytes,
    parsed: ParsedToken,
    video_id: int,
    epoch: str,
    now: datetime | None = None,
) -> bool:
    """True if ``parsed`` was issued for this video, user and password, and is unexpired."""
    expected = _mac(secret, video_id, parsed.expiry, parsed.user_id, epoch)
    if not hmac.compare_digest(parsed.mac.encode("ascii"), expected.encode("ascii")):
        return False
    return parsed.expiry >= int((now or datetime.now(UTC)).timestamp())

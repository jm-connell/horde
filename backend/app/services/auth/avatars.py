"""Profile pictures: square JPEGs in ``DATA_DIR/avatars``.

Uploads are decoded and re-encoded (``normalize_to_jpeg``), so only a clean JPEG
is ever stored or served, whatever the client sent.

``User.avatar_version`` names the current file, ``{user_id}_{version}.jpg``, and
is the client's cache key: picture URLs carry it and are cached as immutable. So
a version is never reused for different bytes. It is a millisecond timestamp
that only moves forward, and each upload writes a file of its own, so a removal,
a concurrent upload in another tab, or a restored database backup never puts new
bytes behind a URL a browser already cached.
"""

from __future__ import annotations

import io
import logging
import os
import tempfile
import time
from pathlib import Path

from sqlmodel import Session

from ...context import get_paths
from ...models import User, utcnow
from ..thumbnails import normalize_to_jpeg
from .accounts import UserNotFound

logger = logging.getLogger(__name__)

#: Stored edge length in pixels; the UI shows it at most a few times smaller.
AVATAR_PX = 256


def avatar_path(user_id: int, version: int) -> Path:
    return get_paths().avatars / f"{user_id}_{version}.jpg"


def existing_avatar(user: User) -> Path | None:
    """The stored image for ``user``, or None when they have none."""
    if user.id is None or user.avatar_version is None:
        return None
    path = avatar_path(user.id, user.avatar_version)
    return path if path.is_file() else None


def square_jpeg(data: bytes) -> bytes:
    """Centre-crop ``data`` to a square AVATAR_PX JPEG. ValueError if not an image."""
    from PIL import Image, ImageOps

    # Validates and strips anything that is not pixels; the cap keeps the crop
    # below cheap however large the upload.
    clean = normalize_to_jpeg(data, max_px=AVATAR_PX * 4)
    with Image.open(io.BytesIO(clean), formats=["JPEG"]) as img:
        square = ImageOps.fit(img, (AVATAR_PX, AVATAR_PX), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        square.save(out, "JPEG", quality=88, optimize=True)
    return out.getvalue()


def _next_version(previous: int | None) -> int:
    return max(time.time_ns() // 1_000_000, (previous or 0) + 1)


def _write_atomically(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=f".{dest.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
        os.replace(tmp, dest)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def set_avatar(session: Session, user_id: int, data: bytes) -> User:
    """Store ``data`` as the account's picture. ValueError if it is not an image."""
    user = session.get(User, user_id)
    if user is None:
        raise UserNotFound("User not found")
    jpeg = square_jpeg(data)
    previous = user.avatar_version
    version = _next_version(previous)
    dest = avatar_path(user_id, version)
    _write_atomically(dest, jpeg)
    user.avatar_version = version
    user.updated_at = utcnow()
    session.add(user)
    try:
        session.commit()
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    session.refresh(user)
    # Only the file this upload replaced: another tab's upload may be between
    # writing its file and committing it.
    if previous is not None and previous != user.avatar_version:
        _unlink(avatar_path(user_id, previous))
    return user


def clear_avatar(session: Session, user_id: int) -> User:
    """Remove the account's picture (a no-op when there is none)."""
    user = session.get(User, user_id)
    if user is None:
        raise UserNotFound("User not found")
    if user.avatar_version is not None:
        user.avatar_version = None
        user.updated_at = utcnow()
        session.add(user)
        session.commit()
        session.refresh(user)
    unlink_avatars(user_id)
    return user


def unlink_avatars(user_id: int) -> None:
    """Remove every stored picture of ``user_id`` (on removal and account deletion)."""
    folder = get_paths().avatars
    if not folder.is_dir():
        return
    for path in folder.glob(f"{user_id}_*.jpg"):
        _unlink(path)


def _unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("could not remove avatar %s", path.name, exc_info=True)

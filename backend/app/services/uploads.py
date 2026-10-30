"""Bounded upload handling shared by every endpoint that accepts a file.

Rules:

* Uploads are copied in chunks with a running byte count, so a client cannot make
  the server hold or write more than the endpoint's cap (413 when exceeded).
* Content is checked by its leading bytes (fonts) or by decoding it (images), never
  by the client-supplied file name or content type alone.
* The same limits feed the request-size gate in ``app.security`` so an oversized
  body is refused before it is parsed.
"""

from __future__ import annotations

import io
import logging
import os
import shutil
from pathlib import Path

from fastapi import HTTPException, UploadFile

logger = logging.getLogger(__name__)

MB = 1024 * 1024
GB = 1024 * MB

FONT_MAX_BYTES = 8 * MB
BACKGROUND_MAX_BYTES = 100 * MB
IMAGE_MAX_BYTES = 15 * MB  # video thumbnails, playlist covers, profile pictures
#: A Google Takeout import, all files together (Takeout splits exports at 2 GB).
TAKEOUT_MAX_BYTES = 4 * GB

#: Most files kept in each user-asset folder (fonts, backgrounds).
MAX_STORED_FONTS = 50
MAX_STORED_BACKGROUNDS = 50

#: Free space that must remain after a video import.
IMPORT_HEADROOM_BYTES = GB

DEFAULT_MAX_UPLOAD_GB = 50.0

_CHUNK = MB


def max_video_upload_bytes() -> int:
    """``HORDE_MAX_UPLOAD_GB`` (default 50) for video imports, in bytes."""
    raw = os.environ.get("HORDE_MAX_UPLOAD_GB", "").strip()
    try:
        gb = float(raw) if raw else DEFAULT_MAX_UPLOAD_GB
    except ValueError:
        logger.warning("Ignoring invalid HORDE_MAX_UPLOAD_GB=%r", raw)
        gb = DEFAULT_MAX_UPLOAD_GB
    return int(max(gb, 0.001) * GB)


def _too_large(max_bytes: int) -> HTTPException:
    limit = f"{max_bytes / GB:.0f} GB" if max_bytes >= GB else f"{max_bytes // MB} MB"
    return HTTPException(status_code=413, detail=f"File too large (max {limit})")


def read_upload_bytes(file: UploadFile, max_bytes: int) -> bytes:
    """Read an upload into memory, stopping with 413 once ``max_bytes`` is passed.

    Blocking: Starlette has already spooled the whole upload to a temporary file by
    the time a handler runs, so these reads are disk I/O. Call it from a plain
    ``def`` route (which runs in the threadpool), never from the event loop.
    """
    buf = io.BytesIO()
    while True:
        chunk = file.file.read(_CHUNK)
        if not chunk:
            break
        if buf.tell() + len(chunk) > max_bytes:
            raise _too_large(max_bytes)
        buf.write(chunk)
    return buf.getvalue()


def save_upload(
    file: UploadFile,
    dest: Path,
    *,
    max_bytes: int,
    free_space_dir: Path | None = None,
    headroom_bytes: int = 0,
) -> int:
    """Stream ``file`` to ``dest`` and return the byte count.

    Raises 413 past ``max_bytes`` and 507 when ``free_space_dir`` would drop below
    ``headroom_bytes`` of free space. The partial file is removed on any error.
    Blocking, like ``read_upload_bytes``.
    """
    allowed = max_bytes
    if free_space_dir is not None:
        free = shutil.disk_usage(free_space_dir).free - headroom_bytes
        if free <= 0:
            raise HTTPException(status_code=507, detail="Not enough free disk space")
        allowed = min(allowed, free)
    dest.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        with dest.open("wb") as out:
            while True:
                chunk = file.file.read(_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > allowed:
                    if allowed < max_bytes:
                        raise HTTPException(
                            status_code=507, detail="Not enough free disk space"
                        )
                    raise _too_large(max_bytes)
                out.write(chunk)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    return written


# --- content checks --------------------------------------------------------

_FONT_MAGIC: dict[str, tuple[bytes, ...]] = {
    ".ttf": (b"\x00\x01\x00\x00", b"true"),
    ".otf": (b"OTTO",),
    ".woff": (b"wOFF",),
    ".woff2": (b"wOF2",),
}


def font_bytes_match_extension(ext: str, data: bytes) -> bool:
    """True when ``data`` starts with the signature of the font type ``ext``."""
    return any(data.startswith(magic) for magic in _FONT_MAGIC.get(ext.lower(), ()))


def is_webm(head: bytes) -> bool:
    """WebM/Matroska files start with the EBML magic number."""
    return head.startswith(b"\x1a\x45\xdf\xa3")


def verify_image_file(path: Path, formats: tuple[str, ...]) -> bool:
    """True when PIL can open ``path`` as one of ``formats`` and it passes verify()."""
    from PIL import Image

    try:
        with Image.open(path, formats=list(formats)) as img:
            img.verify()
    except Exception as exc:  # noqa: BLE001 - PIL raises many types for bad input
        logger.info("rejected image upload %s: %s", path.name, exc)
        return False
    return True


def count_files(folder: Path, suffixes: set[str]) -> int:
    return sum(
        1 for p in folder.iterdir() if p.is_file() and p.suffix.lower() in suffixes
    )

"""Full-size and list-tile thumbnail files on disk.

The download page shows ~176px-wide tiles. Browsers look muddy when they
downscale a maxres JPEG into that box, so we keep a second ~320px JPEG
(``{id}_sm.jpg``) fetched from a smaller source URL when available, otherwise
resized from the full image.
"""

from __future__ import annotations

import io
import logging
import shutil
from pathlib import Path
from typing import Optional

import httpx

from ..config import THUMBNAILS_DIR

logger = logging.getLogger(__name__)

# ~2× a 176px-wide card tile (w-44). Matches YouTube mqdefault.
LIST_THUMB_MAX_PX = 320


def full_path(video_id: int) -> Path:
    return THUMBNAILS_DIR / f"{video_id}.jpg"


def list_path(video_id: int) -> Path:
    return THUMBNAILS_DIR / f"{video_id}_sm.jpg"


def _open_rgb(data: bytes):
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    if img.mode != "RGB":
        img = img.convert("RGB")
    return img


def write_list_thumbnail(video_id: int, source: Path | bytes) -> bool:
    """Write ``{id}_sm.jpg`` from a file or raw image bytes. Returns True on success."""
    try:
        from PIL import Image

        if isinstance(source, Path):
            data = source.read_bytes()
        else:
            data = source
        img = _open_rgb(data)
        img.thumbnail((LIST_THUMB_MAX_PX, LIST_THUMB_MAX_PX), Image.Resampling.LANCZOS)
        dest = list_path(video_id)
        dest.parent.mkdir(parents=True, exist_ok=True)
        img.save(dest, "JPEG", quality=85, optimize=True)
        return dest.is_file() and dest.stat().st_size > 0
    except Exception:  # noqa: BLE001 — list thumbs must never fail a download
        logger.debug("list thumbnail write failed for %s", video_id, exc_info=True)
        return False


def ensure_list_thumbnail(video_id: int, full: Path) -> Optional[Path]:
    """Return the list JPEG, generating it from ``full`` if missing."""
    sm = list_path(video_id)
    if sm.is_file() and sm.stat().st_size > 0:
        return sm
    if not full.is_file():
        return None
    if write_list_thumbnail(video_id, full):
        return list_path(video_id)
    return None


def _http_get_bytes(url: str) -> bytes:
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        resp = client.get(url)
        resp.raise_for_status()
        return resp.content


def save_from_url(
    url: Optional[str],
    video_id: int,
    *,
    list_url: Optional[str] = None,
) -> Optional[str]:
    """Fetch the full thumbnail and a smaller list sibling. Returns the full path."""
    if not url:
        return None
    dest = full_path(video_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        dest.write_bytes(_http_get_bytes(url))
    except (httpx.HTTPError, OSError):
        return None
    wrote_list = False
    if list_url and list_url != url:
        try:
            wrote_list = write_list_thumbnail(video_id, _http_get_bytes(list_url))
        except (httpx.HTTPError, OSError):
            wrote_list = False
    if not wrote_list:
        write_list_thumbnail(video_id, dest)
    return str(dest)


def write_full_bytes(video_id: int, data: bytes) -> str:
    dest = full_path(video_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    write_list_thumbnail(video_id, dest)
    return str(dest)


def copy_full(src: Path, video_id: int) -> str:
    dest = full_path(video_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    write_list_thumbnail(video_id, dest)
    return str(dest)


def unlink_for_video(
    video_id: Optional[int],
    thumbnail_path: Optional[str] = None,
) -> None:
    if thumbnail_path:
        Path(thumbnail_path).unlink(missing_ok=True)
    if video_id is None:
        return
    full_path(video_id).unlink(missing_ok=True)
    list_path(video_id).unlink(missing_ok=True)

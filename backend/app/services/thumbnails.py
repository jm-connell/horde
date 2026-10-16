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

from ..context import get_paths
from .url_safety import UnsafeUrlError, UrlFetchError, fetch_bytes

logger = logging.getLogger(__name__)

# A remote thumbnail is a poster frame, never a large asset.
THUMB_FETCH_MAX_BYTES = 15 * 1024 * 1024
# Longest edge of a stored full-size thumbnail; keeps decoded memory bounded.
FULL_THUMB_MAX_PX = 3840
# Formats we accept as thumbnails. Everything else is rejected before decoding.
_IMAGE_FORMATS = ("JPEG", "PNG", "WEBP", "GIF", "BMP", "MPO")

# ~2× a 176px-wide card tile (w-44). Matches YouTube mqdefault.
LIST_THUMB_MAX_PX = 320


def full_path(video_id: int) -> Path:
    return get_paths().thumbnails / f"{video_id}.jpg"


def list_path(video_id: int) -> Path:
    return get_paths().thumbnails / f"{video_id}_sm.jpg"


def _open_rgb(data: bytes):
    from PIL import Image

    img = Image.open(io.BytesIO(data), formats=_IMAGE_FORMATS)
    if img.mode != "RGB":
        img = img.convert("RGB")
    return img


def normalize_to_jpeg(data: bytes, *, max_px: int = FULL_THUMB_MAX_PX) -> bytes:
    """Decode ``data`` as an image and return a clean JPEG.

    Re-encoding is the validation: bytes that are not an image raise
    ``ValueError``, and anything riding along in the original file (script in an
    SVG/HTML polyglot, metadata, trailing data) does not survive.
    """
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data), formats=_IMAGE_FORMATS)
        img.verify()
        # verify() leaves the image unusable; decode a fresh copy.
        img = _open_rgb(data)
        img.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        img.save(out, "JPEG", quality=90, optimize=True)
    except Exception as exc:
        raise ValueError("Not a valid image") from exc
    return out.getvalue()


def resolve_thumbnail_file(raw: str | None) -> Path | None:
    """The stored thumbnail/cover file for a DB path, only if it is inside THUMBNAILS_DIR."""
    if not raw:
        return None
    root = get_paths().thumbnails.resolve()
    path = Path(raw).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        return None
    return path


def write_list_thumbnail(video_id: int, source: Path | bytes) -> bool:
    """Write ``{id}_sm.jpg`` from a file or raw image bytes. Returns True on success."""
    try:
        from PIL import Image

        data = source.read_bytes() if isinstance(source, Path) else source
        img = _open_rgb(data)
        img.thumbnail((LIST_THUMB_MAX_PX, LIST_THUMB_MAX_PX), Image.Resampling.LANCZOS)
        dest = list_path(video_id)
        dest.parent.mkdir(parents=True, exist_ok=True)
        img.save(dest, "JPEG", quality=85, optimize=True)
        return dest.is_file() and dest.stat().st_size > 0
    except Exception:
        logger.debug("list thumbnail write failed for %s", video_id, exc_info=True)
        return False


def ensure_list_thumbnail(video_id: int, full: Path) -> Path | None:
    """Return the list JPEG, generating it from ``full`` if missing."""
    sm = list_path(video_id)
    if sm.is_file() and sm.stat().st_size > 0:
        return sm
    if not full.is_file():
        return None
    if write_list_thumbnail(video_id, full):
        return list_path(video_id)
    return None


def _fetch_jpeg(url: str) -> bytes:
    """Fetch a remote image through the SSRF gate and re-encode it as JPEG."""
    return normalize_to_jpeg(fetch_bytes(url, max_bytes=THUMB_FETCH_MAX_BYTES).body)


def save_from_url(
    url: str | None,
    video_id: int,
    *,
    list_url: str | None = None,
) -> str | None:
    """Fetch the full thumbnail and a smaller list sibling. Returns the full path."""
    if not url:
        return None
    dest = full_path(video_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        dest.write_bytes(_fetch_jpeg(url))
    except (UnsafeUrlError, UrlFetchError, ValueError, OSError) as exc:
        logger.info("thumbnail fetch failed for video %s: %s", video_id, exc)
        return None
    wrote_list = False
    if list_url and list_url != url:
        try:
            wrote_list = write_list_thumbnail(video_id, _fetch_jpeg(list_url))
        except (UnsafeUrlError, UrlFetchError, ValueError, OSError) as exc:
            logger.info("list thumbnail fetch failed for video %s: %s", video_id, exc)
            wrote_list = False
    if not wrote_list:
        write_list_thumbnail(video_id, dest)
    return str(dest)


def write_full_bytes(video_id: int, data: bytes) -> str:
    """Store an uploaded image as the full thumbnail. Raises ValueError if not an image."""
    jpeg = normalize_to_jpeg(data)
    dest = full_path(video_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(jpeg)
    write_list_thumbnail(video_id, dest)
    return str(dest)


def copy_full(src: Path, video_id: int) -> str:
    dest = full_path(video_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    write_list_thumbnail(video_id, dest)
    return str(dest)


def unlink_for_video(
    video_id: int | None,
    thumbnail_path: str | None = None,
) -> None:
    if thumbnail_path:
        Path(thumbnail_path).unlink(missing_ok=True)
    if video_id is None:
        return
    full_path(video_id).unlink(missing_ok=True)
    list_path(video_id).unlink(missing_ok=True)


PLAYLIST_COVER_MAX_PX = 1280


def playlist_cover_path(playlist_id: int) -> Path:
    return get_paths().thumbnails / f"playlist_{playlist_id}.jpg"


def write_playlist_cover(playlist_id: int, data: bytes) -> str:
    """Save an uploaded image as a JPEG cover. Raises ValueError if not an image."""
    jpeg = normalize_to_jpeg(data, max_px=PLAYLIST_COVER_MAX_PX)
    dest = playlist_cover_path(playlist_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(jpeg)
    return str(dest)


def unlink_playlist_cover(
    playlist_id: int | None,
    cover_path: str | None = None,
) -> None:
    if cover_path:
        Path(cover_path).unlink(missing_ok=True)
    if playlist_id is None:
        return
    playlist_cover_path(playlist_id).unlink(missing_ok=True)

"""A YouTube channel's profile picture, read from its channel page.

The page's ``og:image`` is the avatar on YouTube's image host; the browser loads
it from there like video thumbnails. Answers are remembered on the app context
(a week when found, a few hours when not) so a channel page does not read
YouTube on every visit.
"""

from __future__ import annotations

import html
import re
import threading
import time
from urllib.parse import urlsplit

from ..context import current
from .live.page import PAGE_HEADERS
from .url_safety import UnsafeUrlError, UrlFetchError, fetch_bytes

FOUND_TTL_SEC = 7 * 24 * 3600
MISSING_TTL_SEC = 6 * 3600
#: The header shows it at 44 px; this is enough for a 4x screen.
AVATAR_SIZE_PX = 176
_MAX_PAGE_BYTES = 6 * 1024 * 1024
_OG_IMAGE_RE = re.compile(r'<meta property="og:image" content="([^"]+)"')
_SIZE_RE = re.compile(r"=s\d+(?=-|$)")
AVATAR_HOSTS = frozenset({"yt3.googleusercontent.com", "yt3.ggpht.com"})


def parse_avatar(page: str) -> str | None:
    """The avatar URL in a channel page, sized for the header, or None."""
    match = _OG_IMAGE_RE.search(page)
    if not match:
        return None
    url = html.unescape(match.group(1))
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in AVATAR_HOSTS:
        return None
    return _SIZE_RE.sub(f"=s{AVATAR_SIZE_PX}", url, count=1)


class AvatarCache:
    """channel URL -> (avatar URL or None, when it was read)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[str | None, float]] = {}

    def get(self, channel_url: str) -> tuple[bool, str | None]:
        """(known, avatar): ``known`` is False when the channel must be read."""
        with self._lock:
            entry = self._entries.get(channel_url)
        if entry is None:
            return False, None
        avatar, at = entry
        ttl = FOUND_TTL_SEC if avatar else MISSING_TTL_SEC
        return time.time() - at < ttl, avatar

    def put(self, channel_url: str, avatar: str | None) -> None:
        with self._lock:
            self._entries[channel_url] = (avatar, time.time())


def cache() -> AvatarCache:
    found: AvatarCache = current().caches.setdefault("channel_avatars", AvatarCache())
    return found


class AvatarUnreadable(Exception):
    """The channel page could not be read (as opposed to having no avatar)."""


def read_avatar(channel_url: str) -> str | None:
    """Read the channel page for its avatar (None when it has none).

    Raises AvatarUnreadable when the page cannot be read.
    """
    try:
        result = fetch_bytes(
            channel_url, max_bytes=_MAX_PAGE_BYTES, timeout=15.0, headers=PAGE_HEADERS
        )
    except (UrlFetchError, UnsafeUrlError) as exc:
        raise AvatarUnreadable(channel_url) from exc
    return parse_avatar(result.body.decode("utf-8", errors="replace"))

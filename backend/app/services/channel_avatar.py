"""A YouTube channel's profile picture and short bio, read from its channel page.

The page's ``og:image`` is the avatar on YouTube's image host; the browser loads
it from there like video thumbnails. ``og:description`` is the channel's "about"
text, cut to ``ABOUT_MAX_CHARS``. Answers are remembered on the app context
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
#: The bio is a tagline on a card, not the whole about page.
ABOUT_MAX_CHARS = 160
_OG_IMAGE_RE = re.compile(r'<meta property="og:image" content="([^"]+)"')
_OG_DESC_RE = re.compile(r'<meta property="og:description" content="([^"]*)"')
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


def parse_about(page: str) -> str | None:
    """The channel's bio from its page, on one line and cut short, or None."""
    match = _OG_DESC_RE.search(page)
    if not match:
        return None
    text = " ".join(html.unescape(match.group(1)).split())
    if not text:
        return None
    if len(text) > ABOUT_MAX_CHARS:
        cut = text[: ABOUT_MAX_CHARS - 1].rsplit(" ", 1)[0]
        text = cut.rstrip(" ,.;:-") + "…"
    return text


class AvatarCache:
    """channel URL -> (avatar URL or None, bio or None, when it was read)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[str | None, str | None, float]] = {}

    def get(self, channel_url: str) -> tuple[bool, str | None, str | None]:
        """(known, avatar, about): ``known`` is False when it must be read."""
        with self._lock:
            entry = self._entries.get(channel_url)
        if entry is None:
            return False, None, None
        avatar, about, at = entry
        ttl = FOUND_TTL_SEC if avatar else MISSING_TTL_SEC
        return time.time() - at < ttl, avatar, about

    def put(
        self, channel_url: str, avatar: str | None, about: str | None = None
    ) -> None:
        with self._lock:
            self._entries[channel_url] = (avatar, about, time.time())


def cache() -> AvatarCache:
    found: AvatarCache = current().caches.setdefault("channel_avatars", AvatarCache())
    return found


class AvatarUnreadable(Exception):
    """The channel page could not be read (as opposed to having no avatar)."""


def read_channel_page(channel_url: str) -> str:
    """The HTML of a channel's page. Raises AvatarUnreadable when it cannot be read."""
    try:
        result = fetch_bytes(
            channel_url, max_bytes=_MAX_PAGE_BYTES, timeout=15.0, headers=PAGE_HEADERS
        )
    except (UrlFetchError, UnsafeUrlError) as exc:
        raise AvatarUnreadable(channel_url) from exc
    return result.body.decode("utf-8", errors="replace")


def read_avatar(channel_url: str) -> tuple[str | None, str | None]:
    """Read the channel page for its (avatar, bio); each None when it has none.

    Raises AvatarUnreadable when the page cannot be read.
    """
    page = read_channel_page(channel_url)
    return parse_avatar(page), parse_about(page)

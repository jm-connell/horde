"""The game a YouTube video is about, from the card under its description.

YouTube shows a box-art card ("Counter-Strike 2") under the description of a
Gaming video; yt-dlp does not report it, so the watch page is read once (one
HTML request, parsed like the live list's, ``live.page``) and the answer kept
on the app context: a week when found, a day when there is none.
"""

from __future__ import annotations

import threading
import time

from ..context import current
from .live.page import PAGE_HEADERS, VIDEO_ID_RE, _game_title, _json_after
from .url_safety import UnsafeUrlError, UrlFetchError, fetch_bytes

FOUND_TTL_SEC = 7 * 24 * 3600
MISSING_TTL_SEC = 24 * 3600
_MAX_PAGE_BYTES = 6 * 1024 * 1024
#: Videos remembered (every user's together).
CACHE_SIZE = 2000


class GameUnreadable(Exception):
    """The watch page could not be read (as opposed to having no game card)."""


class GameCache:
    """YouTube id -> (game or None, when it was read)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[str | None, float]] = {}

    def get(self, yt_id: str) -> tuple[bool, str | None]:
        """(known, game): ``known`` is False when the page must be read."""
        with self._lock:
            entry = self._entries.get(yt_id)
        if entry is None:
            return False, None
        game, at = entry
        ttl = FOUND_TTL_SEC if game else MISSING_TTL_SEC
        return time.time() - at < ttl, game

    def put(self, yt_id: str, game: str | None) -> None:
        with self._lock:
            self._entries[yt_id] = (game, time.time())
            if len(self._entries) > CACHE_SIZE:
                oldest = min(self._entries, key=lambda k: self._entries[k][1])
                del self._entries[oldest]


def cache() -> GameCache:
    found: GameCache = current().caches.setdefault("video_games", GameCache())
    return found


def parse_game(page: str) -> str | None:
    """The game card's title in a watch page, or None."""
    return _game_title(_json_after(page, "ytInitialData = "))


def read_game(yt_id: str) -> str | None:
    """Read the video's watch page for its game. Raises GameUnreadable."""
    if not VIDEO_ID_RE.match(yt_id):
        return None
    try:
        result = fetch_bytes(
            f"https://www.youtube.com/watch?v={yt_id}",
            max_bytes=_MAX_PAGE_BYTES,
            timeout=15.0,
            headers=PAGE_HEADERS,
        )
    except (UrlFetchError, UnsafeUrlError) as exc:
        raise GameUnreadable(yt_id) from exc
    return parse_game(result.body.decode("utf-8", errors="replace"))

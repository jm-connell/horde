"""Return YouTube Dislike API client (likes / dislikes for feed cards)."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_API = "https://returnyoutubedislikeapi.com/votes"
# Stay well under RYD's 100 req/min guidance.
_MIN_INTERVAL_SEC = 0.75
_TIMEOUT_SEC = 8.0

_lock = threading.Lock()
_last_fetch_at = 0.0


def fetch_votes(video_id: str) -> dict[str, int] | None:
    """Return {like_count, dislike_count} or None on failure / missing data."""
    yt_id = (video_id or "").strip()
    if not yt_id:
        return None

    global _last_fetch_at
    with _lock:
        now = time.monotonic()
        wait = _MIN_INTERVAL_SEC - (now - _last_fetch_at)
        if wait > 0:
            time.sleep(wait)
        try:
            resp = httpx.get(
                _API,
                params={"videoId": yt_id},
                timeout=_TIMEOUT_SEC,
                headers={"Accept": "application/json"},
            )
            _last_fetch_at = time.monotonic()
        except Exception:
            logger.debug("RYD fetch failed for %s", yt_id, exc_info=True)
            return None

    if resp.status_code != 200:
        return None
    try:
        data: Any = resp.json()
    except Exception:
        logger.debug("unparseable Return YouTube Dislike response", exc_info=True)
        return None
    if not isinstance(data, dict) or data.get("deleted"):
        return None

    likes = data.get("likes")
    dislikes = data.get("dislikes")
    try:
        like_count = int(likes) if likes is not None else None
        dislike_count = int(dislikes) if dislikes is not None else None
    except TypeError, ValueError:
        return None
    if like_count is None or dislike_count is None:
        return None
    if like_count < 0 or dislike_count < 0:
        return None
    return {"like_count": like_count, "dislike_count": dislike_count}

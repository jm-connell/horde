"""Shared yt-dlp option helpers."""

import threading
import time
from typing import Any, Optional

from ..config import (
    YTDLP_COOKIES_FROM_BROWSER,
    YTDLP_COOKIE_FILE,
    YTDLP_POT_BASE_URL,
)


def youtube_extractor_args() -> dict[str, Any]:
    args: dict[str, Any] = {
        "youtube": {"player_client": ["android_vr", "web", "ios"]},
    }
    if YTDLP_POT_BASE_URL:
        args["youtubepot-bgutilhttp"] = {"base_url": [YTDLP_POT_BASE_URL]}
    return args


def apply_cookie_opts(opts: dict[str, Any]) -> dict[str, Any]:
    """Attach cookie auth when configured (fixes YouTube bot checks)."""
    merged = dict(opts)
    if YTDLP_COOKIE_FILE is not None and YTDLP_COOKIE_FILE.is_file():
        merged["cookiefile"] = str(YTDLP_COOKIE_FILE)
    elif YTDLP_COOKIES_FROM_BROWSER:
        parts = YTDLP_COOKIES_FROM_BROWSER.split(":", 1)
        merged["cookiesfrombrowser"] = (
            (parts[0], parts[1]) if len(parts) == 2 else (parts[0],)
        )
    return merged


def cookie_configured() -> bool:
    if YTDLP_COOKIE_FILE is not None and YTDLP_COOKIE_FILE.is_file():
        return True
    return bool(YTDLP_COOKIES_FROM_BROWSER)


def pot_provider_configured() -> bool:
    return bool(YTDLP_POT_BASE_URL)


_plugins_loaded = False
_plugins_lock = threading.Lock()

# Serialize metadata extracts the same way downloads stay at low concurrency —
# bursty feed-card / preview extracts trip YouTube bot checks quickly.
_extract_sem = threading.Semaphore(1)
_extract_gate_lock = threading.Lock()
_last_extract_at = 0.0
_EXTRACT_MIN_INTERVAL_SEC = 1.25
_info_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_INFO_CACHE_TTL_SEC = 180.0
_INFO_CACHE_MAX = 48


def ensure_plugins_loaded() -> None:
    """Load yt-dlp plugins once before concurrent download workers start."""
    global _plugins_loaded
    if _plugins_loaded:
        return
    with _plugins_lock:
        if _plugins_loaded:
            return
        import yt_dlp

        with yt_dlp.YoutubeDL({"quiet": True}):
            pass
        _plugins_loaded = True


def extract_info_gated(
    url: str,
    opts: dict[str, Any],
    *,
    cache_key: Optional[str] = None,
) -> dict[str, Any]:
    """Run yt-dlp extract_info with global spacing + short result cache.

    Feed cards, download previews, and stream previews all share this gate so
    scrolling a channel feed cannot open dozens of parallel YouTube sessions.
    """
    global _last_extract_at

    key = cache_key or url
    now = time.time()
    cached = _info_cache.get(key)
    if cached and cached[0] > now:
        return dict(cached[1])

    ensure_plugins_loaded()
    import yt_dlp

    with _extract_sem:
        cached = _info_cache.get(key)
        now = time.time()
        if cached and cached[0] > now:
            return dict(cached[1])

        with _extract_gate_lock:
            wait = _EXTRACT_MIN_INTERVAL_SEC - (now - _last_extract_at)
        if wait > 0:
            time.sleep(wait)

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if not isinstance(info, dict):
            info = {}

        with _extract_gate_lock:
            _last_extract_at = time.time()
            _info_cache[key] = (_last_extract_at + _INFO_CACHE_TTL_SEC, info)
            if len(_info_cache) > _INFO_CACHE_MAX:
                oldest = sorted(_info_cache.items(), key=lambda item: item[1][0])
                for drop_key, _ in oldest[: len(_info_cache) - _INFO_CACHE_MAX]:
                    _info_cache.pop(drop_key, None)

        return dict(info)

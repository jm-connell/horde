"""Shared yt-dlp option helpers."""

import threading
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

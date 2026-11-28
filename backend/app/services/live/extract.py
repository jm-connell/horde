"""The extra yt-dlp lookup for a live broadcast's 1440p and 2160p formats.

YouTube's live HLS ladder stops at 1080p. Taller live formats exist only as
adaptive VP9 streams, listed to clients that run YouTube's player JavaScript
(yt-dlp's ``tv_samsung`` with a JS runtime, no PO token needed). Horde's other
extractions stay JS-less, so this is a separate extraction with its own cache
entry, run only when ``YTDLP_JS_RUNTIME`` is set. Whatever goes wrong here
costs the stream its taller variants, never the stream.
"""

from __future__ import annotations

import logging
from typing import Any

from ...config import YTDLP_JS_RUNTIME
from ..ytdlp_common import (
    EXTRACT_PRIORITY_INTERACTIVE,
    QuietYtdlpLogger,
    extract_info_gated,
    js_runtimes_option,
    youtube_extractor_args,
)
from .sessions import is_live_info

logger = logging.getLogger(__name__)


def enabled() -> bool:
    return js_runtimes_option(YTDLP_JS_RUNTIME) is not None


def extract_tall_formats(url: str, *, force: bool = False) -> list[dict[str, Any]]:
    """The live adaptive video formats of ``url`` (any height; the session keeps
    those taller than its HLS ladder). Empty when disabled, not live, or failed."""
    runtimes = js_runtimes_option(YTDLP_JS_RUNTIME)
    if runtimes is None:
        return []
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "logger": QuietYtdlpLogger(),
        "js_runtimes": runtimes,
        "extractor_args": {
            **youtube_extractor_args(),
            # "incomplete": yt-dlp hides live adaptive formats by default,
            # since it cannot download them from the start.
            "youtube": {"player_client": ["tv_samsung"], "formats": ["incomplete"]},
        },
    }
    try:
        info = extract_info_gated(
            url,
            opts,
            cache_key=f"{url}#live-tall",
            force=force,
            priority=EXTRACT_PRIORITY_INTERACTIVE,
        )
    except Exception:
        logger.warning("live 1440p/2160p lookup failed for %s", url, exc_info=True)
        return []
    if not is_live_info(info):
        return []
    return [
        fmt
        for fmt in info.get("formats") or []
        if isinstance(fmt, dict)
        and fmt.get("protocol") in ("http", "https")
        and str(fmt.get("vcodec") or "none") != "none"
    ]

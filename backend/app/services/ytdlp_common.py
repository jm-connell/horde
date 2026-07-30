"""Shared yt-dlp option helpers."""

import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

from ..config import (
    YTDLP_COOKIES_FROM_BROWSER,
    YTDLP_COOKIE_FILE,
    YTDLP_POT_BASE_URL,
)

_MEMBERS_ONLY_TITLE = re.compile(
    r"(?i)\[?\s*members?\s*-?\s*only\s*\]?"
)
_MEMBERS_ONLY_AVAILABILITY = frozenset(
    {"subscriber_only", "premium_only", "needs_auth"}
)
# yt-dlp error / log lines for locked membership videos (incl. tiered levels).
_MEMBERS_ONLY_MESSAGE = re.compile(
    r"(?i)("
    r"members?-?\s*only\s+content"
    r"|available to this channel'?s members"
    r"|join this channel to get access to members?-?\s*only"
    r"|members on level"
    r")"
)

_BOT_MESSAGE = re.compile(
    r"(?i)("
    r"sign in to confirm you.?re not a bot"
    r"|confirm you.?re not a bot"
    r"|not a bot"
    r"|bot.?check"
    r"|please sign in"
    r")"
)
_POT_MESSAGE = re.compile(
    r"(?i)("
    r"po[\s_-]?token"
    r"|gvs po token"
    r"|bgutil"
    r"|pot provider"
    r"|javascript challenge"
    r"|n challenge"
    r"|sabr streaming"
    r")"
)
_COOKIES_MESSAGE = re.compile(
    r"(?i)("
    r"login required"
    r"|sign in to youtube"
    r"|cookies?\s*(are\s*)?(missing|required|expired|invalid)"
    r"|age[\s-]?restricted"
    r"|confirm your age"
    r"|private video"
    r"|this video is private"
    r"|http error 401"
    r"|unauthorized"
    r")"
)
_RATE_LIMIT_MESSAGE = re.compile(
    r"(?i)("
    r"http error 429"
    r"|too many requests"
    r"|rate[\s-]?limit"
    r"|temporarily blocked"
    r"|try again later"
    r")"
)
_UNAVAILABLE_MESSAGE = re.compile(
    r"(?i)("
    r"video unavailable"
    r"|has been removed"
    r"|this video is not available"
    r"|copyright"
    r"|account associated with this video has been terminated"
    r"|geo[\s-]?blocked"
    r"|not available in your country"
    r"|no video formats found"
    r"|requested format is not available"
    r"|unsupported url"
    r"|is not a valid url"
    r")"
)
_POSTPROCESS_MESSAGE = re.compile(
    r"(?i)("
    r"unable to rename file"
    r"|unable to download video subtitles"
    r"|postprocessing:"
    r"|ffmpeg"
    r"|error merging"
    r"|error opening output file"
    r")"
)

# Stable failure kinds for DownloadJob.error_kind + health.
ERROR_KIND_MEMBERS = "members"
ERROR_KIND_BOT = "bot"
ERROR_KIND_POT = "pot"
ERROR_KIND_COOKIES = "cookies"
ERROR_KIND_RATE_LIMIT = "rate_limit"
ERROR_KIND_UNAVAILABLE = "unavailable"
ERROR_KIND_POSTPROCESS = "postprocess"
ERROR_KIND_CANCELLED = "cancelled"
ERROR_KIND_UNKNOWN = "unknown"

_last_extract_failure: Optional[dict[str, Any]] = None
_last_extract_failure_lock = threading.Lock()


class MembersOnlyError(Exception):
    """Raised when a video is YouTube members-only and should be skipped."""


def is_members_only_message(text: Optional[str]) -> bool:
    """True when a yt-dlp log/error string indicates members-only content."""
    if not text or not isinstance(text, str):
        return False
    return bool(_MEMBERS_ONLY_MESSAGE.search(text))


def is_members_only_error(exc: BaseException) -> bool:
    """True when an exception came from a members-only extract/download failure."""
    return is_members_only_message(str(exc))


def is_members_only_entry(entry: Optional[dict[str, Any]]) -> bool:
    """True when a yt-dlp / catalog entry looks like members-only content."""
    if not entry or not isinstance(entry, dict):
        return False
    availability = entry.get("availability")
    if isinstance(availability, str) and availability.strip().lower() in (
        _MEMBERS_ONLY_AVAILABILITY
    ):
        return True
    title = entry.get("title")
    if isinstance(title, str) and _MEMBERS_ONLY_TITLE.search(title):
        return True
    return False


def _strip_ansi_local(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


def classify_ytdlp_error(exc_or_message: Any) -> tuple[str, str]:
    """Map a yt-dlp exception/message to (error_kind, user_facing_message)."""
    if isinstance(exc_or_message, MembersOnlyError):
        return ERROR_KIND_MEMBERS, "Members-only video — skipped"

    raw = _strip_ansi_local(str(exc_or_message or "")).strip()
    if not raw:
        return ERROR_KIND_UNKNOWN, "Download failed"

    if is_members_only_message(raw) or isinstance(exc_or_message, MembersOnlyError):
        return ERROR_KIND_MEMBERS, "Members-only video — skipped"

    if _BOT_MESSAGE.search(raw):
        if cookie_configured():
            msg = (
                "YouTube bot check — cookies are configured but still blocked. "
                "Try refreshing cookies or check the PO token provider."
            )
        else:
            msg = (
                "YouTube bot check — configure cookies and/or a PO token provider "
                "(Settings → System / Compose bgutil-pot)."
            )
        return ERROR_KIND_BOT, msg

    if _POT_MESSAGE.search(raw):
        if pot_provider_configured():
            msg = (
                "PO token / player challenge failed — check that bgutil-pot is "
                "reachable from the Horde container."
            )
        else:
            msg = (
                "PO token required — set YTDLP_POT_BASE_URL / run the bgutil-pot "
                "sidecar (see YouTube access docs)."
            )
        return ERROR_KIND_POT, msg

    if _COOKIES_MESSAGE.search(raw):
        if cookie_configured():
            msg = (
                "Login / age gate — cookies may be expired or missing access. "
                "Refresh the cookie file or browser cookie source."
            )
        else:
            msg = (
                "Login / age gate — configure YTDLP_COOKIE_FILE or "
                "YTDLP_COOKIES_FROM_BROWSER."
            )
        return ERROR_KIND_COOKIES, msg

    if _RATE_LIMIT_MESSAGE.search(raw):
        return (
            ERROR_KIND_RATE_LIMIT,
            "Rate limited by the source — wait and retry; avoid bursty extracts.",
        )

    if _UNAVAILABLE_MESSAGE.search(raw):
        return ERROR_KIND_UNAVAILABLE, raw

    if _POSTPROCESS_MESSAGE.search(raw):
        return (
            ERROR_KIND_POSTPROCESS,
            "Download post-processing failed (merge/subtitles/ffmpeg). "
            f"Details: {raw}",
        )

    return ERROR_KIND_UNKNOWN, raw


def record_extract_failure(kind: str, message: str) -> None:
    """Remember the most recent extract/download classification for /api/health."""
    global _last_extract_failure
    with _last_extract_failure_lock:
        _last_extract_failure = {
            "kind": kind,
            "message": message,
            "at": datetime.now(timezone.utc).isoformat(),
        }


def get_last_extract_failure() -> Optional[dict[str, Any]]:
    with _last_extract_failure_lock:
        if _last_extract_failure is None:
            return None
        return dict(_last_extract_failure)


def http_detail_for_error(exc_or_message: Any, *, prefix: str) -> dict[str, str]:
    """Structured FastAPI HTTPException detail for classified yt-dlp failures."""
    kind, message = classify_ytdlp_error(exc_or_message)
    record_extract_failure(kind, message)
    return {
        "message": f"{prefix}: {message}",
        "error_kind": kind,
    }


class QuietYtdlpLogger:
    """yt-dlp logger that swallows members-only errors (and stays quiet otherwise)."""

    def __init__(self) -> None:
        self.members_only = False
        self.last_members_only_msg: Optional[str] = None

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        if is_members_only_message(msg):
            self.members_only = True
            self.last_members_only_msg = msg
            return
        # Leave non-members errors to yt-dlp's raised exceptions; avoid stderr spam.


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
    force: bool = False,
) -> dict[str, Any]:
    """Run yt-dlp extract_info with global spacing + short result cache.

    Feed cards, download previews, and stream previews all share this gate so
    scrolling a channel feed cannot open dozens of parallel YouTube sessions.

    When force=True, skip the cache read and invalidate any existing entry so
    CDN URL refresh actually fetches fresh format URLs.
    """
    global _last_extract_at

    key = cache_key or url
    now = time.time()
    if not force:
        cached = _info_cache.get(key)
        if cached and cached[0] > now:
            return dict(cached[1])
    else:
        _info_cache.pop(key, None)

    ensure_plugins_loaded()
    import yt_dlp

    with _extract_sem:
        if not force:
            cached = _info_cache.get(key)
            now = time.time()
            if cached and cached[0] > now:
                return dict(cached[1])

        with _extract_gate_lock:
            wait = _EXTRACT_MIN_INTERVAL_SEC - (time.time() - _last_extract_at)
        if wait > 0:
            time.sleep(wait)

        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception as exc:
            kind, message = classify_ytdlp_error(exc)
            record_extract_failure(kind, message)
            raise
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

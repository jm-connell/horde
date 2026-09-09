"""Shared yt-dlp option helpers."""

import heapq
import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

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

# Per-video catalog skips — do not abort the rest of the channel index.
SKIPPABLE_CATALOG_KINDS = frozenset(
    {ERROR_KIND_COOKIES, ERROR_KIND_MEMBERS, ERROR_KIND_UNAVAILABLE}
)
# Only these gates justify attaching cookies — never bot checks or listing traffic.
COOKIE_RETRY_KINDS = frozenset({ERROR_KIND_COOKIES, ERROR_KIND_MEMBERS})
_AGE_RESTRICTED_AVAILABILITY = frozenset({"age_restricted", "restricted"})
_CATALOG_SKIP_LABELS = {
    ERROR_KIND_COOKIES: "Age-restricted / private",
    ERROR_KIND_MEMBERS: "Members-only",
    ERROR_KIND_UNAVAILABLE: "Unavailable",
}

_last_extract_failure: Optional[dict[str, Any]] = None
_last_extract_failure_lock = threading.Lock()


class MembersOnlyError(Exception):
    """Raised when a video is YouTube members-only and should be skipped."""


class CatalogSkipError(Exception):
    """Per-video catalog skip (age-restricted, members-only, unavailable)."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


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


def is_age_restricted_entry(entry: Optional[dict[str, Any]]) -> bool:
    """True when a yt-dlp entry is age-gated (not members-only)."""
    if not entry or not isinstance(entry, dict):
        return False
    availability = entry.get("availability")
    if isinstance(availability, str) and availability.strip().lower() in (
        _AGE_RESTRICTED_AVAILABILITY
    ):
        return True
    age_limit = entry.get("age_limit")
    try:
        if age_limit is not None and int(age_limit) >= 18:
            return True
    except (TypeError, ValueError):
        pass
    return False


def is_skippable_catalog_kind(kind: Optional[str]) -> bool:
    return kind in SKIPPABLE_CATALOG_KINDS


def catalog_skip_message(
    kind: str,
    *,
    url: Optional[str] = None,
    title: Optional[str] = None,
    channel: Optional[str] = None,
) -> str:
    """Short channel-page toast when a gated video is skipped mid-index."""
    label = _CATALOG_SKIP_LABELS.get(kind, "Skipped")
    target = describe_extract_target(url, title=title, channel=channel)
    if target:
        return f"{label}: skipped {target} and continued indexing"
    return f"{label}: skipped a video and continued indexing"


def _strip_ansi_local(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


def _clip_label(text: str, limit: int = 80) -> str:
    cleaned = " ".join(str(text).split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3].rstrip() + "..."


def describe_extract_target(
    url: Optional[str] = None,
    *,
    title: Optional[str] = None,
    channel: Optional[str] = None,
) -> Optional[str]:
    """Short label for the video/channel an extract was aimed at."""
    title_s = _clip_label(title) if title else ""
    channel_s = _clip_label(channel, 60) if channel else ""
    if title_s and channel_s:
        return f'"{title_s}" · {channel_s}'
    if title_s:
        return f'"{title_s}"'

    raw = str(url or "").strip()
    if not raw:
        return channel_s or None

    lower = raw.lower()
    if lower.startswith("ytsearch"):
        query = raw.split(":", 1)[1].strip() if ":" in raw else ""
        return f'YouTube search "{_clip_label(query)}"' if query else "YouTube search"

    from urllib.parse import parse_qs, unquote, urlparse

    from .url_clean import youtube_video_id

    parsed_url = raw if "://" in raw else f"https://{raw}"
    try:
        parsed = urlparse(parsed_url)
    except ValueError:
        return channel_s or _clip_label(raw, 96)

    vid = youtube_video_id(parsed_url)
    path_parts = [p for p in (parsed.path or "").split("/") if p]
    query = parse_qs(parsed.query)

    handle = None
    channel_id = None
    userish = None
    tab = None
    if path_parts:
        if path_parts[0].startswith("@"):
            handle = path_parts[0]
            tab = path_parts[1] if len(path_parts) > 1 else None
        elif path_parts[0] == "channel" and len(path_parts) > 1:
            channel_id = path_parts[1]
            tab = path_parts[2] if len(path_parts) > 2 else None
        elif path_parts[0] in ("c", "user") and len(path_parts) > 1:
            userish = path_parts[1]
            tab = path_parts[2] if len(path_parts) > 2 else None

    search_q = query.get("query", [None])[0] if tab == "search" else None
    if search_q:
        loc = handle or userish or channel_s or (
            f"channel {_clip_label(channel_id, 24)}" if channel_id else "channel"
        )
        return f'{loc} search "{_clip_label(unquote(str(search_q)))}"'

    if vid:
        if channel_s:
            return f"{channel_s} · video {vid}"
        return f"youtube.com/watch?v={vid}"

    playlist = query.get("list", [None])[0]
    if playlist and (not vid or (path_parts and path_parts[0] == "playlist")):
        return f"playlist {_clip_label(str(playlist), 40)}"

    if handle:
        return handle
    if userish:
        return userish
    if channel_id:
        return channel_s or f"channel {_clip_label(channel_id, 24)}"
    if channel_s:
        return channel_s

    host = (parsed.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = (parsed.path or "").rstrip("/")
    if host:
        return _clip_label(f"{host}{path}", 96)
    return _clip_label(raw, 96)


def _with_extract_target(
    message: str,
    *,
    url: Optional[str] = None,
    title: Optional[str] = None,
    channel: Optional[str] = None,
) -> str:
    target = describe_extract_target(url, title=title, channel=channel)
    if not target:
        return message
    suffix = f" On: {target}"
    if message.endswith(suffix):
        return message
    return f"{message}{suffix}"


def classify_ytdlp_error(
    exc_or_message: Any,
    *,
    url: Optional[str] = None,
    title: Optional[str] = None,
    channel: Optional[str] = None,
) -> tuple[str, str]:
    """Map a yt-dlp exception/message to (error_kind, user_facing_message)."""
    def _finish(kind: str, message: str) -> tuple[str, str]:
        return kind, _with_extract_target(
            message, url=url, title=title, channel=channel
        )

    if isinstance(exc_or_message, MembersOnlyError):
        return _finish(
            ERROR_KIND_MEMBERS,
            "Members-only video — skipped. Member videos can't be downloaded "
            "anonymously.",
        )

    raw = _strip_ansi_local(str(exc_or_message or "")).strip()
    if not raw:
        return _finish(ERROR_KIND_UNKNOWN, "Download failed")

    if is_members_only_message(raw) or isinstance(exc_or_message, MembersOnlyError):
        return _finish(
            ERROR_KIND_MEMBERS,
            "Members-only video — skipped. Member videos can't be downloaded "
            "anonymously.",
        )

    if _BOT_MESSAGE.search(raw):
        if pot_provider_configured():
            msg = (
                "YouTube bot check — check that the PO token provider is healthy. "
                "Horde does not send cookies for bot checks."
            )
        else:
            msg = (
                "YouTube bot check — configure a PO token provider "
                "(Settings → System / Compose bgutil-pot). "
                "Horde does not send cookies for bot checks."
            )
        return _finish(ERROR_KIND_BOT, msg)

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
        return _finish(ERROR_KIND_POT, msg)

    if _COOKIES_MESSAGE.search(raw):
        if cookie_configured():
            msg = (
                "This looks like an age-restricted, members-only, or private "
                "video — those can't be downloaded anonymously. Cookies are "
                "configured but still don't have access. Refresh them, or use "
                "an account that can watch this video."
            )
        else:
            msg = (
                "This looks like an age-restricted, members-only, or private "
                "video — those can't be downloaded anonymously. Horde's PO "
                "tokens only cover public videos. To get this one you'd need "
                "cookies from a signed-in account that can watch it "
                "(YTDLP_COOKIE_FILE or YTDLP_COOKIES_FROM_BROWSER)."
            )
        return _finish(ERROR_KIND_COOKIES, msg)

    if re.search(r"http error 403|403:\s*forbidden", raw, re.I):
        return _finish(
            ERROR_KIND_POT,
            "YouTube rejected the media URL (HTTP 403). Usually a stale "
            "player client or missing PO token — update yt-dlp and check "
            "the POT sidecar.",
        )

    if _RATE_LIMIT_MESSAGE.search(raw):
        return _finish(
            ERROR_KIND_RATE_LIMIT,
            "Rate limited by the source — wait and retry; avoid bursty extracts.",
        )

    if _UNAVAILABLE_MESSAGE.search(raw):
        return _finish(ERROR_KIND_UNAVAILABLE, raw)

    if _POSTPROCESS_MESSAGE.search(raw):
        return _finish(
            ERROR_KIND_POSTPROCESS,
            "Download post-processing failed (merge/subtitles/ffmpeg). "
            f"Details: {raw}",
        )

    return _finish(ERROR_KIND_UNKNOWN, raw)


def record_extract_failure(
    kind: str,
    message: str,
    *,
    url: Optional[str] = None,
    title: Optional[str] = None,
    channel: Optional[str] = None,
) -> None:
    """Remember the most recent extract/download classification for /api/health."""
    global _last_extract_failure
    target = describe_extract_target(url, title=title, channel=channel)
    payload: dict[str, Any] = {
        "kind": kind,
        "message": message,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    if target:
        payload["target"] = target
    if url:
        payload["url"] = str(url).strip()[:500]
    with _last_extract_failure_lock:
        _last_extract_failure = payload


def get_last_extract_failure() -> Optional[dict[str, Any]]:
    with _last_extract_failure_lock:
        if _last_extract_failure is None:
            return None
        return dict(_last_extract_failure)


def http_detail_for_error(
    exc_or_message: Any,
    *,
    prefix: str,
    url: Optional[str] = None,
    title: Optional[str] = None,
    channel: Optional[str] = None,
) -> dict[str, str]:
    """Structured FastAPI HTTPException detail for classified yt-dlp failures."""
    kind, message = classify_ytdlp_error(
        exc_or_message, url=url, title=title, channel=channel
    )
    record_extract_failure(kind, message, url=url, title=title, channel=channel)
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
    # Do not force android_vr. YouTube now 403s those GVS URLs after ~60s of
    # Range requests (Shaka 1001 / empty downloads). yt-dlp 2026.8.19+ defaults
    # to visionos, which still serves https adaptive URLs without a PO token.
    args: dict[str, Any] = {
        "youtube": {"player_client": ["default", "-android_vr"]},
        # Channel/search tabs omit upload_date; this turns "3 years ago" into a timestamp.
        "youtubetab": {"approximate_date": ["true"]},
    }
    if YTDLP_POT_BASE_URL:
        args["youtubepot-bgutilhttp"] = {"base_url": [YTDLP_POT_BASE_URL]}
    return args


_AUTH_CACHE_SUFFIX = ":auth"

_extract_tls = threading.local()
_cookie_required_lock = threading.Lock()
_cookie_required_until: dict[str, float] = {}


def apply_cookie_opts(opts: dict[str, Any]) -> dict[str, Any]:
    """Attach cookie auth when configured. Call only after a per-video gate."""
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


def opts_have_cookies(opts: dict[str, Any]) -> bool:
    return bool(opts.get("cookiefile") or opts.get("cookiesfrombrowser"))


def error_kind_for_cookie_retry(exc: BaseException) -> Optional[str]:
    kind, _ = classify_ytdlp_error(exc)
    if kind in COOKIE_RETRY_KINDS:
        return kind
    return None


def should_retry_with_cookies(
    opts: dict[str, Any],
    exc: Optional[BaseException] = None,
    *,
    logger_members_only: bool = False,
) -> bool:
    """True when this per-video action should be retried once with cookies."""
    if not cookie_configured() or opts_have_cookies(opts):
        return False
    if logger_members_only:
        return True
    if exc is None:
        return False
    return error_kind_for_cookie_retry(exc) is not None


def extract_has_media(info: Optional[dict[str, Any]]) -> bool:
    """True when yt-dlp returned downloadable media (not a gated stub)."""
    if not info or not isinstance(info, dict):
        return False
    formats = info.get("formats") or []
    if isinstance(formats, list):
        for fmt in formats:
            if not isinstance(fmt, dict):
                continue
            if fmt.get("url") or fmt.get("fragments") or fmt.get("fragment_base_url"):
                return True
    if info.get("url") and info.get("ext") and info.get("_type") != "playlist":
        return True
    requested = info.get("requested_formats") or info.get("requested_downloads") or []
    if isinstance(requested, list):
        for fmt in requested:
            if isinstance(fmt, dict) and (fmt.get("url") or fmt.get("fragments")):
                return True
    return False


def _info_blocked_without_auth(info: dict[str, Any], opts: dict[str, Any]) -> bool:
    """Successful extract that is still a gated stub — worth one cookie retry."""
    if opts.get("extract_flat"):
        # Channel/search listings stay anonymous. Single-video preview uses
        # extract_flat in_playlist but should still cookie-retry a gated stub.
        if info.get("_type") == "playlist" or info.get("entries"):
            return False
    if not (is_members_only_entry(info) or is_age_restricted_entry(info)):
        return False
    if extract_has_media(info):
        return False
    desc = info.get("description")
    if isinstance(desc, str) and desc.strip():
        return False
    return True


def extract_used_cookies() -> bool:
    """Whether the latest extract_info_gated call on this thread attached cookies."""
    return bool(getattr(_extract_tls, "used_cookies", False))


def remember_cookie_required(url: str) -> None:
    key = str(url or "").strip()
    if not key:
        return
    now = time.time()
    with _cookie_required_lock:
        _cookie_required_until[key] = now + _INFO_CACHE_TTL_SEC
        stale = [u for u, exp in _cookie_required_until.items() if exp <= now]
        for old in stale:
            _cookie_required_until.pop(old, None)


def url_cookie_required(url: str) -> bool:
    key = str(url or "").strip()
    if not key:
        return False
    now = time.time()
    with _cookie_required_lock:
        exp = _cookie_required_until.get(key)
        if exp is None:
            return False
        if exp <= now:
            _cookie_required_until.pop(key, None)
            return False
        return True


def _auth_cache_key(key: str) -> str:
    if key.endswith(_AUTH_CACHE_SUFFIX):
        return key
    return f"{key}{_AUTH_CACHE_SUFFIX}"


def _cache_put(key: str, info: dict[str, Any]) -> None:
    global _last_extract_at
    with _extract_gate_lock:
        _last_extract_at = time.time()
        _info_cache[key] = (_last_extract_at + _INFO_CACHE_TTL_SEC, info)
        if len(_info_cache) > _INFO_CACHE_MAX:
            oldest = sorted(_info_cache.items(), key=lambda item: item[1][0])
            for drop_key, _ in oldest[: len(_info_cache) - _INFO_CACHE_MAX]:
                _info_cache.pop(drop_key, None)


def _cache_get(key: str) -> Optional[dict[str, Any]]:
    cached = _info_cache.get(key)
    if cached and cached[0] > time.time():
        return dict(cached[1])
    return None


_plugins_loaded = False
_plugins_lock = threading.Lock()

# Serialize metadata extracts the same way downloads stay at low concurrency —
# bursty feed-card / preview extracts trip YouTube bot checks quickly.
# Interactive preview jumps ahead of background job-metadata fills.
EXTRACT_PRIORITY_INTERACTIVE = 0
EXTRACT_PRIORITY_DOWNLOAD = 1
EXTRACT_PRIORITY_BACKGROUND = 2

_extract_gate_lock = threading.Lock()
_extract_held = False
_extract_waiter_seq = 0
_extract_waiters: list[tuple[int, int, threading.Event]] = []
_last_extract_at = 0.0
_EXTRACT_MIN_INTERVAL_SEC = 1.25
_info_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_INFO_CACHE_TTL_SEC = 180.0
_INFO_CACHE_MAX = 48


def _acquire_extract_gate(priority: int) -> None:
    """One extract at a time; lower ``priority`` values run first."""
    global _extract_held, _extract_waiter_seq
    with _extract_gate_lock:
        if not _extract_held and not _extract_waiters:
            _extract_held = True
            return
        waiter = threading.Event()
        heapq.heappush(
            _extract_waiters, (int(priority), _extract_waiter_seq, waiter)
        )
        _extract_waiter_seq += 1
    waiter.wait()


def _release_extract_gate() -> None:
    global _extract_held
    with _extract_gate_lock:
        if _extract_waiters:
            _prio, _seq, waiter = heapq.heappop(_extract_waiters)
            waiter.set()
            return
        _extract_held = False


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


def _ytdlp_extract(url: str, opts: dict[str, Any]) -> dict[str, Any]:
    import yt_dlp

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return info if isinstance(info, dict) else {}


def extract_info_gated(
    url: str,
    opts: dict[str, Any],
    *,
    cache_key: Optional[str] = None,
    force: bool = False,
    title: Optional[str] = None,
    channel: Optional[str] = None,
    cookie_retry: bool = True,
    priority: int = EXTRACT_PRIORITY_DOWNLOAD,
) -> dict[str, Any]:
    """Run yt-dlp extract_info with global spacing + short result cache.

    Feed cards, download previews, and stream previews all share this gate so
    scrolling a channel feed cannot open dozens of parallel YouTube sessions.

    When force=True, skip the cache read and invalidate any existing entry so
    CDN URL refresh actually fetches fresh format URLs.

    Cookies are not attached by default. When cookie_retry=True (single-video
    extracts) and YouTube blocks with an age-restricted or members-only gate,
    the same extract is retried once with cookies if they are configured.
    Channel listings and search pass cookie_retry=False.
    """
    _extract_tls.used_cookies = opts_have_cookies(opts)
    key = cache_key or url
    auth_key = _auth_cache_key(key)
    prefer_cookies = (
        cookie_retry
        and cookie_configured()
        and not opts_have_cookies(opts)
        and url_cookie_required(url)
    )

    if force:
        _info_cache.pop(key, None)
        _info_cache.pop(auth_key, None)
    else:
        if prefer_cookies:
            cached = _cache_get(auth_key)
            if cached is not None:
                _extract_tls.used_cookies = True
                return cached
        else:
            cached = _cache_get(key)
            if cached is not None:
                return cached

    ensure_plugins_loaded()

    def _record_failure(exc: BaseException) -> None:
        kind, message = classify_ytdlp_error(
            exc, url=url, title=title, channel=channel
        )
        record_extract_failure(
            kind, message, url=url, title=title, channel=channel
        )

    def _extract_with_cookies(*, known: bool = False) -> dict[str, Any]:
        cookie_opts = apply_cookie_opts(opts)
        if not opts_have_cookies(cookie_opts):
            raise RuntimeError("cookies configured but could not be attached")
        if known:
            logger.info("Using cookies for previously gated video: %s", url)
        else:
            logger.info(
                "Retrying extract with cookies after age/members gate: %s", url
            )
        info = _ytdlp_extract(url, cookie_opts)
        _extract_tls.used_cookies = True
        remember_cookie_required(url)
        _cache_put(auth_key, info)
        return dict(info)

    _acquire_extract_gate(priority)
    try:
        if not force:
            if prefer_cookies:
                cached = _cache_get(auth_key)
                if cached is not None:
                    _extract_tls.used_cookies = True
                    return cached
            else:
                cached = _cache_get(key)
                if cached is not None:
                    return cached

        with _extract_gate_lock:
            wait = _EXTRACT_MIN_INTERVAL_SEC - (time.time() - _last_extract_at)
        if wait > 0:
            time.sleep(wait)

        if prefer_cookies:
            try:
                return _extract_with_cookies(known=True)
            except Exception as exc:
                _record_failure(exc)
                raise

        try:
            info = _ytdlp_extract(url, opts)
        except Exception as exc:
            if cookie_retry and should_retry_with_cookies(opts, exc):
                try:
                    return _extract_with_cookies()
                except Exception as retry_exc:
                    _record_failure(retry_exc)
                    raise retry_exc from exc
            _record_failure(exc)
            raise

        if cookie_retry and _info_blocked_without_auth(info, opts):
            if should_retry_with_cookies(opts, None, logger_members_only=True):
                try:
                    return _extract_with_cookies()
                except Exception as retry_exc:
                    _record_failure(retry_exc)
                    raise

        _extract_tls.used_cookies = opts_have_cookies(opts)
        _cache_put(key, info)
        return dict(info)
    finally:
        _release_extract_gate()

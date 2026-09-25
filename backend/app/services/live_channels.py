"""Background probe of library YouTube channels that are on the air now.

Catalog `live_status` is only as fresh as the last uploads-tab sync, and the
active stream often is not on that tab. This worker asks each library channel's
`/live` URL and keeps a short in-memory list for the navigation bar.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from typing import Any, Callable, Optional

from sqlmodel import Session

from ..database import engine
from . import app_settings, library
from .channel_catalog.runtime import _normalize_channel_url, is_youtube_channel_url
from .url_clean import youtube_video_id
from .ytdlp_common import (
    EXTRACT_PRIORITY_BACKGROUND,
    QuietYtdlpLogger,
    classify_ytdlp_error,
    extract_info_gated,
    record_extract_failure,
    youtube_extractor_args,
)
from .ytdlp_extract import _entry_thumbnail_url

logger = logging.getLogger(__name__)

POSITIVE_TTL_SEC = 3 * 60
NEGATIVE_TTL_SEC = 8 * 60
# Keep a confirmed live row across a couple of transient probe failures.
GRACE_SEC = 10 * 60
STARTUP_DELAY_SEC = 45
IDLE_SEC = 15
DISABLED_WAIT_SEC = 5

_YT_ID = re.compile(r"^[\w-]{11}$")
_OFFLINE_MARKERS = (
    "not currently live",
    "is not currently live",
    "no live stream",
    "no live streams",
    "channel is offline",
    "live event will begin",
    "this live event will begin",
    "premieres in",
    "premiere will begin",
)

_stop = threading.Event()
_thread: Optional[threading.Thread] = None
_lock = threading.Lock()
_hits: dict[str, dict[str, Any]] = {}
_negative_until: dict[str, float] = {}

ExtractFn = Callable[[str], dict[str, Any]]


def clear_listing() -> None:
    with _lock:
        _hits.clear()
        _negative_until.clear()


def reset_for_tests() -> None:
    clear_listing()


def listing_enabled() -> bool:
    ui = app_settings.load().get("ui")
    if not isinstance(ui, dict):
        return False
    return bool(ui.get("show_live_channels"))


def channel_live_url(channel_url: str) -> str:
    base = _normalize_channel_url(channel_url).rstrip("/")
    if base.endswith("/live"):
        base = base[: -len("/live")]
    return f"{base}/live"


def is_benign_offline(exc: BaseException) -> bool:
    message = str(exc).lower()
    return any(marker in message for marker in _OFFLINE_MARKERS)


def _video_id(entry: dict[str, Any]) -> Optional[str]:
    vid = str(entry.get("id") or "").strip()
    if _YT_ID.fullmatch(vid):
        return vid
    for key in ("url", "webpage_url", "original_url"):
        raw = entry.get(key)
        if not raw:
            continue
        found = youtube_video_id(str(raw))
        if found:
            return found
    return None


def _primary_entry(info: dict[str, Any]) -> Optional[dict[str, Any]]:
    entries = info.get("entries")
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, dict) and _video_id(entry):
                return entry
    if _video_id(info):
        return info
    return None


def _entry_is_current_live(entry: dict[str, Any]) -> bool:
    status = str(entry.get("live_status") or "").strip().lower()
    if status in {"was_live", "is_upcoming", "not_live", "post_live"}:
        return False
    if status == "is_live" or entry.get("is_live") is True:
        return True
    # `/live` only resolves a video while the channel is on the air. A missing
    # flag still counts; an explicit finished/upcoming status does not.
    return _video_id(entry) is not None


def _watch_url(entry: dict[str, Any], video_id: str) -> str:
    for key in ("webpage_url", "original_url", "url"):
        raw = str(entry.get(key) or "")
        if raw.startswith("http") and youtube_video_id(raw) == video_id:
            return raw.split("&list=")[0]
    return f"https://www.youtube.com/watch?v={video_id}"


def snapshot() -> list[dict[str, Any]]:
    """Live rows still inside the grace window, oldest check last."""
    now = time.time()
    with _lock:
        rows = [
            dict(row)
            for row in _hits.values()
            if now - float(row.get("checked_at") or 0) <= GRACE_SEC
        ]
    rows.sort(key=lambda row: str(row.get("channel") or "").lower())
    return rows


def _mark_offline(key: str) -> None:
    with _lock:
        _hits.pop(key, None)
        _negative_until[key] = time.time() + NEGATIVE_TTL_SEC


def _mark_live(key: str, row: dict[str, Any]) -> None:
    with _lock:
        _negative_until.pop(key, None)
        _hits[key] = row


def _due(key: str, now: float) -> bool:
    with _lock:
        if now < _negative_until.get(key, 0):
            return False
        row = _hits.get(key)
        if row is not None and now - float(row.get("checked_at") or 0) < POSITIVE_TTL_SEC:
            return False
    return True


def library_targets() -> list[tuple[str, str]]:
    """Unique YouTube channels that already have a URL in the library."""
    with Session(engine) as session:
        rows = library.channel_stats(session)
    seen: set[str] = set()
    targets: list[tuple[str, str]] = []
    for row in rows:
        raw = (row.channel_url or "").strip()
        if not raw or not is_youtube_channel_url(raw):
            continue
        key = _normalize_channel_url(raw)
        if not key or key in seen:
            continue
        seen.add(key)
        targets.append((row.channel, key))
    return targets


def _default_extract(url: str) -> dict[str, Any]:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "playlistend": 1,
        "ignoreerrors": False,
        "logger": QuietYtdlpLogger(),
        "extractor_args": youtube_extractor_args(),
    }
    info = extract_info_gated(
        url,
        opts,
        cache_key=f"channel-live:{url}",
        force=True,
        cookie_retry=False,
        priority=EXTRACT_PRIORITY_BACKGROUND,
        record_errors=False,
    )
    return info if isinstance(info, dict) else {}


def probe_one(
    channel: str,
    channel_url: str,
    *,
    extract: Optional[ExtractFn] = None,
) -> str:
    """Probe one channel. Returns ``live``, ``offline``, or ``error``.

    A transient error leaves a previous live row in place until the grace
    window passes. A confirmed offline result removes it immediately.
    """
    key = _normalize_channel_url(channel_url)
    if not key or not is_youtube_channel_url(key):
        return "offline"
    live_url = channel_live_url(key)
    extract_fn = extract or _default_extract
    try:
        info = extract_fn(live_url)
    except Exception as exc:  # noqa: BLE001
        if is_benign_offline(exc):
            _mark_offline(key)
            return "offline"
        kind, message = classify_ytdlp_error(exc, url=live_url, channel=channel)
        record_extract_failure(kind, message, url=live_url, channel=channel)
        logger.warning("Live probe failed for %s: %s", channel, message)
        return "error"

    if not isinstance(info, dict):
        _mark_offline(key)
        return "offline"
    entry = _primary_entry(info)
    if entry is None or not _entry_is_current_live(entry):
        _mark_offline(key)
        return "offline"
    video_id = _video_id(entry)
    if not video_id:
        _mark_offline(key)
        return "offline"
    name = (channel or "").strip() or str(
        entry.get("channel") or entry.get("uploader") or info.get("channel") or ""
    ).strip()
    title = entry.get("title") or info.get("title")
    _mark_live(
        key,
        {
            "channel": name or "Channel",
            "channel_url": key,
            "video_id": video_id,
            "url": _watch_url(entry, video_id),
            "title": str(title).strip() if title else None,
            "thumbnail_url": _entry_thumbnail_url(entry, video_id),
            "checked_at": time.time(),
        },
    )
    return "live"


def _sweep() -> None:
    now = time.time()
    for channel, url in library_targets():
        if _stop.is_set() or not listing_enabled():
            return
        if not _due(url, now):
            continue
        probe_one(channel, url)
        now = time.time()


def _loop() -> None:
    if _stop.wait(STARTUP_DELAY_SEC):
        return
    while not _stop.is_set():
        if not listing_enabled():
            clear_listing()
            if _stop.wait(DISABLED_WAIT_SEC):
                return
            continue
        try:
            _sweep()
        except Exception:  # noqa: BLE001
            logger.exception("live channel sweep failed")
        if _stop.wait(IDLE_SEC):
            return


def start_live_channel_worker() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="live-channels", daemon=True)
    _thread.start()


def stop_live_channel_worker() -> None:
    _stop.set()

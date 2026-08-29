"""yt-dlp metadata extract helpers (preview cards, channel feed, search).

Download queue / playlist-import orchestration stays in downloader.py.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

from .ytdlp_common import (
    MembersOnlyError,
    QuietYtdlpLogger,
    apply_cookie_opts,
    extract_info_gated,
    is_members_only_entry,
    is_members_only_error,
    youtube_extractor_args,
)
from .ytdlp_formats import (
    FORMAT_SORT,
    QUALITY_FORMATS,
    _available_presets,
    _has_audio,
    _height_to_tier,
    _video_heights,
)


def _as_info(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _purge_members_only_yt_id(yt_id: str) -> None:
    try:
        from .channel_catalog.skips import purge_members_only_by_yt_id

        purge_members_only_by_yt_id(yt_id)
    except Exception:  # noqa: BLE001
        logger.debug("members-only catalog purge failed", exc_info=True)


def _purge_members_only_url(url: str) -> None:
    from .url_clean import youtube_video_id

    yt_id = youtube_video_id(url)
    if yt_id:
        _purge_members_only_yt_id(yt_id)


def _duration_seconds(info: dict[str, Any]) -> Optional[float]:
    raw = info.get("duration")
    if raw is None:
        return None
    try:
        duration = float(raw)
    except (TypeError, ValueError):
        return None
    return duration if duration > 0 else None


def _bitrate_bytes(fmt: dict[str, Any], duration: Optional[float]) -> Optional[int]:
    tbr = fmt.get("tbr") or fmt.get("vbr") or fmt.get("abr")
    dur = duration if duration is not None else fmt.get("duration")
    if tbr is None or dur is None:
        return None
    try:
        n = int(float(tbr) * 1000 / 8 * float(dur))
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _format_byte_size(
    fmt: dict[str, Any], duration: Optional[float] = None
) -> Optional[int]:
    exact = fmt.get("filesize")
    if exact:
        try:
            n = int(exact)
        except (TypeError, ValueError):
            n = 0
        if n > 0:
            return n
    approx = fmt.get("filesize_approx")
    approx_n: Optional[int] = None
    if approx:
        try:
            parsed = int(approx)
        except (TypeError, ValueError):
            parsed = 0
        if parsed > 0:
            approx_n = parsed
    from_tbr = _bitrate_bytes(fmt, duration)
    # Merged DASH dicts often keep only the audio filesize_approx when the
    # video leg has no Content-Length; prefer bitrate when it is far larger.
    if approx_n and from_tbr and approx_n < from_tbr * 0.25:
        is_video = fmt.get("vcodec") not in (None, "none")
        if is_video or fmt.get("requested_formats"):
            return from_tbr
    return approx_n or from_tbr


def _format_parts_bytes(
    fmt: dict[str, Any], duration: Optional[float]
) -> Optional[int]:
    parts = fmt.get("requested_formats")
    if not isinstance(parts, list) or not parts:
        return _format_byte_size(fmt, duration)
    total = 0
    saw_video = False
    video_missing = False
    for part in parts:
        if not isinstance(part, dict):
            continue
        is_video = part.get("vcodec") not in (None, "none")
        if is_video:
            saw_video = True
        size = _format_byte_size(part, duration)
        if size is None:
            if is_video:
                video_missing = True
                continue
            return None
        total += size
    if saw_video and video_missing:
        return None
    return total if total else None


def _format_selector_context(formats: list[Any]) -> dict[str, Any]:
    return {
        "formats": formats,
        "has_merged_format": any(
            "none" not in (f.get("vcodec"), f.get("acodec"))
            for f in formats
            if isinstance(f, dict)
        ),
        "incomplete_formats": (
            all(f.get("vcodec") == "none" for f in formats if isinstance(f, dict))
            or all(f.get("acodec") == "none" for f in formats if isinstance(f, dict))
        ),
    }


def _estimate_preset_bytes(
    ydl: Any, info: dict[str, Any], format_spec: str
) -> Optional[int]:
    formats = info.get("formats") or []
    if not formats:
        return None
    duration = _duration_seconds(info)
    try:
        selector = ydl.build_format_selector(format_spec)
        selected = list(selector(_format_selector_context(formats)))
    except Exception:  # noqa: BLE001
        return None
    if not selected:
        return None
    total = 0
    for fmt in selected:
        if not isinstance(fmt, dict):
            continue
        size = _format_parts_bytes(fmt, duration)
        if size is None:
            return None
        total += size
    return total if total else None


def _estimate_preset_sizes(
    info: dict[str, Any], presets: list[str]
) -> dict[str, int]:
    import yt_dlp

    sizes: dict[str, int] = {}
    formats = info.get("formats") or []
    if not formats:
        return sizes
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "format_sort": FORMAT_SORT,
        }
    )
    work = {**info, "formats": list(formats)}
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            ydl.sort_formats(work)
        except Exception:  # noqa: BLE001
            pass
        for preset in presets:
            format_spec = QUALITY_FORMATS.get(preset)
            if not format_spec:
                continue
            try:
                size = _estimate_preset_bytes(ydl, work, format_spec)
            except Exception:  # noqa: BLE001
                size = None
            if size:
                sizes[preset] = size
    return sizes


def extract_preview(url: str) -> dict[str, Any]:
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": "in_playlist",
            "logger": QuietYtdlpLogger(),
            "extractor_args": youtube_extractor_args(),
        }
    )
    try:
        info = _as_info(extract_info_gated(url, opts, cache_key=f"preview:{url}"))
    except Exception as exc:  # noqa: BLE001
        if is_members_only_error(exc):
            _purge_members_only_url(url)
            raise MembersOnlyError("Members-only video — skipped") from exc
        raise
    if is_members_only_entry(info):
        yt_id = info.get("id")
        if yt_id:
            _purge_members_only_yt_id(str(yt_id))
        else:
            _purge_members_only_url(url)
        raise MembersOnlyError("Members-only video — skipped")

    if info.get("_type") == "playlist" or info.get("entries") is not None:
        entries = [e for e in (info.get("entries") or []) if e]
        return {
            "is_playlist": True,
            "title": info.get("title"),
            "channel": info.get("uploader") or info.get("channel"),
            "channel_url": info.get("uploader_url") or info.get("channel_url"),
            "thumbnail_url": _best_thumbnail_url(info),
            "entry_count": len(entries),
            "available_presets": [],
            "preset_sizes": {},
        }

    available = _available_presets(info)
    view_count = info.get("view_count")
    if view_count is not None:
        try:
            view_count = int(view_count)
        except (TypeError, ValueError):
            view_count = None
    from .feed_meta_cache import parse_upload_date

    published_at = parse_upload_date(
        info.get("upload_date")
        or info.get("release_timestamp")
        or info.get("timestamp")
    )
    return {
        "is_playlist": False,
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url"),
        "thumbnail_url": _best_thumbnail_url(info),
        "entry_count": None,
        "view_count": view_count,
        "published_at": published_at,
        "available_presets": available,
        "preset_sizes": _estimate_preset_sizes(info, available),
    }


def extract_playlist_entries(url: str) -> dict[str, Any]:
    """Fast flat extraction of playlist metadata and entry list."""
    import yt_dlp

    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": "in_playlist",
            "skip_download": True,
            "extractor_args": youtube_extractor_args(),
        }
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = _as_info(ydl.extract_info(url, download=False))

    entries: list[dict[str, Any]] = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        if is_members_only_entry(entry):
            continue
        entry_url = entry.get("url") or entry.get("webpage_url")
        vid = entry.get("id")
        if entry_url and not str(entry_url).startswith("http"):
            entry_url = None
        if not entry_url and vid:
            entry_url = f"https://www.youtube.com/watch?v={vid}"
        if not entry_url:
            continue
        view_count = entry.get("view_count")
        if view_count is not None:
            try:
                view_count = int(view_count)
            except (TypeError, ValueError):
                view_count = None
        entries.append(
            {
                "id": vid,
                "url": entry_url,
                "title": entry.get("title"),
                "channel": entry.get("uploader") or entry.get("channel"),
                "duration": entry.get("duration"),
                "thumbnail_url": _entry_thumbnail_url(entry, vid),
                "view_count": view_count,
            }
        )

    return {
        "title": info.get("title") or "Imported playlist",
        "channel": info.get("uploader") or info.get("channel"),
        "entries": entries,
    }


_FEED_CACHE_TTL_SEC = 300
_feed_cache: dict[tuple[str, int, int, int], tuple[float, dict[str, Any]]] = {}
_feed_cache_lock = threading.Lock()


def _best_thumbnail_url(
    info: dict[str, Any], vid: Optional[str] = None
) -> Optional[str]:
    """Pick the highest-res thumbnail from yt-dlp info, or a YouTube CDN URL."""
    thumbs = info.get("thumbnails")
    best_url: Optional[str] = None
    best_area = -1
    if isinstance(thumbs, list):
        for item in thumbs:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not url:
                continue
            w = item.get("width") or 0
            h = item.get("height") or 0
            try:
                area = int(w) * int(h)
            except (TypeError, ValueError):
                area = 0
            if area >= best_area:
                best_area = area
                best_url = str(url).strip()
    if best_url:
        if best_url.startswith("//"):
            return f"https:{best_url}"
        return best_url
    thumb = info.get("thumbnail")
    if thumb:
        s = str(thumb).strip()
        if s.startswith("//"):
            return f"https:{s}"
        if s.startswith("http"):
            return s
    video_id = vid or info.get("id")
    if isinstance(video_id, str) and video_id:
        # hqdefault is reliably available; maxresdefault 404s for some videos.
        return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return None


def _entry_thumbnail_url(entry: dict[str, Any], vid: Optional[str]) -> Optional[str]:
    """Resolve a thumbnail URL from flat extract data or YouTube video id."""
    return _best_thumbnail_url(entry, vid)


def _playlist_count(info: dict[str, Any]) -> Optional[int]:
    raw = info.get("playlist_count") or info.get("n_entries")
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _channel_videos_url(channel_url: str) -> str:
    url = channel_url.strip().rstrip("/")
    if url.endswith("/videos"):
        return url
    for suffix in ("/shorts", "/streams", "/playlists", "/featured", "/about"):
        if url.endswith(suffix):
            return url[: -len(suffix)] + "/videos"
    return f"{url}/videos"


def fetch_channel_feed(
    channel_url: str, offset: int = 0, limit: int = 30
) -> dict[str, Any]:
    """Fetch a page of uploads from a YouTube channel tab."""
    import yt_dlp

    offset = max(0, offset)
    limit = max(1, min(limit, 100))
    feed_url = _channel_videos_url(channel_url)
    cache_key = (feed_url, offset, limit, 3)
    now = time.time()
    with _feed_cache_lock:
        cached = _feed_cache.get(cache_key)
        if cached and now - cached[0] < _FEED_CACHE_TTL_SEC:
            return cached[1]

    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": "in_playlist",
            "skip_download": True,
            "playliststart": offset + 1,
            "playlistend": offset + limit,
            "extractor_args": youtube_extractor_args(),
        }
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = _as_info(ydl.extract_info(feed_url, download=False))

    entries: list[dict[str, Any]] = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        if is_members_only_entry(entry):
            continue
        entry_url = entry.get("url") or entry.get("webpage_url")
        vid = entry.get("id")
        if entry_url and not str(entry_url).startswith("http"):
            entry_url = None
        if not entry_url and vid:
            entry_url = f"https://www.youtube.com/watch?v={vid}"
        if not entry_url:
            continue
        view_count = entry.get("view_count")
        if view_count is not None:
            try:
                view_count = int(view_count)
            except (TypeError, ValueError):
                view_count = None
        from .feed_meta_cache import parse_upload_date

        published_at = parse_upload_date(
            entry.get("upload_date") or entry.get("release_timestamp") or entry.get("timestamp")
        )
        availability = entry.get("availability")
        entries.append(
            {
                "id": vid,
                "url": entry_url,
                "title": entry.get("title"),
                "duration": entry.get("duration"),
                "thumbnail_url": _entry_thumbnail_url(entry, vid),
                "view_count": view_count,
                "published_at": published_at,
                "availability": availability,
            }
        )

    result = {
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url") or channel_url,
        "entries": entries,
        "has_more": len(entries) == limit,
        "playlist_count": _playlist_count(info),
    }
    with _feed_cache_lock:
        _feed_cache[cache_key] = (now, result)
    return result


def estimate_playlist_sizes(
    urls: list[str], max_entries: int = 100
) -> dict[str, dict[str, int]]:
    """Best-effort per-URL preset size estimates (may be partial)."""
    sizes: dict[str, dict[str, int]] = {}
    for url in urls[:max_entries]:
        try:
            preview = extract_preview(url)
            if preview.get("preset_sizes"):
                sizes[url] = preview["preset_sizes"]
        except Exception:  # noqa: BLE001
            continue
    return sizes


def extract_playlist(url: str) -> tuple[str, list[str]]:
    import yt_dlp

    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": "in_playlist",
            "skip_download": True,
            "extractor_args": youtube_extractor_args(),
        }
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = _as_info(ydl.extract_info(url, download=False))

    title = info.get("title") or "Imported playlist"
    entries = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        entry_url = entry.get("url") or entry.get("webpage_url")
        vid = entry.get("id")
        if entry_url and entry_url.startswith("http"):
            entries.append(entry_url)
        elif vid:
            entries.append(f"https://www.youtube.com/watch?v={vid}")
    return title, entries


def search_youtube_channels(query: str, *, limit: int = 8) -> list[dict[str, Any]]:
    """Search YouTube for channels matching query (yt-dlp flat extract)."""
    import urllib.parse

    import yt_dlp

    q = (query or "").strip()
    if not q:
        return []
    limit = max(1, min(limit, 20))
    # sp=EgIQAg%253D%253D filters YouTube results to Channels.
    search_url = (
        "https://www.youtube.com/results?search_query="
        + urllib.parse.quote(q)
        + "&sp=EgIQAg%253D%253D"
    )
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": "in_playlist",
            "skip_download": True,
            "playlistend": limit,
            "extractor_args": youtube_extractor_args(),
        }
    )
    results: list[dict[str, Any]] = []
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = _as_info(ydl.extract_info(search_url, download=False))
    except Exception:  # noqa: BLE001
        return []

    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url") or entry.get("webpage_url") or entry.get("channel_url")
        if not url:
            channel_id = entry.get("channel_id") or entry.get("id")
            if channel_id and str(channel_id).startswith("UC"):
                url = f"https://www.youtube.com/channel/{channel_id}"
        if not url or not str(url).startswith("http"):
            continue
        name = (
            entry.get("channel")
            or entry.get("uploader")
            or entry.get("title")
            or entry.get("id")
        )
        if not name:
            continue
        results.append(
            {
                "name": str(name),
                "url": str(url).split("/videos")[0].rstrip("/"),
                "thumbnail_url": entry.get("thumbnail")
                or (entry.get("thumbnails") or [{}])[-1].get("url"),
                "subscriber_count": entry.get("channel_follower_count")
                or entry.get("subscriber_count"),
            }
        )
        if len(results) >= limit:
            break
    return results



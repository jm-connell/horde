"""yt-dlp metadata extract helpers (preview cards, channel feed, search).

Download queue / playlist-import orchestration stays in downloader.py.
"""

from __future__ import annotations

import logging
import re
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
    _available_presets,
    _has_audio,
    _height_to_tier,
    _video_heights,
    default_download_video_codec,
    format_chain,
    format_sort_for,
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
    codec = default_download_video_codec()
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "format_sort": format_sort_for("best", codec),
        }
    )
    work = {**info, "formats": list(formats)}
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            ydl.sort_formats(work)
        except Exception:  # noqa: BLE001
            pass
        for preset in presets:
            size: Optional[int] = None
            for format_spec in format_chain(preset, codec):
                try:
                    size = _estimate_preset_bytes(ydl, work, format_spec)
                except Exception:  # noqa: BLE001
                    size = None
                if size:
                    break
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
    from .feed_meta_cache import published_meta_from_entry

    meta = published_meta_from_entry(info)
    return {
        "is_playlist": False,
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url"),
        "thumbnail_url": _best_thumbnail_url(info),
        "entry_count": None,
        "view_count": view_count,
        "published_at": meta.iso,
        "published_label": meta.label,
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


_YOUTUBE_ID_RE = re.compile(r"^[\w-]{11}$")
_YTIMG_ID_RE = re.compile(r"ytimg\.com/vi(?:_webp)?/([\w-]{11})/", re.I)
_LIST_THUMB_TARGET_W = 320
_WIDESCREEN = 16 / 9


def _abs_thumb_url(url: str) -> str:
    s = url.strip()
    if s.startswith("//"):
        return f"https:{s}"
    return s


def _youtube_thumb_id(
    info: dict[str, Any], vid: Optional[str] = None, extra_url: Optional[str] = None
) -> Optional[str]:
    for candidate in (vid, info.get("id"), extra_url, info.get("thumbnail")):
        if not isinstance(candidate, str) or not candidate:
            continue
        raw = candidate.strip()
        if _YOUTUBE_ID_RE.match(raw):
            return raw
        found = _YTIMG_ID_RE.search(raw)
        if found:
            return found.group(1)
    return None


def _iter_sized_thumbs(info: dict[str, Any]):
    thumbs = info.get("thumbnails")
    if not isinstance(thumbs, list):
        return
    for item in thumbs:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not url:
            continue
        ident = str(item.get("id") or "").lower()
        url_s = str(url)
        if "storyboard" in ident or "storyboard" in url_s.lower():
            continue
        w = item.get("width") or 0
        h = item.get("height") or 0
        try:
            width = int(w)
            height = int(h)
        except (TypeError, ValueError):
            width, height = 0, 0
        yield width, height, url_s


def _best_thumbnail_url(
    info: dict[str, Any], vid: Optional[str] = None
) -> Optional[str]:
    """Pick the highest-res thumbnail from yt-dlp info, or a YouTube CDN URL."""
    best_url: Optional[str] = None
    best_area = -1
    for width, height, url_s in _iter_sized_thumbs(info):
        area = width * height
        if area >= best_area:
            best_area = area
            best_url = url_s.strip()
    if best_url:
        return _abs_thumb_url(best_url)
    thumb = info.get("thumbnail")
    if thumb:
        s = str(thumb).strip()
        if s.startswith("//") or s.startswith("http"):
            return _abs_thumb_url(s)
    video_id = _youtube_thumb_id(info, vid)
    if video_id:
        # hqdefault is reliably available; maxresdefault 404s for some videos.
        return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return None


def _list_thumbnail_url(
    info: dict[str, Any], vid: Optional[str] = None
) -> Optional[str]:
    """Pick a ~320px-wide 16:9 thumb for list tiles, or YouTube mqdefault."""
    widescreen: list[tuple[int, str]] = []
    any_sized: list[tuple[int, str]] = []
    for width, height, url_s in _iter_sized_thumbs(info):
        dist = abs(width - _LIST_THUMB_TARGET_W) if width else 10_000
        any_sized.append((dist, url_s))
        if width > 0 and height > 0 and abs((width / height) - _WIDESCREEN) <= 0.12:
            widescreen.append((dist, url_s))
    if widescreen:
        widescreen.sort(key=lambda t: t[0])
        return _abs_thumb_url(widescreen[0][1])
    yt_id = _youtube_thumb_id(info, vid)
    if yt_id:
        return f"https://i.ytimg.com/vi/{yt_id}/mqdefault.jpg"
    if any_sized:
        any_sized.sort(key=lambda t: t[0])
        return _abs_thumb_url(any_sized[0][1])
    return _best_thumbnail_url(info, vid)


def _entry_thumbnail_url(entry: dict[str, Any], vid: Optional[str]) -> Optional[str]:
    """Resolve a thumbnail URL from flat extract data or YouTube video id."""
    return _best_thumbnail_url(entry, vid)


_YT_VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")
_SHORTS_TITLE_RE = re.compile(r"#\s*shorts\b", re.I)
# YouTube Shorts launched in 2021; older sub-minute videos are regular uploads.
_SHORTS_ERA_TS = 1609459200  # 2021-01-01 UTC


def is_youtube_playlist_entry(entry: dict[str, Any]) -> bool:
    """True for playlist/tab lockups mixed into channel search results."""
    url = str(entry.get("url") or entry.get("webpage_url") or "").lower()
    if "list=" in url or "/playlist" in url:
        return True
    ie = str(entry.get("ie_key") or "")
    if ie in ("YoutubeTab", "YoutubePlaylist"):
        return True
    vid = entry.get("id")
    return isinstance(vid, str) and not _YT_VIDEO_ID_RE.fullmatch(vid)


def is_youtube_short_entry(entry: dict[str, Any]) -> bool:
    """True for Shorts (watch or /shorts/ URLs) in channel search results."""
    url = str(entry.get("url") or entry.get("webpage_url") or "").lower()
    if "/shorts/" in url:
        return True
    title = str(entry.get("title") or "")
    if _SHORTS_TITLE_RE.search(title):
        return True
    duration = entry.get("duration")
    try:
        dur = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        dur = None
    if dur is None or dur <= 0 or dur > 60:
        return False
    ts = entry.get("timestamp") or entry.get("release_timestamp")
    try:
        ts_n = float(ts) if ts is not None else None
    except (TypeError, ValueError):
        ts_n = None
    return ts_n is None or ts_n >= _SHORTS_ERA_TS


def _map_flat_video_entry(entry: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Normalize a flat yt-dlp playlist entry into catalog/feed fields."""
    if not isinstance(entry, dict):
        return None
    if is_members_only_entry(entry) or is_youtube_playlist_entry(entry):
        return None
    entry_url = entry.get("url") or entry.get("webpage_url")
    vid = entry.get("id")
    if entry_url and not str(entry_url).startswith("http"):
        entry_url = None
    if not entry_url and vid:
        entry_url = f"https://www.youtube.com/watch?v={vid}"
    if not entry_url:
        return None
    if "/shorts/" in str(entry_url).lower():
        return None
    view_count = entry.get("view_count")
    if view_count is not None:
        try:
            view_count = int(view_count)
        except (TypeError, ValueError):
            view_count = None
    from .feed_meta_cache import published_meta_from_entry

    meta = published_meta_from_entry(entry)
    return {
        "id": vid,
        "url": entry_url,
        "title": entry.get("title"),
        "duration": entry.get("duration"),
        "thumbnail_url": _entry_thumbnail_url(entry, vid),
        "view_count": view_count,
        "published_at": meta.iso,
        "published_label": meta.label,
        "availability": entry.get("availability"),
    }


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
    for suffix in ("/shorts", "/streams", "/playlists", "/featured", "/about", "/search"):
        if url.endswith(suffix):
            return url[: -len(suffix)] + "/videos"
    return f"{url}/videos"


def is_youtube_url(url: str) -> bool:
    from urllib.parse import urlparse

    raw = (url or "").strip()
    if not raw:
        return False
    parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    host = (parsed.netloc or "").lower().replace("www.", "")
    return "youtube.com" in host or host == "youtu.be"


def channel_search_url(channel_url: str, query: str) -> str:
    """YouTube in-channel search tab: /@handle/search?query=…"""
    import urllib.parse

    base = _channel_videos_url(channel_url)
    if base.endswith("/videos"):
        base = base[: -len("/videos")]
    q = urllib.parse.quote((query or "").strip())
    return f"{base}/search?query={q}"


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
        mapped = _map_flat_video_entry(entry)
        if mapped is None:
            continue
        entries.append(mapped)

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


def search_youtube_channel_videos(
    channel_url: str, query: str, *, limit: int = 20
) -> list[dict[str, Any]]:
    """Flat extract of a channel's YouTube search tab (titles, thumbs, dates)."""
    q = (query or "").strip()
    if len(q) < 2 or not is_youtube_url(channel_url):
        return []
    limit = max(1, min(int(limit or 20), 40))
    search_url = channel_search_url(channel_url, q)
    # Over-fetch: channel search interleaves Shorts and playlists with videos.
    fetch_n = min(80, max(limit * 4, 40))
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": "in_playlist",
            "skip_download": True,
            "playlistend": fetch_n,
            "logger": QuietYtdlpLogger(),
            "extractor_args": youtube_extractor_args(),
        }
    )
    try:
        info = _as_info(
            extract_info_gated(
                search_url, opts, cache_key=f"channel-search:v2:{search_url}:{fetch_n}"
            )
        )
    except Exception:  # noqa: BLE001
        logger.debug("channel youtube search failed for %s", search_url, exc_info=True)
        return []

    channel_name = info.get("uploader") or info.get("channel")
    entries: list[dict[str, Any]] = []
    for raw in info.get("entries") or []:
        if not isinstance(raw, dict) or is_youtube_short_entry(raw):
            continue
        mapped = _map_flat_video_entry(raw)
        if mapped is None:
            continue
        mapped["channel"] = channel_name
        mapped["match_reason"] = {"source": "youtube", "snippet": None}
        entries.append(mapped)
        if len(entries) >= limit:
            break
    return entries


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



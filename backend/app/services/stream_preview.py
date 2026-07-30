"""In-app stream preview (progressive + adaptive DASH).

Extracted from downloader.py so download-queue code stays separate from
CDN/manifest caching used by api/preview.py.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Optional
from xml.sax.saxutils import escape as xml_escape

import httpx

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
from .ytdlp_extract import _best_thumbnail_url
from .ytdlp_formats import _available_presets


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


# --- In-app stream preview (progressive + adaptive DASH) ---
_PREVIEW_CACHE_TTL_SEC = 240
_PREVIEW_MANIFEST_TTL_SEC = 5 * 3600 + 1800  # ~5.5h; CDN URLs last ~6h
_PREVIEW_MAX_HEIGHT = 720
_PREVIEW_PROBE_SIZES = (256 * 1024, 1024 * 1024, 4 * 1024 * 1024)
_PREVIEW_REFRESH_DEBOUNCE_SEC = 10.0
_PREVIEW_REFRESH_PROACTIVE_SEC = 5 * 60
_PREVIEW_REFRESH_MAX_ATTEMPTS = 3
_preview_stream_cache: dict[str, dict[str, Any]] = {}
_preview_manifest_by_url: dict[str, dict[str, Any]] = {}
_preview_manifest_by_token: dict[str, dict[str, Any]] = {}
_preview_stream_lock = threading.Lock()
_preview_extract_sem = threading.Semaphore(2)
_preview_refresh_inflight: dict[str, threading.Event] = {}
_preview_refresh_last_at: dict[str, float] = {}
_preview_refresh_attempts: dict[str, int] = {}


class PreviewRefreshError(RuntimeError):
    """CDN URL refresh failed; clients should back off."""

    def __init__(self, message: str, *, retry_after: int = 15):
        super().__init__(message)
        self.retry_after = retry_after


def _pick_progressive_format(info: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Best muxed progressive format at or below preview height cap."""
    formats = info.get("formats") or []
    candidates: list[tuple[int, dict[str, Any]]] = []
    for fmt in formats:
        if not isinstance(fmt, dict):
            continue
        if not fmt.get("url"):
            continue
        vcodec = str(fmt.get("vcodec") or "none")
        acodec = str(fmt.get("acodec") or "none")
        if vcodec == "none" or acodec == "none":
            continue
        height = int(fmt.get("height") or 0)
        if height > _PREVIEW_MAX_HEIGHT:
            continue
        ext = str(fmt.get("ext") or "")
        # Prefer mp4, then higher height, then higher tbr.
        score = height * 10
        if ext == "mp4":
            score += 100_000
        elif ext in ("webm", "mkv"):
            score += 50_000
        tbr = fmt.get("tbr") or 0
        try:
            score += int(float(tbr))
        except (TypeError, ValueError):
            pass
        candidates.append((score, fmt))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _is_mp4_video_codec(vcodec: str) -> bool:
    v = vcodec.lower()
    return v.startswith("avc1") or v.startswith("av01") or v.startswith("avc")


def _is_mp4_audio_codec(acodec: str) -> bool:
    a = acodec.lower()
    return a.startswith("mp4a") or a in ("aac", "mp4a.40.2", "mp4a.40.5")


def _video_codec_family(vcodec: str) -> Optional[str]:
    v = vcodec.lower()
    if v.startswith("av01"):
        return "av01"
    if v.startswith("avc1") or v.startswith("avc"):
        return "avc1"
    return None


def _pick_adaptive_formats(
    info: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Select MP4 adaptive video (H.264/AV1) + AAC audio for DASH preview.

    Video formats are kept per (codec family, height) so each AdaptationSet
    stays codec-homogeneous. Audio prefers non-DRC, original-language AAC.
    """
    formats = info.get("formats") or []
    # (family, height) -> best format
    video_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    audio_candidates: list[tuple[int, dict[str, Any]]] = []
    original_lang = str(
        info.get("language") or info.get("original_language") or ""
    ).lower()

    for fmt in formats:
        if not isinstance(fmt, dict) or not fmt.get("url"):
            continue
        ext = str(fmt.get("ext") or "").lower()
        if ext not in ("mp4", "m4a"):
            continue
        # Skip storyboard / image formats.
        if str(fmt.get("format_note") or "").lower().startswith("storyboard"):
            continue
        if fmt.get("protocol") in ("mhtml", "m3u8", "m3u8_native", "http_dash_segments"):
            continue
        # SegmentBase DASH needs a single-file URL with sidx, not a fragment list.
        if fmt.get("fragments"):
            continue

        vcodec = str(fmt.get("vcodec") or "none")
        acodec = str(fmt.get("acodec") or "none")
        height = int(fmt.get("height") or 0)

        # Video-only adaptive (no audio track).
        if vcodec != "none" and acodec == "none" and height > 0:
            family = _video_codec_family(vcodec)
            if family is None:
                continue
            score = height * 1000
            tbr = fmt.get("tbr") or fmt.get("vbr") or 0
            try:
                score += int(float(tbr))
            except (TypeError, ValueError):
                pass
            key = (family, height)
            prev = video_by_key.get(key)
            if prev is None or score > int(prev.get("_score") or 0):
                entry = dict(fmt)
                entry["_score"] = score
                entry["_codec_family"] = family
                video_by_key[key] = entry
            continue

        # Audio-only adaptive.
        if vcodec == "none" and acodec != "none":
            if not _is_mp4_audio_codec(acodec):
                continue
            score = 0
            abr = fmt.get("abr") or fmt.get("tbr") or 0
            try:
                score += int(float(abr))
            except (TypeError, ValueError):
                pass
            # Prefer higher sample rate / channels as a tie-break.
            try:
                score += int(fmt.get("asr") or 0) // 100
            except (TypeError, ValueError):
                pass
            format_id = str(fmt.get("format_id") or "")
            # Prefer non-DRC variants (YouTube exposes "-drc" format IDs).
            if "-drc" in format_id.lower() or "drc" in str(
                fmt.get("format_note") or ""
            ).lower():
                score -= 50_000
            lang = str(fmt.get("language") or fmt.get("lang") or "").lower()
            if original_lang and lang == original_lang:
                score += 20_000
            elif lang in ("", "und", "en") and not original_lang:
                score += 5_000
            elif lang and original_lang and lang != original_lang:
                score -= 10_000
            audio_candidates.append((score, fmt))

    videos = sorted(
        video_by_key.values(),
        key=lambda f: (
            0 if f.get("_codec_family") == "av01" else 1,
            -int(f.get("height") or 0),
        ),
    )
    for v in videos:
        v.pop("_score", None)

    audios: list[dict[str, Any]] = []
    if audio_candidates:
        audio_candidates.sort(key=lambda item: item[0], reverse=True)
        audios.append(audio_candidates[0][1])

    return videos, audios


def _format_http_headers(fmt: dict[str, Any], info: dict[str, Any]) -> dict[str, str]:
    headers = dict(fmt.get("http_headers") or {})
    cookie = fmt.get("cookies") or info.get("cookies")
    if cookie and "Cookie" not in headers:
        headers["Cookie"] = cookie
    return {str(k): str(v) for k, v in headers.items()}


def _walk_mp4_boxes(
    data: bytes, start: int = 0, end: Optional[int] = None
) -> list[tuple[int, bytes, int]]:
    """Return top-level (offset, type, size) boxes in [start, end)."""
    if end is None:
        end = len(data)
    boxes: list[tuple[int, bytes, int]] = []
    pos = start
    while pos + 8 <= end:
        size = int.from_bytes(data[pos : pos + 4], "big")
        typ = data[pos + 4 : pos + 8]
        header = 8
        if size == 1:
            if pos + 16 > end:
                break
            size = int.from_bytes(data[pos + 8 : pos + 16], "big")
            header = 16
        elif size == 0:
            size = end - pos
        if size < header:
            break
        if pos + size > end:
            # Incomplete box in buffer — still record start for sidx detection.
            boxes.append((pos, typ, size))
            break
        boxes.append((pos, typ, size))
        pos += size
    return boxes


def _find_sidx_range(data: bytes) -> Optional[tuple[int, int]]:
    """Locate the first complete top-level sidx box; return (start, end_inclusive)."""
    for offset, typ, size in _walk_mp4_boxes(data):
        if typ == b"sidx":
            end = offset + size - 1
            if end < len(data):
                return offset, end
            return None
    return None


def _parse_sidx(data: bytes, offset: int) -> dict[str, Any]:
    """Parse an ISO-BMFF sidx box at absolute byte offset.

    Returns timescale, earliest_presentation_time, first_offset, duration_sec,
    and cumulative subsegment boundary times (seconds).
    """
    if offset + 12 > len(data):
        raise RuntimeError("sidx box truncated")
    size = int.from_bytes(data[offset : offset + 4], "big")
    typ = data[offset + 4 : offset + 8]
    if typ != b"sidx":
        raise RuntimeError("Not a sidx box")
    header = 8
    if size == 1:
        if offset + 16 > len(data):
            raise RuntimeError("sidx largesize truncated")
        size = int.from_bytes(data[offset + 8 : offset + 16], "big")
        header = 16
    elif size == 0:
        size = len(data) - offset
    box_end = offset + size
    if box_end > len(data):
        raise RuntimeError("sidx box incomplete in buffer")

    body = offset + header
    version = data[body]
    # skip flags (3 bytes)
    pos = body + 4
    # reference_ID
    pos += 4
    timescale = int.from_bytes(data[pos : pos + 4], "big")
    pos += 4
    if version == 0:
        ept = int.from_bytes(data[pos : pos + 4], "big")
        pos += 4
        first_offset = int.from_bytes(data[pos : pos + 4], "big")
        pos += 4
    else:
        ept = int.from_bytes(data[pos : pos + 8], "big")
        pos += 8
        first_offset = int.from_bytes(data[pos : pos + 8], "big")
        pos += 8
    # reserved (2) + reference_count (2)
    pos += 2
    ref_count = int.from_bytes(data[pos : pos + 2], "big")
    pos += 2

    total_duration = 0
    boundaries: list[float] = [0.0]
    for _ in range(ref_count):
        if pos + 12 > box_end:
            break
        # referenced_size in low 31 bits of first uint32; bit 31 = reference_type
        pos += 4
        subseg_dur = int.from_bytes(data[pos : pos + 4], "big")
        pos += 4
        # starts_with_SAP / SAP_type / SAP_delta_time
        pos += 4
        total_duration += subseg_dur
        if timescale > 0:
            boundaries.append(total_duration / timescale)

    duration_sec = (total_duration / timescale) if timescale > 0 else 0.0
    return {
        "timescale": timescale,
        "earliest_presentation_time": ept,
        "first_offset": first_offset,
        "duration_sec": duration_sec,
        "boundaries": boundaries,
    }


def _probe_mp4_ranges(
    direct_url: str, headers: dict[str, str]
) -> tuple[str, str, dict[str, Any]]:
    """Probe ISO-BMFF to compute initRange, indexRange, and parsed sidx.

    Returns (init_range, index_range, sidx_info).
    """
    req_headers = dict(headers)
    last_err: Optional[Exception] = None
    for nbytes in _PREVIEW_PROBE_SIZES:
        req_headers["Range"] = f"bytes=0-{nbytes - 1}"
        try:
            with httpx.Client(
                timeout=httpx.Timeout(20.0, read=60.0),
                follow_redirects=True,
            ) as client:
                resp = client.get(direct_url, headers=req_headers)
            if resp.status_code not in (200, 206):
                raise RuntimeError(
                    f"Probe failed with status {resp.status_code}"
                )
            data = resp.content
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue

        sidx = _find_sidx_range(data)
        if sidx is None:
            # Need a larger window, or no sidx present.
            if len(data) < nbytes:
                break
            continue

        sidx_start, sidx_end = sidx
        if sidx_start <= 0:
            raise RuntimeError("Invalid sidx offset in MP4 probe")
        init_range = f"0-{sidx_start - 1}"
        index_range = f"{sidx_start}-{sidx_end}"
        parsed = _parse_sidx(data, sidx_start)
        return init_range, index_range, parsed

    if last_err is not None:
        raise RuntimeError(f"MP4 range probe failed: {last_err}") from last_err
    raise RuntimeError("MP4 stream has no sidx index (cannot build DASH)")


def _bandwidth_bps(fmt: dict[str, Any], *, kind: str) -> int:
    """Approximate peak bitrate for DASH @bandwidth (yt-dlp tbr is average)."""
    avg = 0
    for key in ("tbr", "vbr", "abr"):
        val = fmt.get(key)
        if val is None:
            continue
        try:
            # yt-dlp tbr is kbps.
            avg = max(1, int(float(val) * 1000))
            break
        except (TypeError, ValueError):
            continue
    if avg <= 0:
        filesize = fmt.get("filesize") or fmt.get("filesize_approx")
        duration = fmt.get("duration")  # rarely on format
        if filesize and duration:
            try:
                avg = max(1, int(int(filesize) * 8 / float(duration)))
            except (TypeError, ValueError, ZeroDivisionError):
                pass
    if avg <= 0:
        avg = 1_000_000 if kind == "video" else 128_000
    pad = 1.4 if kind == "video" else 1.1
    return max(1, int(avg * pad))


def _codecs_string(fmt: dict[str, Any], *, kind: str) -> str:
    if kind == "video":
        return str(fmt.get("vcodec") or "avc1.4D401F")
    return str(fmt.get("acodec") or "mp4a.40.2")


def _build_representation(
    fmt: dict[str, Any],
    info: dict[str, Any],
    *,
    kind: str,
) -> dict[str, Any]:
    direct = str(fmt.get("url") or "")
    if not direct:
        raise RuntimeError("Adaptive format has no URL")
    headers = _format_http_headers(fmt, info)
    init_range, index_range, sidx = _probe_mp4_ranges(direct, headers)
    itag = str(fmt.get("format_id") or fmt.get("format") or "")
    if not itag:
        raise RuntimeError("Adaptive format missing format_id")

    mime = "video/mp4" if kind == "video" else "audio/mp4"
    codecs = _codecs_string(fmt, kind=kind)
    family = (
        fmt.get("_codec_family")
        or _video_codec_family(codecs)
        or "unknown"
    )
    rep: dict[str, Any] = {
        "itag": itag,
        "kind": kind,
        "direct_url": direct,
        "http_headers": headers,
        "content_type": mime,
        "mime_type": mime,
        "codecs": codecs,
        "codec_family": family if kind == "video" else "audio",
        "bandwidth": _bandwidth_bps(fmt, kind=kind),
        "init_range": init_range,
        "index_range": index_range,
        "timescale": int(sidx["timescale"]),
        "earliest_presentation_time": int(sidx["earliest_presentation_time"]),
        "duration_sec": float(sidx["duration_sec"]),
        "boundaries": list(sidx["boundaries"]),
    }
    if kind == "video":
        rep["width"] = int(fmt.get("width") or 0) or None
        rep["height"] = int(fmt.get("height") or 0) or None
        fps = fmt.get("fps")
        try:
            rep["fps"] = int(float(fps)) if fps is not None else None
        except (TypeError, ValueError):
            rep["fps"] = None
    else:
        channels = fmt.get("audio_channels") or 2
        try:
            rep["audio_channels"] = int(channels)
        except (TypeError, ValueError):
            rep["audio_channels"] = 2
        asr = fmt.get("asr")
        try:
            rep["audio_sampling_rate"] = int(asr) if asr else None
        except (TypeError, ValueError):
            rep["audio_sampling_rate"] = None
        lang = fmt.get("language") or fmt.get("lang") or info.get("language")
        rep["lang"] = str(lang) if lang else "und"
    return rep


def _extract_preview_info(url: str, *, force: bool = False) -> dict[str, Any]:
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "logger": QuietYtdlpLogger(),
            "extractor_args": youtube_extractor_args(),
        }
    )
    # Share cache with download-preview when possible (same URL, full extract).
    try:
        info = _as_info(
            extract_info_gated(
                url, opts, cache_key=f"stream:{url}", force=force
            )
        )
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
    if info.get("_type") == "playlist" or (
        info.get("entries") is not None and not info.get("formats")
    ):
        raise ValueError("Playlists cannot be preview-streamed")
    return info


def _subtitle_entry_vtt_url(entries: list[Any]) -> Optional[str]:
    """Pick a VTT URL from a yt-dlp subtitle format list for one language."""
    import urllib.parse

    if not isinstance(entries, list):
        return None
    chosen: Optional[dict[str, Any]] = None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not url:
            continue
        if str(entry.get("ext") or "").lower() == "vtt":
            return str(url)
        if chosen is None:
            chosen = entry
    if chosen is None:
        return None
    url = str(chosen["url"])
    if str(chosen.get("ext") or "").lower() == "vtt":
        return url
    # YouTube timedtext honors fmt=vtt even when yt-dlp listed json3/srv3/etc.
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    query["fmt"] = ["vtt"]
    return urllib.parse.urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path,
            urllib.parse.urlencode(query, doseq=True),
            parts.fragment,
        )
    )


def _normalize_lang(lang: str) -> str:
    """Collapse ``en-US`` / ``en-orig`` style codes to a base language tag."""
    return lang.split("-")[0].lower()


def _collect_preview_subtitles(info: dict[str, Any]) -> list[dict[str, Any]]:
    """English caption tracks from yt-dlp info; manual wins over auto."""
    by_lang: dict[str, dict[str, Any]] = {}
    for source_key, is_auto in (("subtitles", False), ("automatic_captions", True)):
        bucket = info.get(source_key) or {}
        if not isinstance(bucket, dict):
            continue
        for raw_lang, entries in bucket.items():
            lang = _normalize_lang(str(raw_lang or ""))
            if lang != "en":
                continue
            # Manual is walked first; skip once a lang is claimed.
            if lang in by_lang:
                continue
            url = _subtitle_entry_vtt_url(entries)
            if not url:
                continue
            by_lang[lang] = {"lang": lang, "auto": is_auto, "url": url}
    return list(by_lang.values())


def list_preview_subtitles(url: str, *, force: bool = False) -> list[dict[str, Any]]:
    """Return [{lang, auto}] for English captions available on a stream URL."""
    info = _extract_preview_info(url, force=force)
    return [
        {"lang": t["lang"], "auto": t["auto"]}
        for t in _collect_preview_subtitles(info)
    ]


def resolve_preview_subtitle(
    url: str, lang: str, *, force: bool = False
) -> dict[str, Any]:
    """Resolve a proxied caption track: {direct_url, http_headers, lang, auto}."""
    wanted = _normalize_lang(lang)
    info = _extract_preview_info(url, force=force)
    track = next(
        (t for t in _collect_preview_subtitles(info) if t["lang"] == wanted),
        None,
    )
    if track is None:
        raise KeyError(f"No subtitle track for language {lang!r}")
    headers = dict(info.get("http_headers") or {})
    return {
        "direct_url": track["url"],
        "http_headers": {str(k): str(v) for k, v in headers.items()},
        "lang": track["lang"],
        "auto": track["auto"],
    }


def _max_adaptive_height(info: dict[str, Any]) -> Optional[int]:
    videos, _ = _pick_adaptive_formats(info)
    if not videos:
        return None
    heights = [int(v.get("height") or 0) for v in videos if v.get("height")]
    return max(heights) if heights else None


def _boundaries_aligned(
    reps: list[dict[str, Any]], *, tolerance_sec: float = 1.0 / 30.0
) -> bool:
    """True when all representations share subsegment boundaries within tol."""
    if len(reps) < 2:
        return True
    ref = reps[0].get("boundaries") or []
    if len(ref) < 2:
        return False
    for other in reps[1:]:
        bounds = other.get("boundaries") or []
        if len(bounds) != len(ref):
            return False
        for a, b in zip(ref, bounds):
            if abs(float(a) - float(b)) > tolerance_sec:
                return False
    return True


def _segment_base_xml(rep: dict[str, Any]) -> list[str]:
    init_r = xml_escape(str(rep["init_range"]))
    index_r = xml_escape(str(rep["index_range"]))
    attrs = [f'indexRange="{index_r}"', 'indexRangeExact="true"']
    timescale = int(rep.get("timescale") or 0)
    ept = int(rep.get("earliest_presentation_time") or 0)
    if timescale > 0 and ept > 0:
        attrs.append(f'timescale="{timescale}"')
        attrs.append(f'presentationTimeOffset="{ept}"')
    return [
        f'<SegmentBase {" ".join(attrs)}>',
        f'<Initialization range="{init_r}"/>',
        "</SegmentBase>",
    ]


def extract_stream_preview_meta(url: str) -> dict[str, Any]:
    """Metadata for the in-app preview page (includes description for chapters)."""
    info = _extract_preview_info(url)
    preview_height = _max_adaptive_height(info)
    if preview_height is None:
        fmt = _pick_progressive_format(info)
        preview_height = int(fmt["height"]) if fmt and fmt.get("height") else None
    view_count = info.get("view_count")
    if view_count is not None:
        try:
            view_count = int(view_count)
        except (TypeError, ValueError):
            view_count = None
    duration = info.get("duration")
    if duration is not None:
        try:
            duration = float(duration)
        except (TypeError, ValueError):
            duration = None
    source = (
        info.get("webpage_url")
        or info.get("original_url")
        or url
    )
    subtitles = [
        {"lang": t["lang"], "auto": t["auto"]}
        for t in _collect_preview_subtitles(info)
    ]
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("uploader_url") or info.get("channel_url"),
        "thumbnail_url": _best_thumbnail_url(info, info.get("id")),
        "description": info.get("description"),
        "duration": duration,
        "view_count": view_count,
        "source_url": source,
        "preview_height": preview_height,
        "available_presets": _available_presets(info),
        "subtitles": subtitles,
    }


def resolve_preview_stream(url: str) -> dict[str, Any]:
    """Resolve a short-lived progressive media URL for proxy streaming.

    Returns dict with direct_url, http_headers, height, content_type, expires_at.
    Kept as a fallback for clients that cannot play DASH.
    """
    now = time.time()
    with _preview_stream_lock:
        cached = _preview_stream_cache.get(url)
        if cached and cached.get("expires_at", 0) > now + 15:
            return dict(cached)

    with _preview_extract_sem:
        # Re-check cache after waiting for the semaphore.
        with _preview_stream_lock:
            cached = _preview_stream_cache.get(url)
            if cached and cached.get("expires_at", 0) > now + 15:
                return dict(cached)

        info = _extract_preview_info(url)
        fmt = _pick_progressive_format(info)
        if fmt is None:
            raise RuntimeError(
                "No progressive preview format available for this video"
            )
        direct = fmt.get("url")
        if not direct:
            raise RuntimeError("Preview format has no URL")

        headers = _format_http_headers(fmt, info)
        ext = str(fmt.get("ext") or "mp4")
        content_type = {
            "mp4": "video/mp4",
            "webm": "video/webm",
            "mkv": "video/x-matroska",
        }.get(ext, "video/mp4")

        entry = {
            "direct_url": str(direct),
            "http_headers": headers,
            "height": int(fmt["height"]) if fmt.get("height") else None,
            "content_type": content_type,
            "expires_at": now + _PREVIEW_CACHE_TTL_SEC,
        }
        with _preview_stream_lock:
            _preview_stream_cache[url] = entry
            # Bound cache size.
            if len(_preview_stream_cache) > 64:
                oldest = sorted(
                    _preview_stream_cache.items(),
                    key=lambda item: item[1].get("expires_at", 0),
                )[:16]
                for key, _ in oldest:
                    _preview_stream_cache.pop(key, None)
        return dict(entry)


def _trim_manifest_cache_locked() -> None:
    if len(_preview_manifest_by_url) <= 48:
        return
    oldest = sorted(
        _preview_manifest_by_url.items(),
        key=lambda item: item[1].get("expires_at", 0),
    )[:16]
    for key, entry in oldest:
        _preview_manifest_by_url.pop(key, None)
        token = entry.get("token")
        if token:
            _preview_manifest_by_token.pop(str(token), None)


def _store_manifest_entry(url: str, entry: dict[str, Any]) -> None:
    with _preview_stream_lock:
        old = _preview_manifest_by_url.get(url)
        if old and old.get("token") and old["token"] != entry.get("token"):
            _preview_manifest_by_token.pop(str(old["token"]), None)
        _preview_manifest_by_url[url] = entry
        _preview_manifest_by_token[str(entry["token"])] = entry
        _trim_manifest_cache_locked()


def _build_manifest_entry(url: str, info: dict[str, Any]) -> dict[str, Any]:
    videos, audios = _pick_adaptive_formats(info)
    if not videos or not audios:
        raise RuntimeError(
            "No MP4 adaptive formats available for DASH preview"
        )

    # Probe representations concurrently; extract semaphore already released.
    jobs: list[tuple[str, dict[str, Any]]] = [
        ("video", fmt) for fmt in videos
    ] + [("audio", fmt) for fmt in audios]
    reps: dict[str, dict[str, Any]] = {}
    errors: list[Exception] = []

    def _probe_one(kind: str, fmt: dict[str, Any]) -> dict[str, Any]:
        return _build_representation(fmt, info, kind=kind)

    workers = min(6, max(1, len(jobs)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_probe_one, kind, fmt): (kind, fmt)
            for kind, fmt in jobs
        }
        for fut in as_completed(futures):
            try:
                rep = fut.result()
                reps[rep["itag"]] = rep
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
                logger.warning("Preview probe failed: %s", exc)

    video_reps = [r for r in reps.values() if r.get("kind") == "video"]
    audio_reps = [r for r in reps.values() if r.get("kind") == "audio"]
    if not video_reps or not audio_reps:
        detail = f": {errors[0]}" if errors else ""
        raise RuntimeError(
            f"No MP4 adaptive formats available for DASH preview{detail}"
        )

    # Prefer exact sidx-derived duration over yt-dlp's rounded seconds.
    sidx_durs = [
        float(r["duration_sec"])
        for r in reps.values()
        if r.get("duration_sec")
    ]
    duration_f = max(sidx_durs) if sidx_durs else None
    if duration_f is None:
        duration = info.get("duration")
        try:
            duration_f = float(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration_f = None

    heights = [
        int(r["height"])
        for r in video_reps
        if r.get("height")
    ]
    max_height = max(heights) if heights else None

    return {
        "token": secrets.token_urlsafe(18),
        "source_url": url,
        "duration": duration_f,
        "max_height": max_height,
        "formats": reps,
        "expires_at": time.time() + _PREVIEW_MANIFEST_TTL_SEC,
    }


def _do_resolve_preview_manifest(
    url: str, *, force: bool = False
) -> dict[str, Any]:
    """Internal resolve without single-flight wrapping."""
    now = time.time()
    if not force:
        with _preview_stream_lock:
            cached = _preview_manifest_by_url.get(url)
            if cached and cached.get("expires_at", 0) > now + 60:
                return dict(cached)

    # Hold extract semaphore only for yt-dlp; probe concurrently afterwards.
    with _preview_extract_sem:
        if not force:
            with _preview_stream_lock:
                cached = _preview_manifest_by_url.get(url)
                if cached and cached.get("expires_at", 0) > now + 60:
                    return dict(cached)
        info = _extract_preview_info(url, force=force)

    existing_token: Optional[str] = None
    with _preview_stream_lock:
        prev = _preview_manifest_by_url.get(url)
        if prev:
            existing_token = str(prev.get("token") or "") or None

    entry = _build_manifest_entry(url, info)
    if existing_token and force:
        entry["token"] = existing_token
    _store_manifest_entry(url, entry)
    return dict(entry)


def resolve_preview_manifest(url: str, *, force: bool = False) -> dict[str, Any]:
    """Resolve adaptive formats and return a cached manifest session.

    Concurrent force refreshes for the same URL collapse into one extraction
    (single-flight) with a short debounce so 403 storms do not queue N extracts.
    """
    if not force:
        return _do_resolve_preview_manifest(url, force=False)

    now = time.time()
    with _preview_stream_lock:
        last = _preview_refresh_last_at.get(url, 0.0)
        if now - last < _PREVIEW_REFRESH_DEBOUNCE_SEC:
            cached = _preview_manifest_by_url.get(url)
            if cached:
                return dict(cached)
        inflight = _preview_refresh_inflight.get(url)
        if inflight is None:
            inflight = threading.Event()
            _preview_refresh_inflight[url] = inflight
            leader = True
        else:
            leader = False

    if not leader:
        # Wait for the in-flight refresh; fall back to cache or raise.
        inflight.wait(timeout=120)
        with _preview_stream_lock:
            cached = _preview_manifest_by_url.get(url)
        if cached:
            return dict(cached)
        raise PreviewRefreshError(
            "Preview media refresh in progress failed",
            retry_after=15,
        )

    try:
        entry = _do_resolve_preview_manifest(url, force=True)
        with _preview_stream_lock:
            _preview_refresh_last_at[url] = time.time()
            _preview_refresh_attempts[url] = 0
        return entry
    except Exception as exc:  # noqa: BLE001
        with _preview_stream_lock:
            attempts = _preview_refresh_attempts.get(url, 0) + 1
            _preview_refresh_attempts[url] = attempts
        logger.warning("Preview manifest refresh failed for %s: %s", url, exc)
        if isinstance(exc, PreviewRefreshError):
            raise
        raise PreviewRefreshError(
            f"Could not refresh preview media: {exc}",
            retry_after=15,
        ) from exc
    finally:
        with _preview_stream_lock:
            done = _preview_refresh_inflight.pop(url, None)
        if done is not None:
            done.set()


def build_dash_manifest(session: dict[str, Any]) -> str:
    """Build a SegmentBase DASH MPD with proxied BaseURLs.

    Video representations are emitted in one AdaptationSet per codec family
    so ABR never crosses a codec boundary mid-playback.
    """
    token = str(session["token"])
    duration = session.get("duration")
    try:
        dur = float(duration) if duration is not None else 0.0
    except (TypeError, ValueError):
        dur = 0.0
    media_duration = f"PT{max(dur, 0.1):.3f}S"

    formats: dict[str, dict[str, Any]] = session.get("formats") or {}
    videos = [r for r in formats.values() if r.get("kind") == "video"]
    audios = [r for r in formats.values() if r.get("kind") == "audio"]

    # Group by codec family (av01 / avc1).
    by_family: dict[str, list[dict[str, Any]]] = {}
    for rep in videos:
        family = str(rep.get("codec_family") or "avc1")
        by_family.setdefault(family, []).append(rep)
    # Prefer listing AV1 first so Shaka's preferredVideoCodecs can pick it.
    family_order = sorted(
        by_family.keys(),
        key=lambda f: (0 if f == "av01" else 1, f),
    )

    lines: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" '
            'profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" '
            'type="static" '
            f'mediaPresentationDuration="{media_duration}" '
            'minBufferTime="PT1.5S">'
        ),
        "<Period>",
    ]

    set_id = 0
    for family in family_order:
        family_reps = by_family[family]
        family_reps.sort(
            key=lambda r: int(r.get("height") or 0), reverse=True
        )
        aligned = _boundaries_aligned(family_reps)
        widths = [int(r.get("width") or 0) for r in family_reps]
        heights = [int(r.get("height") or 0) for r in family_reps]
        fps_vals = [int(r["fps"]) for r in family_reps if r.get("fps")]
        align_attrs = ""
        if aligned:
            align_attrs = (
                ' segmentAlignment="true" subsegmentAlignment="true"'
            )
        max_w = max(widths) if widths else 0
        max_h = max(heights) if heights else 0
        max_fps = max(fps_vals) if fps_vals else 0
        extra = ""
        if max_w > 0:
            extra += f' maxWidth="{max_w}"'
        if max_h > 0:
            extra += f' maxHeight="{max_h}"'
        if max_fps > 0:
            extra += f' maxFrameRate="{max_fps}"'
        lines.append(
            f'<AdaptationSet id="{set_id}" contentType="video" '
            f'mimeType="video/mp4" startWithSAP="1" '
            f'subsegmentStartsWithSAP="1"{align_attrs}{extra}>'
        )
        lines.append(
            '<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>'
        )
        for rep in family_reps:
            itag = xml_escape(str(rep["itag"]))
            codecs = xml_escape(str(rep.get("codecs") or "avc1.4D401F"))
            bandwidth = int(rep.get("bandwidth") or 1_000_000)
            width = int(rep.get("width") or 0)
            height = int(rep.get("height") or 0)
            fps = rep.get("fps")
            attrs = [
                f'id="{itag}"',
                f'bandwidth="{bandwidth}"',
                f'codecs="{codecs}"',
            ]
            if width > 0:
                attrs.append(f'width="{width}"')
            if height > 0:
                attrs.append(f'height="{height}"')
            if fps:
                attrs.append(f'frameRate="{int(fps)}"')
            base = (
                f"/api/preview/media?token={xml_escape(token)}"
                f"&amp;itag={itag}"
            )
            lines.append(f"<Representation {' '.join(attrs)}>")
            lines.append(f"<BaseURL>{base}</BaseURL>")
            lines.extend(_segment_base_xml(rep))
            lines.append("</Representation>")
        lines.append("</AdaptationSet>")
        set_id += 1

    if audios:
        aligned_a = _boundaries_aligned(audios)
        align_attrs = ""
        if aligned_a:
            align_attrs = (
                ' segmentAlignment="true" subsegmentAlignment="true"'
            )
        lang = xml_escape(str(audios[0].get("lang") or "und"))
        lines.append(
            f'<AdaptationSet id="{set_id}" contentType="audio" '
            f'mimeType="audio/mp4" startWithSAP="1" '
            f'subsegmentStartsWithSAP="1"{align_attrs} lang="{lang}">'
        )
        for rep in audios:
            itag = xml_escape(str(rep["itag"]))
            codecs = xml_escape(str(rep.get("codecs") or "mp4a.40.2"))
            bandwidth = int(rep.get("bandwidth") or 128_000)
            channels = int(rep.get("audio_channels") or 2)
            base = (
                f"/api/preview/media?token={xml_escape(token)}"
                f"&amp;itag={itag}"
            )
            lines.append(
                f'<Representation id="{itag}" bandwidth="{bandwidth}" '
                f'codecs="{codecs}">'
            )
            lines.append(
                '<AudioChannelConfiguration '
                'schemeIdUri="urn:mpeg:dash:23003:3:'
                'audio_channel_configuration:2011" '
                f'value="{channels}"/>'
            )
            lines.append(f"<BaseURL>{base}</BaseURL>")
            lines.extend(_segment_base_xml(rep))
            lines.append("</Representation>")
        lines.append("</AdaptationSet>")

    lines.append("</Period>")
    lines.append("</MPD>")
    return "\n".join(lines)


def lookup_preview_media(
    token: str, itag: str, *, refresh: bool = False
) -> dict[str, Any]:
    """Look up a cached adaptive format for the media proxy.

    On refresh=True (e.g. upstream 403), re-resolve URLs keeping the same token.
    Also refreshes proactively when the session is near expiry.
    """
    with _preview_stream_lock:
        session = _preview_manifest_by_token.get(token)
        attempts = _preview_refresh_attempts.get(
            str(session.get("source_url") or "") if session else "", 0
        )

    if session is None:
        raise KeyError("Unknown or expired preview media token")

    source_url = str(session.get("source_url") or "")
    now = time.time()
    expires_at = float(session.get("expires_at") or 0)
    near_expiry = expires_at > 0 and expires_at - now < _PREVIEW_REFRESH_PROACTIVE_SEC
    need_refresh = refresh or near_expiry

    if need_refresh:
        if not source_url:
            raise RuntimeError("Cannot refresh preview media: missing source URL")
        if attempts >= _PREVIEW_REFRESH_MAX_ATTEMPTS and refresh:
            raise PreviewRefreshError(
                "Preview media refresh attempts exhausted",
                retry_after=30,
            )
        try:
            session = resolve_preview_manifest(source_url, force=True)
            # Ensure token index still points at the refreshed entry.
            with _preview_stream_lock:
                session["token"] = token
                _preview_manifest_by_token[token] = session
                _preview_manifest_by_url[source_url] = session
        except Exception as exc:  # noqa: BLE001
            # Explicit 403 refresh must surface; proactive refresh can keep
            # serving the existing CDN URLs until they actually fail.
            if refresh:
                if isinstance(exc, PreviewRefreshError):
                    raise
                raise PreviewRefreshError(
                    f"Could not refresh preview media: {exc}",
                    retry_after=15,
                ) from exc
            logger.warning(
                "Proactive preview refresh failed; using cached URLs: %s", exc
            )

    formats: dict[str, dict[str, Any]] = session.get("formats") or {}
    fmt = formats.get(itag)
    if fmt is None:
        raise KeyError(f"Unknown itag {itag} for preview token")

    return {
        "direct_url": str(fmt["direct_url"]),
        "http_headers": dict(fmt.get("http_headers") or {}),
        "content_type": str(fmt.get("content_type") or "video/mp4"),
        "source_url": source_url,
    }

"""Suggest a title, channel and source for a file waiting in the import queue.

Existing archives arrive with their metadata already on disk: yt-dlp's
``.info.json`` beside the video, a Kodi/Jellyfin ``.nfo``, or a
``Channel/Year/Title [id].ext`` layout. Nothing here writes to the database: the
review list shows the suggestion, and approving applies it.
"""

from __future__ import annotations

import json
import logging
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session

from ..context import get_paths
from ..models import Video
from ..schemas import ImportSuggestion
from . import library
from .thumbnails import save_from_url
from .youtube_id import derive_youtube_id

logger = logging.getLogger(__name__)

# Sidecars are untrusted files on a share; a real one is a few hundred KB.
_MAX_SIDECAR_BYTES = 5 * 1024 * 1024
_MAX_TAGS = 30
_ID_TOKEN_RE = re.compile(r"\s*\[[A-Za-z0-9_-]{11}\]\s*")
_YEAR_RE = re.compile(r"^(19|20)\d\d$")
# Tube Archivist's fixed layout: <channel id>/<video id>.<ext>, no brackets.
_TA_CHANNEL_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
_BARE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
# Folders that hold imports but do not name a channel.
_NOT_A_CHANNEL = {"imports"}


def youtube_watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def youtube_thumbnail_url(video_id: str) -> str:
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def _clean(value: Any, limit: int = 500) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text[:limit] or None


def _read_sidecar(path: Path) -> bytes | None:
    try:
        if not path.is_file() or path.stat().st_size > _MAX_SIDECAR_BYTES:
            return None
        return path.read_bytes()
    except OSError:
        logger.debug("could not read import sidecar %s", path, exc_info=True)
        return None


def _parse_date(value: Any) -> datetime | None:
    if isinstance(value, (int, float)) and value > 0:
        try:
            return datetime.fromtimestamp(float(value), UTC)
        except OverflowError, OSError, ValueError:
            return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    for fmt, width in (("%Y%m%d", 8), ("%Y-%m-%d", 10)):
        try:
            return datetime.strptime(text[:width], fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


def _from_info_json(media: Path) -> dict[str, Any]:
    raw = _read_sidecar(media.with_suffix(".info.json"))
    if raw is None:
        return {}
    try:
        info = json.loads(raw)
    except ValueError:
        logger.debug("ignoring unreadable %s", media.with_suffix(".info.json"))
        return {}
    if not isinstance(info, dict):
        return {}
    out: dict[str, Any] = {
        "title": _clean(info.get("title")),
        "channel": _clean(info.get("channel") or info.get("uploader"), 200),
        "channel_url": _clean(info.get("channel_url") or info.get("uploader_url")),
        "description": info.get("description")
        if isinstance(info.get("description"), str)
        else None,
        "published_at": _parse_date(info.get("upload_date"))
        or _parse_date(info.get("timestamp")),
        "tags": [t for t in (_clean(x, 100) for x in info.get("tags") or []) if t][
            :_MAX_TAGS
        ]
        if isinstance(info.get("tags"), list)
        else [],
        "thumbnail_url": _clean(info.get("thumbnail")),
    }
    extractor = str(info.get("extractor_key") or info.get("extractor") or "").lower()
    vid = info.get("id")
    if extractor.startswith("youtube") and isinstance(vid, str) and len(vid) == 11:
        out["youtube_id"] = vid
    else:
        out["source_url"] = _clean(info.get("webpage_url"))
    return {k: v for k, v in out.items() if v}


def _from_nfo(media: Path) -> dict[str, Any]:
    raw = _read_sidecar(media.with_suffix(".nfo"))
    if raw is None:
        return {}
    try:
        # Expat (bundled with Python 3.14) rejects external entities and caps
        # entity expansion; the size cap above bounds the rest.
        root = ET.fromstring(raw)  # noqa: S314 - size-capped local sidecar, see above
    except ET.ParseError:
        logger.debug("ignoring unreadable %s", media.with_suffix(".nfo"))
        return {}

    def text(tag: str) -> str | None:
        node = root.find(tag)
        return _clean(node.text) if node is not None else None

    out: dict[str, Any] = {
        "title": text("title"),
        "channel": text("showtitle") or text("studio"),
        "published_at": _parse_date(text("aired") or text("premiered")),
        "tags": [t for t in (_clean(n.text, 100) for n in root.findall("tag")) if t][
            :_MAX_TAGS
        ],
    }
    plot = root.find("plot")
    if plot is not None and plot.text:
        out["description"] = plot.text.strip()
    for node in root.findall("uniqueid"):
        value = _clean(node.text, 20)
        if node.get("type") == "youtube" and value and len(value) == 11:
            out["youtube_id"] = value
    return {k: v for k, v in out.items() if v}


def _from_path(rel_path: str) -> dict[str, Any]:
    rel = Path(rel_path.replace("\\", "/"))
    out: dict[str, Any] = {}
    title = _ID_TOKEN_RE.sub(" ", rel.stem).strip(" -_")
    if title:
        out["title"] = " ".join(title.split())
    found = derive_youtube_id(None, rel_path)
    if (
        not found
        and len(rel.parts) >= 2
        and _TA_CHANNEL_RE.match(rel.parts[-2])
        and _BARE_ID_RE.match(rel.stem)
    ):
        found = rel.stem
        out.pop("title", None)  # the id is not a title
    if found:
        out["youtube_id"] = found
    # A top folder names the channel only in a recognisable layout: a year folder
    # under it (Channel/2024/...) or a yt-dlp [id] in the name. "inbox/x.mp4" or
    # "Downloads/x.mp4" says nothing about who made the video.
    parts = rel.parts[:-1]
    laid_out = len(parts) >= 2 and _YEAR_RE.match(parts[1]) is not None
    if (
        parts
        and (laid_out or found)
        and parts[0].lower() not in _NOT_A_CHANNEL
        and not _YEAR_RE.match(parts[0])
        and not _TA_CHANNEL_RE.match(parts[0])
    ):
        out["channel"] = parts[0]
    return out


def _merge(*layers: tuple[str, dict[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    """First non-empty value per field wins; return the merged fields and sources."""
    merged: dict[str, Any] = {}
    used: list[str] = []
    for name, layer in layers:
        took = False
        for key, value in layer.items():
            if key not in merged:
                merged[key] = value
                took = True
        if took:
            used.append(name)
    return merged, used


def _blank_only(
    video: Video, fields: dict[str, Any], sources: list[str]
) -> ImportSuggestion:
    """Keep the fields the video does not have yet. The scanner's title is the
    file name, so a better title replaces it."""
    youtube_id = fields.pop("youtube_id", None) or video.youtube_id
    if youtube_id:
        fields.setdefault("source_url", youtube_watch_url(youtube_id))
        fields.setdefault("thumbnail_url", youtube_thumbnail_url(youtube_id))
    stem = Path(video.file_path).stem
    suggestion = ImportSuggestion(sources=sources)
    title = fields.get("title")
    if title and video.title in ("", stem) and title != video.title:
        suggestion.title = title
    if not video.channel:
        suggestion.channel = fields.get("channel")
    if not video.channel_url:
        suggestion.channel_url = fields.get("channel_url")
    if not video.description:
        suggestion.description = fields.get("description")
    if video.published_at is None:
        suggestion.published_at = fields.get("published_at")
    if not video.source_url:
        suggestion.source_url = fields.get("source_url")
    if video.tags in ("", "[]"):
        suggestion.tags = fields.get("tags") or []
    suggestion.thumbnail_url = fields.get("thumbnail_url")
    return suggestion


def suggest(video: Video) -> ImportSuggestion | None:
    """What the files on disk say about ``video``; None when they say nothing new."""
    media = get_paths().downloads / video.file_path
    fields, sources = _merge(
        ("info_json", _from_info_json(media)),
        ("nfo", _from_nfo(media)),
        ("path", _from_path(video.file_path)),
    )
    suggestion = _blank_only(video, fields, sources)
    return None if suggestion.is_empty() else suggestion


def from_source_info(info: dict[str, Any]) -> ImportSuggestion | None:
    """A suggestion from a yt-dlp extract of the video's source (a YouTube lookup)."""
    fields: dict[str, Any] = {
        "title": _clean(info.get("title")),
        "channel": _clean(info.get("channel") or info.get("uploader"), 200),
        "channel_url": _clean(info.get("channel_url") or info.get("uploader_url")),
        "description": info.get("description")
        if isinstance(info.get("description"), str)
        else None,
        "published_at": _parse_date(info.get("upload_date"))
        or _parse_date(info.get("timestamp")),
        "tags": [t for t in (_clean(x, 100) for x in info.get("tags") or []) if t][
            :_MAX_TAGS
        ]
        if isinstance(info.get("tags"), list)
        else [],
        "thumbnail_url": _clean(info.get("thumbnail")),
        "source_url": _clean(info.get("webpage_url")),
    }
    fields = {k: v for k, v in fields.items() if v}
    # The person asked for this, so it fills every field it has, not only blanks.
    suggestion = ImportSuggestion(sources=["youtube"], **fields)
    return None if suggestion.is_empty() else suggestion


def approve_with(session: Session, video: Video, suggestion: ImportSuggestion) -> bool:
    """Fill ``video``'s blanks from ``suggestion`` and take it out of review.

    False (and nothing changed) when it would still lack a title or a channel.
    The file stays where it is. The caller commits.
    """
    title = suggestion.title or video.title
    channel = video.channel or suggestion.channel
    if not (title and channel):
        return False
    video.title = title
    video.channel = channel
    if suggestion.channel_url and not video.channel_url:
        video.channel_url = suggestion.channel_url
    if suggestion.description and not video.description:
        video.description = suggestion.description
    if suggestion.published_at and video.published_at is None:
        video.published_at = suggestion.published_at
    if suggestion.source_url and not video.source_url:
        video.source_url = suggestion.source_url
    if suggestion.tags and video.tags in ("", "[]"):
        video.tags = library.dump_tags(suggestion.tags)
    if suggestion.thumbnail_url and video.id is not None:
        thumb = save_from_url(suggestion.thumbnail_url, video.id)
        if thumb:
            video.thumbnail_path = thumb
    video.needs_review = False
    session.add(video)
    return True

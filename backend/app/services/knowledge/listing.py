"""Read an Ask channel's uploads (and, when asked, its past live streams) from YouTube.

Its own listing rather than the channel catalog's: the catalog reads only the
Videos tab, keeps at most its cap and can be switched off.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ..feed_meta_cache import parse_upload_date
from ..ytdlp_common import (
    EXTRACT_PRIORITY_BACKGROUND,
    EXTRACT_PRIORITY_INTERACTIVE,
    call_gated,
)
from ..ytdlp_extract import fetch_channel_feed

logger = logging.getLogger(__name__)

_PAGE = 100
# Upper bound per tab even when a channel has no limit set.
MAX_PER_TAB = 5000
_PAST_STREAM = frozenset({"was_live", "post_live"})


@dataclass
class Upload:
    yt_id: str
    title: str | None
    published_at: str | None
    duration: float | None
    is_stream: bool
    position: int


@dataclass
class Listing:
    channel_name: str | None = None
    channel_url: str | None = None
    uploads: list[Upload] = field(default_factory=list)


def _page(
    channel_url: str,
    offset: int,
    limit: int,
    tab: str,
    priority: int = EXTRACT_PRIORITY_BACKGROUND,
) -> dict[str, Any]:
    return call_gated(
        lambda: fetch_channel_feed(channel_url, offset=offset, limit=limit, tab=tab),
        url=channel_url,
        priority=priority,
    )


def _keep(entry: dict[str, Any], tab: str) -> bool:
    live = entry.get("live_status")
    if tab == "streams":
        return live in _PAST_STREAM
    return live not in ("is_live", "is_upcoming")


def _upload(entry: dict[str, Any], tab: str, position: int) -> Upload:
    published = None if entry.get("published_label") else entry.get("published_at")
    duration = entry.get("duration")
    return Upload(
        yt_id=str(entry["id"]),
        title=entry.get("title"),
        published_at=parse_upload_date(published),
        duration=float(duration) if isinstance(duration, int | float) else None,
        is_stream=tab == "streams",
        position=position,
    )


def list_tab(channel_url: str, tab: str, limit: int | None, into: Listing) -> None:
    """Append the tab's uploads (newest first) to ``into``. Raises on YouTube errors."""
    cap = min(limit or MAX_PER_TAB, MAX_PER_TAB)
    offset = 0
    position = 0
    while position < cap:
        page = _page(channel_url, offset, _PAGE, tab)
        into.channel_name = into.channel_name or page.get("channel")
        into.channel_url = into.channel_url or page.get("channel_url")
        for entry in page.get("entries") or []:
            if not entry.get("id") or not _keep(entry, tab):
                continue
            into.uploads.append(_upload(entry, tab, position))
            position += 1
            if position >= cap:
                break
        if not page.get("has_more"):
            break
        offset += _PAGE


def list_channel(
    channel_url: str, *, include_streams: bool, max_videos: int | None
) -> Listing:
    listing = Listing()
    list_tab(channel_url, "videos", max_videos, listing)
    if include_streams:
        list_tab(channel_url, "streams", max_videos, listing)
    return listing


@dataclass
class Preview:
    channel_name: str | None
    channel_url: str
    video_count: int | None
    has_streams: bool


def preview(channel_url: str) -> Preview:
    """Name, canonical URL, upload count and whether there are past live streams."""
    # Someone is waiting on the dialog: ahead of background extracts.
    first = _page(channel_url, 0, 1, "videos", EXTRACT_PRIORITY_INTERACTIVE)
    try:
        streams = _page(channel_url, 0, 5, "streams", EXTRACT_PRIORITY_INTERACTIVE)
        has_streams = any(_keep(e, "streams") for e in streams.get("entries") or [])
    except Exception:
        # Channels without a Live tab make yt-dlp raise.
        logger.debug("Ask preview: no streams tab for %s", channel_url, exc_info=True)
        has_streams = False
    count = first.get("playlist_count")
    return Preview(
        channel_name=first.get("channel"),
        channel_url=str(first.get("channel_url") or channel_url),
        video_count=int(count) if isinstance(count, int) else None,
        has_streams=has_streams,
    )

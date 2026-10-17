"""Is a YouTube channel live right now? One page fetch per channel.

``https://www.youtube.com/<channel>/live`` serves the watch page of the current
broadcast when the channel is live (and the channel page, or an upcoming
stream's page, when it is not). The watch page embeds the player response and
the page data as JSON, which carry everything the live list shows: video id,
title, viewers and the game card. A full yt-dlp extraction would cost seconds
and a player download per channel; this costs one HTML request.

Only fields the list needs are read, and every one of them is optional except
the video id: a YouTube layout change degrades the list (no game, no viewers)
instead of breaking it. When the page names a watch URL as canonical but the
embedded JSON cannot be read at all, ``LivePageUnreadable`` tells the caller to
confirm with yt-dlp instead.
"""

from __future__ import annotations

import html as html_lib
import json
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ..url_safety import fetch_bytes

logger = logging.getLogger(__name__)

_MAX_PAGE_BYTES = 6 * 1024 * 1024
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.8",
    # Skip the EU consent interstitial (it has no player response).
    "Cookie": "SOCS=CAI; CONSENT=YES+",
}
_CANONICAL_RE = re.compile(
    r'<link rel="canonical" href="https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11})"'
)
_OG_TITLE_RE = re.compile(r'<meta property="og:title" content="([^"]*)"')
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class LivePageUnreadable(RuntimeError):
    """The page looks like a watch page but its JSON could not be parsed."""

    def __init__(self, video_id: str) -> None:
        super().__init__(f"could not read the watch page of {video_id}")
        self.video_id = video_id


@dataclass(frozen=True)
class LiveBroadcast:
    video_id: str
    title: str | None
    channel_name: str | None
    game: str | None
    viewers: int | None
    started_at: datetime | None

    @property
    def thumbnail_url(self) -> str:
        return f"https://i.ytimg.com/vi/{self.video_id}/hqdefault_live.jpg"


def live_page_url(channel_url: str) -> str:
    return channel_url.rstrip("/") + "/live"


def _json_after(html: str, marker: str) -> dict[str, Any] | None:
    """The JSON object assigned right after ``marker`` (``var x = {...};``)."""
    idx = html.find(marker)
    if idx < 0:
        return None
    start = html.find("{", idx + len(marker))
    if start < 0:
        return None
    try:
        value, _end = json.JSONDecoder().raw_decode(html, start)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _text(node: Any) -> str | None:
    """YouTube text: ``{"simpleText": ...}`` or ``{"runs": [{"text": ...}]}``."""
    if isinstance(node, str):
        return node.strip() or None
    if not isinstance(node, dict):
        return None
    simple = node.get("simpleText")
    if isinstance(simple, str):
        return simple.strip() or None
    runs = node.get("runs")
    if isinstance(runs, list):
        joined = "".join(
            str(r.get("text") or "") for r in runs if isinstance(r, dict)
        ).strip()
        return joined or None
    content = node.get("content")
    if isinstance(content, str):
        return content.strip() or None
    return None


def _walk(node: Any, key: str, depth: int = 0):
    """Yield every value stored under ``key`` anywhere in ``node``."""
    if depth > 40:
        return
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            yield from _walk(v, key, depth + 1)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item, key, depth + 1)


def _game_title(initial_data: dict[str, Any] | None) -> str | None:
    """The game card under the description (Gaming category streams)."""
    if not initial_data:
        return None
    for card in _walk(initial_data, "richMetadataRenderer"):
        if not isinstance(card, dict):
            continue
        if card.get("style") != "RICH_METADATA_RENDERER_STYLE_BOX_ART":
            continue
        title = _text(card.get("title"))
        if title:
            return title
    # Newer layout: the description's gaming section lists media lockups.
    for section in _walk(initial_data, "videoDescriptionGamingSectionRenderer"):
        for lockup in _walk(section, "mediaLockupRenderer"):
            if isinstance(lockup, dict):
                title = _text(lockup.get("title"))
                if title:
                    return title
    return None


def _viewers(initial_data: dict[str, Any] | None) -> int | None:
    if not initial_data:
        return None
    for renderer in _walk(initial_data, "videoViewCountRenderer"):
        if not isinstance(renderer, dict):
            continue
        raw = renderer.get("originalViewCount")
        if isinstance(raw, str) and raw.isdigit():
            return int(raw)
        text = _text(renderer.get("viewCount")) or ""
        digits = re.sub(r"[^\d]", "", text.split(" ")[0]) if text else ""
        if digits:
            return int(digits)
    return None


def _started_at(player: dict[str, Any]) -> datetime | None:
    micro = (player.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    details = micro.get("liveBroadcastDetails") or {}
    raw = details.get("startTimestamp")
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def parse_live_page(html: str) -> LiveBroadcast | None:
    """The live broadcast on a ``/live`` page, or None when the channel is not live.

    Raises ``LivePageUnreadable`` when the canonical link names a video but the
    embedded player response is missing or unreadable.
    """
    canonical = _CANONICAL_RE.search(html)
    player = _json_after(html, "ytInitialPlayerResponse = ")
    if player is None:
        if canonical:
            raise LivePageUnreadable(canonical.group(1))
        return None
    details = player.get("videoDetails")
    if not isinstance(details, dict):
        if canonical:
            raise LivePageUnreadable(canonical.group(1))
        return None
    video_id = str(details.get("videoId") or "")
    if not VIDEO_ID_RE.match(video_id):
        return None
    micro = (player.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    live_now = (micro.get("liveBroadcastDetails") or {}).get("isLiveNow")
    is_live = details.get("isLive") is True or live_now is True
    if not is_live or details.get("isUpcoming") is True:
        return None
    initial = _json_after(html, "ytInitialData = ")
    title = details.get("title")
    author = details.get("author")
    return LiveBroadcast(
        video_id=video_id,
        title=str(title).strip() if title else None,
        channel_name=str(author).strip() if author else None,
        game=_game_title(initial),
        viewers=_viewers(initial),
        started_at=_started_at(player),
    )


def parse_channel_name(html: str) -> str | None:
    """The channel's name from a channel (not live) page's ``og:title``."""
    match = _OG_TITLE_RE.search(html)
    if not match:
        return None
    name = html_lib.unescape(match.group(1)).strip()
    return name or None


def fetch_live_page(channel_url: str, *, timeout: float = 20.0) -> str:
    """The HTML of the channel's ``/live`` page. Raises UrlFetchError / UnsafeUrlError."""
    result = fetch_bytes(
        live_page_url(channel_url),
        max_bytes=_MAX_PAGE_BYTES,
        timeout=timeout,
        headers=_HEADERS,
    )
    return result.body.decode("utf-8", errors="replace")

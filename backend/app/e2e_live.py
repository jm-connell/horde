"""Offline livestream stand-in for the Playwright suite.

The browser tests must not call YouTube. While ``HORDE_E2E`` is set, one
library channel is reported as on the air and its watch URL plays a local
file. The player treats that as a livestream with no adaptive manifest, so
the timeline, arrow keys, and LIVE control run against a real seekable range.
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from .e2e_mode import enabled
from .services.live_channels import clear_listing
from .services.url_clean import _youtube_video_id, clean_url

VIDEO_ID = "e2elive0001"
WATCH_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"
CHANNEL = "Ridge Signal"
CHANNEL_URL = "https://youtube.com/@ridgesignal"
TITLE = "Ridge overnight"
DESCRIPTION = "Overnight on the ridge.\n0:00 Sign on\n0:10 Ridge line"

_MEDIA = Path(__file__).resolve().parents[2] / "e2e" / "media" / "ridge-live.mp4"
_RANGE = re.compile(r"bytes=(\d*)-(\d*)")
_CHUNK = 64 * 1024


def matches(url: str) -> bool:
    if not enabled():
        return False
    cleaned = clean_url((url or "").strip(), keep_playlist=False)
    if cleaned == WATCH_URL:
        return True
    try:
        parsed = urlparse(cleaned)
    except ValueError:
        return False
    return _youtube_video_id(parsed) == VIDEO_ID


def fixture_meta(url: str) -> Optional[dict[str, Any]]:
    if not matches(url):
        return None
    return {
        "id": VIDEO_ID,
        "title": TITLE,
        "channel": CHANNEL,
        "channel_url": CHANNEL_URL,
        "thumbnail_url": None,
        "description": DESCRIPTION,
        "duration": None,
        "view_count": 12,
        "source_url": WATCH_URL,
        "preview_height": 90,
        "available_presets": [],
        "subtitles": [],
        "is_live": True,
        "live_manifest": None,
    }


def plant() -> None:
    """Replace the in-memory live list with the offline row."""
    if not enabled():
        raise RuntimeError("e2e live fixture refused: HORDE_E2E is not set")
    from .services.live_channels import _mark_live

    clear_listing()
    _mark_live(
        CHANNEL_URL,
        {
            "channel": CHANNEL,
            "channel_url": CHANNEL_URL,
            "video_id": VIDEO_ID,
            "url": WATCH_URL,
            "title": TITLE,
            "thumbnail_url": None,
            "checked_at": time.time(),
        },
    )


def fixture_stream(request: Request, url: str) -> Optional[Response]:
    """Serve the local file with Range support so the player can seek."""
    if not matches(url):
        return None
    if not _MEDIA.is_file():
        raise HTTPException(status_code=404, detail="e2e live media is missing")
    file_size = _MEDIA.stat().st_size
    range_header = request.headers.get("range")
    if not range_header:
        return Response(
            content=_MEDIA.read_bytes(),
            media_type="video/mp4",
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
            },
        )

    match = _RANGE.fullmatch(range_header.strip())
    if match is None:
        raise HTTPException(status_code=416, detail="Invalid range")
    start = int(match.group(1)) if match.group(1) else 0
    end = int(match.group(2)) if match.group(2) else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        raise HTTPException(status_code=416, detail="Range not satisfiable")
    length = end - start + 1

    def body():
        with _MEDIA.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        body(),
        status_code=206,
        media_type="video/mp4",
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
        },
    )

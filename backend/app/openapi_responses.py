"""OpenAPI ``responses=`` for routes that do not return JSON.

A binary, streamed or event-stream route has no ``response_model``; it declares the
media type it sends instead, so the schema (and the generated client) says so and
``tests/test_response_models.py`` can tell it from a JSON route that forgot its model.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import Response

_BINARY = {"schema": {"type": "string", "format": "binary"}}

#: Pass as ``response_class`` so FastAPI does not advertise ``application/json``.
RAW = Response


def media_response(
    *media_types: str, description: str = "Raw bytes"
) -> dict[int | str, dict[str, Any]]:
    """``responses=`` entry for a route that returns ``media_types`` as the 200."""
    return {
        200: {
            "description": description,
            "content": {media_type: _BINARY for media_type in media_types},
        }
    }


IMAGE_JPEG = media_response("image/jpeg", description="JPEG image")
IMAGE_ANY = media_response("image/*", description="Image")
VIDEO_STREAM = media_response(
    "video/*", "audio/*", description="Media bytes (supports HTTP Range)"
)
FILE_DOWNLOAD = media_response(
    "video/*", "audio/*", description="Media file as an attachment"
)
SUBTITLES = media_response("text/vtt", description="WebVTT subtitles")
DASH_MANIFEST = media_response("application/dash+xml", description="DASH manifest")
FONT_FILE = media_response("font/*", "application/octet-stream", description="Font")
BACKGROUND_FILE = media_response("image/*", "video/webm", description="Background")
EVENT_STREAM = media_response(
    "text/event-stream", description="Server-sent events, one JSON object per event"
)
PROMETHEUS_TEXT = media_response(
    "text/plain", description="Prometheus text exposition format"
)

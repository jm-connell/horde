"""The stream caption proxy: one upstream fetch per track, and rate limits."""

from __future__ import annotations

import httpx

from app.api import preview
from app.context import current
from app.services import stream_preview

URL = "https://youtu.be/dQw4w9WgXcQ"
VTT = b"WEBVTT\n\n00:00.000 --> 00:02.000\nhello\n"


def _upstream(monkeypatch, responses: list[httpx.Response]) -> list[str]:
    """Answer the proxy's upstream requests from ``responses``, in order."""
    calls: list[str] = []
    monkeypatch.setattr(
        stream_preview,
        "resolve_preview_subtitle",
        lambda *_a, **_k: {"direct_url": "https://captions.example/en.vtt"},
    )

    async def send(_client, _method, url, _headers, *, stream=False):
        calls.append(url)
        return responses[min(len(calls), len(responses)) - 1]

    monkeypatch.setattr(preview, "_send_validated", send)
    monkeypatch.setattr(preview, "get_preview_client", lambda: None)
    return calls


def test_a_caption_track_is_fetched_from_youtube_once(client, monkeypatch):
    calls = _upstream(monkeypatch, [httpx.Response(200, content=VTT)])

    first = client.get("/api/preview/subtitles", params={"url": URL})
    second = client.get("/api/preview/subtitles", params={"url": URL})

    assert (first.status_code, second.status_code) == (200, 200)
    assert second.content == VTT
    assert len(calls) == 1


def test_a_failed_caption_fetch_is_not_remembered(client, monkeypatch):
    calls = _upstream(
        monkeypatch,
        [httpx.Response(500, content=b"busy"), httpx.Response(200, content=VTT)],
    )

    assert client.get("/api/preview/subtitles", params={"url": URL}).status_code == 502
    assert client.get("/api/preview/subtitles", params={"url": URL}).content == VTT
    assert len(calls) == 2


def test_rate_limited_captions_hold_background_caption_work_off(client, monkeypatch):
    _upstream(monkeypatch, [httpx.Response(429, content=b"Sorry...")])
    assert current().timedtext.seconds_blocked() == 0

    resp = client.get("/api/preview/subtitles", params={"url": URL})

    assert resp.status_code == 502
    assert current().timedtext.seconds_blocked() > 60

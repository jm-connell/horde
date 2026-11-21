"""The media proxy when YouTube refuses an address mid-stream (403)."""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

import httpx
import pytest

from app.api import preview
from app.services import stream_preview

OLD = "https://cdn.example/old.mp4?c=VISIONOS&itag=299"
NEW = "https://cdn.example/new.mp4?c=VISIONOS&itag=299"


@pytest.fixture
def rejected_then_fresh(client, monkeypatch):
    """The stored address answers 403; the refreshed one plays.

    Yields the number of yt-dlp slots taken.
    """

    def lookup(_token, _itag, *, refresh=False):
        return {
            "direct_url": NEW if refresh else OLD,
            "http_headers": {},
            "content_type": "video/mp4",
            "extracted_at": 0.0,
        }

    async def send(_client, _method, url, _headers, *, stream=False):
        if url == OLD:
            return httpx.Response(403, content=b"")
        return httpx.Response(
            206, content=b"media", headers={"content-range": "bytes 0-4/5"}
        )

    monkeypatch.setattr(stream_preview, "lookup_preview_media", lookup)
    monkeypatch.setattr(preview, "_send_validated", send)
    monkeypatch.setattr(preview, "get_preview_client", lambda: None)

    slots = client.app.state.ytdlp_slots
    taken = {"count": 0}
    real_slot = slots.slot

    @asynccontextmanager
    async def counting_slot():
        taken["count"] += 1
        async with real_slot():
            yield

    monkeypatch.setattr(slots, "slot", counting_slot)
    return taken


def _get(client):
    return client.get(
        "/api/preview/media",
        params={"token": "t", "itag": "299"},
        headers={"Range": "bytes=0-4"},
    )


def test_a_rejected_address_is_refreshed_and_logged(
    client, rejected_then_fresh, caplog
):
    with caplog.at_level(logging.INFO, logger="app.api.preview"):
        resp = _get(client)

    assert (resp.status_code, resp.content) == (206, b"media")
    # The lookup and the refresh each ran inside a yt-dlp slot.
    assert rejected_then_fresh["count"] == 2
    rejected = next(r.getMessage() for r in caplog.records if "rejected" in r.message)
    assert "status=403" in rejected
    assert "itag=299" in rejected
    assert "client=VISIONOS" in rejected
    assert "range=bytes=0-4" in rejected
    assert any("ran the refresh" in r.getMessage() for r in caplog.records)


def test_a_request_waiting_for_anothers_refresh_holds_no_slot(
    client, rejected_then_fresh, monkeypatch, caplog
):
    monkeypatch.setattr(stream_preview, "media_refresh_in_flight", lambda _token: True)

    with caplog.at_level(logging.INFO, logger="app.api.preview"):
        resp = _get(client)

    assert resp.status_code == 206
    # Only the lookup took a slot: the wait for the refresh did not.
    assert rejected_then_fresh["count"] == 1
    assert any("waited for another" in r.getMessage() for r in caplog.records)


@pytest.fixture
def refresh_under_way(monkeypatch):
    """A session whose addresses another request is refreshing right now."""
    url = "https://youtu.be/dQw4w9WgXcQ"
    session = {"token": "tok", "source_url": url, "formats": {}}
    monkeypatch.setitem(stream_preview._preview_manifest_by_token, "tok", session)
    monkeypatch.setitem(stream_preview._preview_manifest_by_url, url, session)
    monkeypatch.setitem(
        stream_preview._preview_refresh_inflight, url, threading.Event()
    )
    return url


def test_a_refresh_under_way_is_reported_per_session(refresh_under_way):
    assert stream_preview.media_refresh_in_flight("tok") is True
    assert stream_preview.media_refresh_in_flight("other") is False


def test_waiting_for_a_slow_refresh_gives_up_soon(refresh_under_way, monkeypatch):
    monkeypatch.setattr(stream_preview, "_PREVIEW_REFRESH_FOLLOW_WAIT_SEC", 0.05)

    with pytest.raises(stream_preview.PreviewRefreshError) as caught:
        stream_preview.resolve_preview_manifest(refresh_under_way, force=True)

    # Not the stale (rejected) addresses: "try again in a moment".
    assert caught.value.retry_after == 5

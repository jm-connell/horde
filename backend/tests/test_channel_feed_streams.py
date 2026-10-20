"""GET /api/channels/feed?tab=streams: a channel's live streams, past and current."""

from __future__ import annotations

from typing import Any

from app.services import channel_catalog, ytdlp_extract

CHANNEL = "https://www.youtube.com/@alpha"


def _streams_page() -> dict[str, Any]:
    return {
        "channel": "Alpha",
        "channel_url": CHANNEL,
        "entries": [
            {
                "id": "liveliveliv",
                "url": "https://www.youtube.com/watch?v=liveliveliv",
                "title": "Live now",
                "duration": None,
                "live_status": "is_live",
            },
            {
                "id": "pastpastpas",
                "url": "https://www.youtube.com/watch?v=pastpastpas",
                "title": "Yesterday's stream",
                "duration": 4 * 3600,
                "view_count": 1200,
                "live_status": "was_live",
            },
        ],
        "has_more": False,
    }


def test_streams_tab_reads_the_streams_tab_and_reports_live_status(client, monkeypatch):
    calls: list[tuple[str, int, int, str]] = []

    def fake(channel_url, offset=0, limit=30, *, tab="videos"):
        calls.append((channel_url, offset, limit, tab))
        return _streams_page()

    def no_catalog(*args, **kwargs):  # pragma: no cover - must not be called
        raise AssertionError("the streams tab does not use the uploads catalog")

    monkeypatch.setattr(ytdlp_extract, "fetch_channel_feed", fake)
    monkeypatch.setattr(channel_catalog, "catalog_feed_page", no_catalog)
    monkeypatch.setattr(channel_catalog, "maybe_enqueue_for_feed", no_catalog)

    resp = client.get(
        "/api/channels/feed", params={"url": CHANNEL, "tab": "streams", "limit": 10}
    )
    assert resp.status_code == 200
    entries = resp.json()["entries"]
    assert [(e["id"], e["live_status"], e["duration"]) for e in entries] == [
        ("liveliveliv", "is_live", None),
        ("pastpastpas", "was_live", 4 * 3600),
    ]
    assert calls == [(CHANNEL, 0, 10, "streams")]


def test_unknown_tab_is_rejected(client):
    resp = client.get("/api/channels/feed", params={"url": CHANNEL, "tab": "shorts"})
    assert resp.status_code == 422


def test_streams_tab_url():
    assert (
        ytdlp_extract._channel_videos_url(
            "https://www.youtube.com/@a/videos", "streams"
        )
        == "https://www.youtube.com/@a/streams"
    )
    assert (
        ytdlp_extract._channel_videos_url("https://www.youtube.com/@a")
        == "https://www.youtube.com/@a/videos"
    )

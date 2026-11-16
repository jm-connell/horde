"""Channel feed enrichment: one lookup per video at a time, background priority."""

from __future__ import annotations

import threading
from typing import Any

import pytest

from app.services import feed_meta_cache, return_youtube_dislike, ytdlp_extract
from app.services.ytdlp_common import EXTRACT_PRIORITY_BACKGROUND

CHANNEL = "https://www.youtube.com/@alpha"
IDS = ["aaaaaaaaaaa", "bbbbbbbbbbb"]


def _page(*args: Any, **kwargs: Any) -> dict[str, Any]:
    # The streams tab skips the catalog, so the entries come straight from here,
    # without views, dates or votes.
    return {
        "channel": "Alpha",
        "channel_url": CHANNEL,
        "entries": [
            {
                "id": yt_id,
                "url": f"https://www.youtube.com/watch?v={yt_id}",
                "title": yt_id,
            }
            for yt_id in IDS
        ],
        "has_more": False,
    }


def _join_enrichment() -> None:
    for thread in threading.enumerate():
        if thread.name == "feed-enrich":
            thread.join(timeout=10)
            assert not thread.is_alive(), "feed enrichment still running"


@pytest.fixture
def feed(client, monkeypatch):
    monkeypatch.setattr(ytdlp_extract, "fetch_channel_feed", _page)
    monkeypatch.setattr(return_youtube_dislike, "fetch_votes", lambda yt_id: None)

    def load() -> None:
        resp = client.get(
            "/api/channels/feed", params={"url": CHANNEL, "tab": "streams"}
        )
        assert resp.status_code == 200

    yield load
    _join_enrichment()


def test_second_feed_load_does_not_repeat_lookups_in_flight(feed, monkeypatch):
    release = threading.Event()
    calls: list[tuple[str, int]] = []

    def slow_preview(url: str, *, priority: int = -1) -> dict[str, Any]:
        calls.append((url, priority))
        release.wait(10)
        return {"view_count": 5, "published_at": "2026-01-02T00:00:00+00:00"}

    monkeypatch.setattr(ytdlp_extract, "extract_preview", slow_preview)

    feed()
    feed()
    feed()
    release.set()
    _join_enrichment()

    assert sorted(url[-11:] for url, _ in calls) == IDS
    assert {priority for _, priority in calls} == {EXTRACT_PRIORITY_BACKGROUND}
    stored = feed_meta_cache.get_many(IDS)
    assert {yt_id: row["view_count"] for yt_id, row in stored.items()} == {
        yt_id: 5 for yt_id in IDS
    }


def test_videos_that_came_back_empty_are_not_retried_on_every_load(feed, monkeypatch):
    calls: list[str] = []

    def failing_preview(url: str, *, priority: int = -1) -> dict[str, Any]:
        calls.append(url)
        raise RuntimeError("Sign in to confirm you're not a bot")

    monkeypatch.setattr(ytdlp_extract, "extract_preview", failing_preview)

    feed()
    _join_enrichment()
    feed()
    _join_enrichment()

    assert len(calls) == len(IDS)


def test_partly_filled_videos_are_not_retried_on_every_load(feed, monkeypatch):
    # A thumbnail alone is stored, but the entry still lacks views and a date.
    calls: list[str] = []

    def thumbnail_only(url: str, *, priority: int = -1) -> dict[str, Any]:
        calls.append(url)
        return {"thumbnail_url": "https://i.ytimg.com/vi/x/hq.jpg"}

    monkeypatch.setattr(ytdlp_extract, "extract_preview", thumbnail_only)

    feed()
    _join_enrichment()
    feed()
    _join_enrichment()

    assert len(calls) == len(IDS)


def test_loads_of_one_channel_share_one_named_fill(client, monkeypatch):
    from app.services import activity

    pages = iter([IDS, ["ccccccccccc", "ddddddddddd"]])

    def page(*args: Any, **kwargs: Any) -> dict[str, Any]:
        out = _page()
        out["entries"] = [
            {"id": i, "url": f"https://www.youtube.com/watch?v={i}", "title": i}
            for i in next(pages)
        ]
        return out

    started = threading.Event()
    release = threading.Event()
    looked_up: list[str] = []

    def slow_preview(url: str, *, priority: int = -1) -> dict[str, Any]:
        looked_up.append(url[-11:])
        started.set()
        release.wait(10)
        return {"view_count": 5, "published_at": "2026-01-02T00:00:00+00:00"}

    monkeypatch.setattr(ytdlp_extract, "fetch_channel_feed", page)
    monkeypatch.setattr(ytdlp_extract, "extract_preview", slow_preview)
    monkeypatch.setattr(return_youtube_dislike, "fetch_votes", lambda yt_id: None)

    def fills() -> list[dict[str, Any]]:
        snap = activity.snapshot()
        return [
            t for t in snap["running"] + snap["recent"] if t["kind"] == "feed_enrich"
        ]

    before = {t["id"] for t in fills()}
    params = {"url": CHANNEL, "tab": "streams"}
    assert client.get("/api/channels/feed", params=params).status_code == 200
    assert started.wait(10)
    # The next page arrives while the first is still being filled.
    assert client.get("/api/channels/feed", params=params).status_code == 200
    release.set()
    _join_enrichment()

    assert sorted(looked_up) == sorted([*IDS, "ccccccccccc", "ddddddddddd"])
    new = [t for t in fills() if t["id"] not in before]
    assert len(new) == 1, new
    assert new[0]["label"] == "Filling in views and dates for Alpha"
    assert (new[0]["done"], new[0]["total"]) == (8, 8)

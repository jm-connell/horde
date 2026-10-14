"""Offline live fixture stays inert unless the browser suite opts in."""

from app import e2e_live
from app.services import live_channels


def setup_function():
    live_channels.reset_for_tests()


def teardown_function():
    live_channels.reset_for_tests()


def test_fixture_is_inert_without_e2e_flag(monkeypatch):
    monkeypatch.delenv("HORDE_E2E", raising=False)
    assert e2e_live.fixture_meta(e2e_live.WATCH_URL) is None


def test_fixture_meta_is_only_the_offline_stream(monkeypatch):
    monkeypatch.setenv("HORDE_E2E", "1")
    meta = e2e_live.fixture_meta("https://youtu.be/e2elive0001")
    assert meta is not None
    assert meta["is_live"] is True
    assert meta["live_manifest"] is None
    assert meta["title"] == e2e_live.TITLE
    assert meta["channel"] == e2e_live.CHANNEL
    assert (
        e2e_live.fixture_meta("https://www.youtube.com/watch?v=abcdefghijk") is None
    )


def test_preview_meta_keeps_live_flags(client, monkeypatch):
    monkeypatch.setattr(
        "app.api.preview.stream_preview.extract_stream_preview_meta",
        lambda url: {
            "id": "abcdefghijk",
            "title": "On air",
            "channel": "Ada",
            "source_url": url,
            "is_live": True,
            "live_manifest": "dash",
            "subtitles": [],
            "available_presets": [],
        },
    )
    response = client.get(
        "/api/preview/meta",
        params={"url": "https://www.youtube.com/watch?v=abcdefghijk"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["is_live"] is True
    assert body["live_manifest"] == "dash"
    assert body["title"] == "On air"


def test_fixture_row_stays_hidden_until_the_setting_is_on(client, monkeypatch):
    monkeypatch.setenv("HORDE_E2E", "1")
    e2e_live.plant()
    hidden = client.get("/api/channels/live")
    assert hidden.status_code == 200
    assert hidden.json() == {"enabled": False, "items": []}

    saved = client.patch(
        "/api/settings", json={"ui": {"show_live_channels": True}}
    )
    assert saved.status_code == 200
    shown = client.get("/api/channels/live").json()
    assert shown["enabled"] is True
    assert shown["items"][0]["channel"] == e2e_live.CHANNEL
    assert shown["items"][0]["url"] == e2e_live.WATCH_URL
    assert shown["items"][0]["title"] == e2e_live.TITLE


def test_fixture_stream_honors_byte_ranges(client, monkeypatch):
    monkeypatch.setenv("HORDE_E2E", "1")
    response = client.get(
        "/api/preview/stream",
        params={"url": e2e_live.WATCH_URL},
        headers={"Range": "bytes=0-15"},
    )
    assert response.status_code == 206
    assert response.content == e2e_live._MEDIA.read_bytes()[:16]
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"].startswith("bytes 0-15/")

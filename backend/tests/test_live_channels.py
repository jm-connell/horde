"""Current-live channel probe: on-air rows only, offline is not an error."""

from app.services import live_channels


def setup_function():
    live_channels.reset_for_tests()


def test_channel_live_url_strips_videos_tab():
    assert (
        live_channels.channel_live_url("https://www.youtube.com/@Ada/videos")
        == "https://youtube.com/@ada/live"
    )


def test_probe_keeps_current_live_and_skips_upcoming():
    def extract(url: str):
        assert url.endswith("/live")
        return {
            "entries": [
                {
                    "id": "abcdefghijk",
                    "title": "On air",
                    "live_status": "is_live",
                    "channel": "Ada",
                }
            ]
        }

    assert live_channels.probe_one("Ada", "https://www.youtube.com/@Ada", extract=extract) == "live"
    rows = live_channels.snapshot()
    assert len(rows) == 1
    assert rows[0]["video_id"] == "abcdefghijk"
    assert rows[0]["url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    assert rows[0]["channel"] == "Ada"

    def upcoming(_url: str):
        return {"id": "abcdefghijk", "live_status": "is_upcoming", "title": "Soon"}

    assert (
        live_channels.probe_one("Ada", "https://www.youtube.com/@Ada", extract=upcoming)
        == "offline"
    )
    assert live_channels.snapshot() == []


def test_benign_offline_clears_a_previous_hit():
    def live(_url: str):
        return {"id": "abcdefghijk", "live_status": "is_live", "title": "On air"}

    live_channels.probe_one("Ada", "https://www.youtube.com/@Ada", extract=live)

    def offline(_url: str):
        raise RuntimeError("ERROR: The channel is not currently live")

    assert (
        live_channels.probe_one("Ada", "https://www.youtube.com/@Ada", extract=offline)
        == "offline"
    )
    assert live_channels.snapshot() == []
    assert live_channels.is_benign_offline(RuntimeError("premieres in 2 hours"))


def test_transient_error_keeps_live_row():
    def live(_url: str):
        return {"id": "abcdefghijk", "is_live": True, "title": "On air"}

    live_channels.probe_one("Ada", "https://www.youtube.com/@Ada", extract=live)

    def boom(_url: str):
        raise RuntimeError("HTTP Error 403: Forbidden")

    assert live_channels.probe_one("Ada", "https://www.youtube.com/@Ada", extract=boom) == "error"
    assert len(live_channels.snapshot()) == 1


def test_list_endpoint_hides_rows_when_disabled(client, monkeypatch):
    live_channels.probe_one(
        "Ada",
        "https://www.youtube.com/@Ada",
        extract=lambda _url: {"id": "abcdefghijk", "live_status": "is_live", "title": "On air"},
    )
    monkeypatch.setattr(live_channels, "listing_enabled", lambda: False)
    hidden = client.get("/api/channels/live")
    assert hidden.status_code == 200
    assert hidden.json() == {"enabled": False, "items": []}

    monkeypatch.setattr(live_channels, "listing_enabled", lambda: True)
    shown = client.get("/api/channels/live")
    assert shown.status_code == 200
    body = shown.json()
    assert body["enabled"] is True
    assert body["items"][0]["channel"] == "Ada"
    assert body["items"][0]["video_id"] == "abcdefghijk"

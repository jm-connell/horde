"""YouTube's storyboard sprite sheets on GET /api/preview/meta (seek previews)."""

from __future__ import annotations

from typing import Any

import pytest

URL = "https://www.youtube.com/watch?v=storyboard1"


def _board(i: int, width: int, height: int, sheets: int, fps: float) -> dict[str, Any]:
    return {
        "format_id": f"sb{i}",
        "format_note": "storyboard",
        "ext": "mhtml",
        "width": width,
        "height": height,
        "columns": 5,
        "rows": 5,
        "fps": fps,
        "fragments": [
            {"url": f"https://i.ytimg.com/sb/storyboard1/L{i}/M{j}.jpg", "duration": 50}
            for j in range(sheets)
        ],
    }


@pytest.fixture
def info(monkeypatch) -> dict[str, Any]:
    state: dict[str, Any] = {
        "id": "storyboard1",
        "title": "A long stream",
        "duration": 1000.0,
        "live_status": "was_live",
        "webpage_url": URL,
        "formats": [
            _board(0, 48, 27, 1, 0.1),
            _board(1, 160, 90, 8, 0.2),
            {"format_id": "18", "url": "https://rr1.googlevideo.com/v", "height": 360},
        ],
    }
    monkeypatch.setattr(
        "app.services.stream_preview._extract_preview_info",
        lambda url, *, force=False: state,
    )
    return state


def test_the_sharpest_storyboard_is_offered(client, info):
    body = client.get("/api/preview/meta", params={"url": URL}).json()
    board = body["storyboard"]
    assert (board["tile_width"], board["tile_height"]) == (160, 90)
    assert (board["columns"], board["rows"]) == (5, 5)
    assert board["interval_sec"] == pytest.approx(5.0)
    assert board["count"] == 200
    assert len(board["sheets"]) == 8
    assert board["sheets"][0] == "https://i.ytimg.com/sb/storyboard1/L1/M0.jpg"


def test_a_live_broadcast_has_no_storyboard(client, info):
    info.update(live_status="is_live", is_live=True, duration=None)
    info["formats"] = [f for f in info["formats"] if f["format_id"] == "18"]
    body = client.get("/api/preview/meta", params={"url": URL}).json()
    assert body["storyboard"] is None


def test_a_storyboard_with_a_non_https_sheet_is_ignored(client, info):
    info["formats"][1]["fragments"][3]["url"] = "http://example.com/x.jpg"
    body = client.get("/api/preview/meta", params={"url": URL}).json()
    assert body["storyboard"]["tile_width"] == 48

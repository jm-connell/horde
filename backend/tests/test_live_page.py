"""Reading a channel's /live page: broadcast details from the embedded JSON."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from app.services.live.page import (
    LiveBroadcast,
    LivePageUnreadable,
    parse_channel_name,
    parse_live_page,
)

VID = "abcdefghijk"


def _player(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "videoDetails": {
            "videoId": VID,
            "title": " Speedrun night ",
            "author": "Some Channel",
            "isLive": True,
        },
        "microformat": {
            "playerMicroformatRenderer": {
                "liveBroadcastDetails": {
                    "isLiveNow": True,
                    "startTimestamp": "2026-10-01T12:30:00+00:00",
                }
            }
        },
    }
    base.update(over)
    return base


def _box_art(title: str) -> dict[str, Any]:
    return {
        "richMetadataRenderer": {
            "style": "RICH_METADATA_RENDERER_STYLE_BOX_ART",
            "title": {"simpleText": title},
        }
    }


def _viewers(**fields: Any) -> dict[str, Any]:
    return {"videoViewCountRenderer": fields}


def _page(
    player: Any = None,
    data: Any = None,
    *,
    canonical: bool = True,
    raw_player: str | None = None,
) -> str:
    parts = ["<html><head>"]
    if canonical:
        parts.append(
            f'<link rel="canonical" href="https://www.youtube.com/watch?v={VID}">'
        )
    parts.append("</head><body><script>")
    if raw_player is not None:
        parts.append(f"var ytInitialPlayerResponse = {raw_player};")
    elif player is not None:
        parts.append(f"var ytInitialPlayerResponse = {json.dumps(player)};")
    parts.append("</script><script>")
    if data is not None:
        parts.append(f"var ytInitialData = {json.dumps(data)};")
    parts.append("</script></body></html>")
    return "".join(parts)


def test_live_page_with_box_art_game_and_exact_viewers():
    data = {
        "contents": [
            _box_art("Celeste"),
            _viewers(originalViewCount="1234", viewCount={"simpleText": "9 watching"}),
        ]
    }
    got = parse_live_page(_page(_player(), data))
    assert got == LiveBroadcast(
        video_id=VID,
        title="Speedrun night",
        channel_name="Some Channel",
        game="Celeste",
        viewers=1234,
        started_at=datetime(2026, 10, 1, 12, 30, tzinfo=UTC),
    )
    assert got is not None
    assert got.thumbnail_url == f"https://i.ytimg.com/vi/{VID}/hqdefault_live.jpg"


def test_viewers_from_watching_now_text_with_runs():
    data = {
        "x": _viewers(
            viewCount={"runs": [{"text": "1,234"}, {"text": " watching now"}]}
        )
    }
    got = parse_live_page(_page(_player(), data))
    assert got is not None and got.viewers == 1234
    data = {"x": _viewers(viewCount={"simpleText": "1,234 watching now"})}
    got = parse_live_page(_page(_player(), data))
    assert got is not None and got.viewers == 1234


def test_viewers_none_when_text_has_no_number():
    data = {"x": _viewers(viewCount={"simpleText": "Waiting"})}
    got = parse_live_page(_page(_player(), data))
    assert got is not None and got.viewers is None


def test_game_from_gaming_section_media_lockup():
    data = {
        "engagementPanels": [
            {
                "videoDescriptionGamingSectionRenderer": {
                    "items": [
                        {
                            "mediaLockupRenderer": {
                                "title": {
                                    "runs": [{"text": "Hollow "}, {"text": "Knight"}]
                                }
                            }
                        }
                    ]
                }
            }
        ]
    }
    got = parse_live_page(_page(_player(), data))
    assert got is not None and got.game == "Hollow Knight"


def test_non_box_art_rich_metadata_is_not_a_game():
    data = {
        "richMetadataRenderer": {
            "style": "RICH_METADATA_RENDERER_STYLE_SOMETHING_ELSE",
            "title": {"simpleText": "A Movie"},
        }
    }
    got = parse_live_page(_page(_player(), data))
    assert got is not None and got.game is None


def test_game_missing_gives_none_but_still_live():
    got = parse_live_page(_page(_player(), {"contents": []}))
    assert got is not None
    assert got.game is None and got.viewers is None


def test_live_without_initial_data_still_parses():
    got = parse_live_page(_page(_player()))
    assert got is not None
    assert got.video_id == VID and got.game is None and got.viewers is None


def test_live_flag_from_microformat_alone():
    player = _player()
    del player["videoDetails"]["isLive"]
    assert parse_live_page(_page(player)) is not None


def test_started_at_missing_or_invalid_is_none_and_naive_is_utc():
    player = _player()
    live = player["microformat"]["playerMicroformatRenderer"]["liveBroadcastDetails"]
    live["startTimestamp"] = "not a date"
    got = parse_live_page(_page(player))
    assert got is not None and got.started_at is None
    live["startTimestamp"] = "2026-10-01T12:30:00"
    got = parse_live_page(_page(player))
    assert got is not None and got.started_at == datetime(
        2026, 10, 1, 12, 30, tzinfo=UTC
    )
    del live["startTimestamp"]
    got = parse_live_page(_page(player))
    assert got is not None and got.started_at is None


def test_upcoming_stream_is_not_live():
    player = _player()
    player["videoDetails"]["isUpcoming"] = True
    assert parse_live_page(_page(player)) is None


def test_finished_video_is_not_live():
    player = _player()
    player["videoDetails"]["isLive"] = False
    player["microformat"]["playerMicroformatRenderer"]["liveBroadcastDetails"][
        "isLiveNow"
    ] = False
    assert parse_live_page(_page(player)) is None


def test_invalid_video_id_is_none():
    player = _player()
    player["videoDetails"]["videoId"] = "short"
    assert parse_live_page(_page(player)) is None


def test_channel_page_without_player_response_is_none():
    html = "<html><body><h1>A channel</h1></body></html>"
    assert parse_live_page(html) is None
    assert parse_live_page(_page(canonical=False)) is None


def test_canonical_watch_link_without_player_json_raises():
    with pytest.raises(LivePageUnreadable) as exc:
        parse_live_page(_page(canonical=True))
    assert exc.value.video_id == VID


def test_canonical_watch_link_with_broken_json_raises():
    with pytest.raises(LivePageUnreadable):
        parse_live_page(_page(raw_player='{"videoDetails": {"videoId": '))


def test_canonical_watch_link_with_player_lacking_details_raises():
    with pytest.raises(LivePageUnreadable):
        parse_live_page(_page({"streamingData": {}}))


def test_broken_json_without_canonical_is_none():
    assert parse_live_page(_page(raw_player="{oops", canonical=False)) is None


def test_parse_channel_name_unescapes_entities():
    html = '<meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Show&quot;">'
    assert parse_channel_name(html) == 'Tom & Jerry\'s "Show"'


def test_parse_channel_name_missing_or_blank():
    assert parse_channel_name("<html></html>") is None
    assert parse_channel_name('<meta property="og:title" content="  ">') is None

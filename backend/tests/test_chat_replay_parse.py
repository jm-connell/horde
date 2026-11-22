"""Parsing YouTube's chat replay JSON into small, bounded chat items."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.services.chat_replay.parse import (
    MAX_AUTHOR,
    MAX_TEXT,
    ChatRun,
    chat_continuation,
    continuation_tokens,
    live_status_from_player_response,
    parse_actions,
)

FIXTURES = Path(__file__).parent / "fixtures" / "chat_replay"


def load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


def by_kind(kind: str):
    return next(
        i for i in parse_actions(load("chunk.json")["actions"]) if i.kind == kind
    )


def text_action(text: str, *, author: str = "Ada", cid: str = "t1", offset: int = 0):
    return {
        "replayChatItemAction": {
            "videoOffsetTimeMsec": str(offset),
            "actions": [
                {
                    "addChatItemAction": {
                        "item": {
                            "liveChatTextMessageRenderer": {
                                "id": cid,
                                "authorName": {"simpleText": author},
                                "message": {"runs": [{"text": text}]},
                            }
                        }
                    }
                }
            ],
        }
    }


def test_each_kind_is_parsed_in_offset_order():
    items = parse_actions(load("chunk.json")["actions"])
    assert [i.kind for i in items] == ["text", "paid", "sticker", "membership", "gift"]
    assert [i.offset_ms for i in items] == [1000, 2000, 3000, 3500, 4000]


def test_text_runs_emoji_and_badges():
    text = by_kind("text")
    assert text.id == "text-1"
    assert text.author == "Ada"
    assert text.badges == ["moderator"]
    assert text.runs[0] == ChatRun(text="hello ")
    # A standard emoji is its character; a custom one an image with its shortcut.
    assert text.runs[1] == ChatRun(text="\U0001f600")
    assert text.runs[2] == ChatRun(
        emoji_url="https://yt3.ggpht.com/wave=w48-h48-c-k-nd", emoji_alt=":wave:"
    )
    # A link is plain text.
    assert text.runs[3] == ChatRun(text=" see https://example.com")


def test_paid_has_amount_and_hex_colour():
    paid = by_kind("paid")
    assert paid.author == "Bo"
    assert paid.amount == "$5.00"
    assert paid.color == "#1de9b6"
    assert paid.runs == [ChatRun(text="great stream")]


def test_sticker_has_image_alt_and_amount():
    sticker = by_kind("sticker")
    assert sticker.amount == "€2.00"
    assert sticker.sticker_url == "https://yt3.ggpht.com/sticker=s80"
    assert sticker.sticker_alt == "Waving hand sticker"
    assert sticker.color == "#ffca28"


def test_membership_and_gift_have_a_header():
    member = by_kind("membership")
    assert member.header == "Member for 6 months"
    assert member.runs == [ChatRun(text="half a year!")]
    assert member.badges == ["member", "verified"]
    gift = by_kind("gift")
    assert gift.author == "Gus"
    assert gift.header == "Gifted 5 memberships"
    assert gift.badges == ["member"]


def test_dropped_kinds_and_unknown_renderers_leave_nothing():
    ids = {i.id for i in parse_actions(load("chunk.json")["actions"])}
    assert ids == {"text-1", "paid-1", "sticker-1", "member-1", "gift-1"}


def test_duplicates_odd_input_and_caps():
    assert parse_actions([None, "x", {"replayChatItemAction": {}}, {}]) == []
    assert parse_actions([text_action("hi", offset="soon")]) == []  # type: ignore[arg-type]  # bad offset on purpose
    huge = text_action("a" * 50_000, author="b" * 1000)
    items = parse_actions([huge, huge])
    assert len(items) == 1
    assert sum(len(r.text or "") for r in items[0].runs) == MAX_TEXT
    assert items[0].author is not None and len(items[0].author) == MAX_AUTHOR


def test_images_off_youtube_hosts_are_dropped():
    action = text_action("x")
    renderer = action["replayChatItemAction"]["actions"][0]["addChatItemAction"][
        "item"
    ]["liveChatTextMessageRenderer"]
    renderer["message"]["runs"] = [
        {
            "emoji": {
                "emojiId": "UC/a",
                "isCustomEmoji": True,
                "shortcuts": [":a:"],
                "image": {"thumbnails": [{"url": "http://yt3.ggpht.com/a"}]},
            }
        },
        {
            "emoji": {
                "emojiId": "UC/b",
                "isCustomEmoji": True,
                "shortcuts": [":b:"],
                "image": {"thumbnails": [{"url": "https://evil.example/b"}]},
            }
        },
    ]
    assert parse_actions([action])[0].runs == [ChatRun(text=":a:"), ChatRun(text=":b:")]


def test_tokens_continuation_and_live_status():
    assert continuation_tokens(load("chunk.json")) == ("REPLAY", "SEEK")
    assert continuation_tokens({}) == (None, None)
    assert chat_continuation(load("watch_initial_data.json")) == "RELOAD"
    assert chat_continuation({}) is None
    assert live_status_from_player_response(load("player_response.json")) == "was_live"
    assert (
        live_status_from_player_response(
            {"videoDetails": {"isLiveContent": True, "isPostLiveDvr": True}}
        )
        == "post_live"
    )
    assert (
        live_status_from_player_response({"videoDetails": {"isLiveContent": False}})
        == "not_live"
    )
    assert live_status_from_player_response({}) is None


def _renderer(action: dict) -> dict:
    item = action["replayChatItemAction"]["actions"][0]["addChatItemAction"]["item"]
    return item[next(iter(item))]


def test_every_text_field_is_capped():
    from app.services.chat_replay.parse import MAX_FIELD, MAX_ID, MAX_RUNS

    action = text_action("x", cid="i" * 5000)
    renderer = _renderer(action)
    renderer["message"]["runs"] = [
        {"emoji": {"emojiId": "e" * 5000, "shortcuts": [":" + "s" * 5000 + ":"]}}
    ] * 2000
    paid = {
        "replayChatItemAction": {
            "videoOffsetTimeMsec": "1",
            "actions": [
                {
                    "addChatItemAction": {
                        "item": {
                            "liveChatMembershipItemRenderer": {
                                "id": "m",
                                "headerPrimaryText": {"simpleText": "h" * 50_000},
                            }
                        }
                    }
                }
            ],
        }
    }
    text_item, member = parse_actions([action, paid])
    assert len(text_item.id) == MAX_ID
    assert len(text_item.runs) == MAX_RUNS
    assert all(len(r.text or "") <= MAX_FIELD for r in text_item.runs)
    assert member.header is not None and len(member.header) == MAX_FIELD


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example\\@yt3.ggpht.com/x",
        "https://user@yt3.ggpht.com/x",
        "https://yt3.ggpht.com:8443/x",
        "https://yt3.ggpht.com\\x",
    ],
)
def test_image_urls_that_could_point_elsewhere_are_dropped(url):
    action = text_action("x")
    _renderer(action)["message"]["runs"] = [
        {
            "emoji": {
                "emojiId": "UC/a",
                "isCustomEmoji": True,
                "shortcuts": [":a:"],
                "image": {"thumbnails": [{"url": url}]},
            }
        }
    ]
    assert parse_actions([action])[0].runs == [ChatRun(text=":a:")]

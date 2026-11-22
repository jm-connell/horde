"""``GET /api/chat-replay/youtube/{youtube_id}``: chat replay around a position."""

from __future__ import annotations

import pytest

from app.services.chat_replay import service
from app.services.chat_replay.parse import ChatItem, ChatRun
from app.services.chat_replay.service import ChatPage
from app.services.chat_replay.youtube import ChatReplayError
from app.services.comments.fetch import FAILED, LATER, RETRY

URL = "/api/chat-replay/youtube/abcdefghijk"
ITEM = ChatItem(
    id="paid-1",
    offset_ms=7_200_500,
    kind="paid",
    author="Bo",
    badges=["member"],
    runs=[
        ChatRun(text="great "),
        ChatRun(emoji_url="https://yt3.ggpht.com/w", emoji_alt=":w:"),
    ],
    amount="$5.00",
    color="#1de9b6",
)
ITEM_JSON = {
    "id": "paid-1",
    "offset_ms": 7_200_500,
    "kind": "paid",
    "author": "Bo",
    "badges": ["member"],
    "runs": [
        {"text": "great ", "emoji_url": None, "emoji_alt": None},
        {"text": None, "emoji_url": "https://yt3.ggpht.com/w", "emoji_alt": ":w:"},
    ],
    "amount": "$5.00",
    "color": "#1de9b6",
    "sticker_url": None,
    "sticker_alt": None,
    "header": None,
}


@pytest.fixture
def reads(monkeypatch):
    """Record what the route asked the service for."""
    seen: list[tuple] = []

    def read_at(yt_id, at_ms):
        seen.append(("at", yt_id, at_ms))
        return ChatPage("ok", [ITEM], "7401682~T")

    def read_next(yt_id, cursor):
        seen.append(("next", yt_id, cursor))
        return ChatPage("ok", [ITEM], None)

    monkeypatch.setattr(service, "read_at", read_at)
    monkeypatch.setattr(service, "read_next", read_next)
    return seen


def test_reads_at_a_position(client, reads):
    resp = client.get(URL, params={"at_ms": 7_200_000})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "status": "ok",
        "items": [ITEM_JSON],
        "next_cursor": "7401682~T",
    }
    assert reads == [("at", "abcdefghijk", 7_200_000)]


def test_no_position_reads_from_the_start(client, reads):
    assert client.get(URL).status_code == 200
    assert reads == [("at", "abcdefghijk", 0)]


def test_continues_from_a_cursor(client, reads):
    resp = client.get(URL, params={"cursor": "65000~op2w0wR%3D"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["next_cursor"] is None
    assert reads == [("next", "abcdefghijk", "65000~op2w0wR%3D")]


@pytest.mark.parametrize("status", ["none", "unavailable"])
def test_none_and_unavailable_are_200(client, monkeypatch, status):
    monkeypatch.setattr(
        service, "read_at", lambda yt_id, at_ms: ChatPage(status, [], None)
    )
    resp = client.get(URL)
    assert resp.status_code == 200
    assert resp.json() == {"status": status, "items": [], "next_cursor": None}


@pytest.mark.parametrize(
    ("params", "code"),
    [
        ({"at_ms": 1, "cursor": "1~T"}, "invalid_request"),
        ({"cursor": "not a cursor"}, "invalid_cursor"),
        ({"cursor": "1~" + "a" * 5000}, "invalid_cursor"),
    ],
)
def test_bad_requests(client, reads, params, code):
    resp = client.get(URL, params=params)
    assert resp.status_code == 422
    assert resp.json()["code"] == code
    assert reads == []


@pytest.mark.parametrize("at_ms", [-1, 86_400_001])
def test_positions_out_of_range(client, reads, at_ms):
    assert client.get(URL, params={"at_ms": at_ms}).status_code == 422
    assert reads == []


def test_bad_youtube_id(client, reads):
    resp = client.get("/api/chat-replay/youtube/short")
    assert resp.status_code == 422
    assert resp.json()["code"] == "invalid_youtube_id"


@pytest.mark.parametrize(
    ("status", "http", "code"),
    [
        (RETRY, 503, "youtube_rate_limited"),
        (LATER, 503, "youtube_unreachable"),
        (FAILED, 502, "chat_replay_unavailable"),
    ],
)
def test_failures_use_the_envelope(client, monkeypatch, status, http, code):
    def boom(yt_id, at_ms):
        raise ChatReplayError(status)

    monkeypatch.setattr(service, "read_at", boom)
    resp = client.get(URL)
    assert resp.status_code == http
    assert resp.json()["code"] == code


def test_a_restricted_member_gets_only_allowed_channels(
    client, member_client, member_user, add_video, reads
):
    kids_url = "https://www.youtube.com/@kidscraft"
    add_video(channel="Kids Craft", channel_url=kids_url, yt_id="kidsvideo01")
    add_video(
        channel="Night Frights",
        channel_url="https://www.youtube.com/@nightfrights",
        yt_id="otherviden1",
    )
    resp = client.put(
        f"/api/users/{member_user.id}/allowed-channels",
        json={"channels": [{"url": kids_url, "name": "Kids Craft"}]},
    )
    assert resp.status_code == 200, resp.text

    other = member_client.get("/api/chat-replay/youtube/otherviden1")
    assert other.status_code == 403
    assert other.json()["code"] == "channel_not_allowed"
    assert member_client.get("/api/chat-replay/youtube/kidsvideo01").status_code == 200
    assert reads == [("at", "kidsvideo01", 0)]


def test_requires_sign_in(anon_client):
    assert anon_client.get(URL).status_code == 401


def test_a_cursor_with_any_base64_token_is_accepted(client, reads):
    resp = client.get(URL, params={"cursor": "65000~ab+cd/ef=="})
    assert resp.status_code == 200, resp.text

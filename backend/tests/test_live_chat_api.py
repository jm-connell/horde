"""``GET /api/live/{video_id}/chat``: a live broadcast's chat at the viewer's moment."""

from __future__ import annotations

import pytest

from app.api import live as live_api
from app.services.chat_replay.live_runtime import LiveChatPage, LiveChatRuntime
from app.services.chat_replay.parse import ChatItem
from app.services.chat_replay.youtube import ChatReplayError
from app.services.comments.fetch import FAILED, LATER, RETRY

VID = "livevideo01"
URL = f"/api/live/{VID}/chat"
NOW = 1_763_740_900_000


@pytest.fixture
def reads(monkeypatch):
    seen: list[tuple] = []

    def read(self, yt_id, cutoff_ms, after, limit=300):
        seen.append((yt_id, cutoff_ms, after))
        item = ChatItem(id="a", offset_ms=NOW - 5000, kind="text", author="Ada")
        return LiveChatPage("ok", [item], ["gone"], 7, NOW - 60_000)

    monkeypatch.setattr(LiveChatRuntime, "read", read)
    monkeypatch.setattr(live_api, "now_ms", lambda: NOW)
    return seen


class _Session:
    def edge_lag_sec(self) -> float | None:
        return 6.0


def test_reads_at_the_viewers_moment(client, reads):
    resp = client.get(URL, params={"behind_ms": 60_000, "after": 3})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert [i["id"] for i in body["items"]] == ["a"]
    assert body["removed"] == ["gone"]
    assert (body["next_after"], body["earliest_ms"], body["cutoff_ms"]) == (
        7,
        NOW - 60_000,
        NOW - 60_000,
    )
    assert reads == [(VID, NOW - 60_000, 3)]


def test_the_players_edge_lag_is_allowed_for(client, reads, monkeypatch):
    monkeypatch.setattr(live_api, "_live_session", lambda video_id: _Session())
    body = client.get(URL).json()
    assert body["cutoff_ms"] == NOW - 6000
    assert reads == [(VID, NOW - 6000, 0)]


@pytest.mark.parametrize(
    ("status", "http", "code"),
    [
        (RETRY, 503, "youtube_rate_limited"),
        (LATER, 503, "youtube_unreachable"),
        (FAILED, 502, "chat_replay_unavailable"),
    ],
)
def test_failures_use_the_envelope(client, monkeypatch, status, http, code):
    def boom(self, *args, **kwargs):
        raise ChatReplayError(status)

    monkeypatch.setattr(LiveChatRuntime, "read", boom)
    resp = client.get(URL)
    assert resp.status_code == http
    assert resp.json()["code"] == code


def test_bad_parameters(client, reads):
    assert client.get(URL, params={"behind_ms": -1}).status_code == 422
    assert client.get(URL, params={"after": -1}).status_code == 422
    assert reads == []


def test_sign_in_required(anon_client):
    assert anon_client.get(URL).status_code == 401


def test_the_edge_lag_is_three_target_durations():
    from types import SimpleNamespace

    from app.services.live.sessions import LiveSession

    video = SimpleNamespace(upstream=SimpleNamespace(audio=False), target_duration=2.0)
    audio = SimpleNamespace(upstream=SimpleNamespace(audio=True), target_duration=5.0)
    holder = SimpleNamespace(variants={"v": video, "a": audio})
    assert LiveSession.edge_lag_sec(holder) == 6.0  # type: ignore[arg-type]  # a stand-in with only the fields read
    assert LiveSession.edge_lag_sec(SimpleNamespace(variants={})) is None  # type: ignore[arg-type]  # a stand-in with only the fields read

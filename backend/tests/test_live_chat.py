"""Live chat of a broadcast that is live now: one shared poller, a bounded buffer."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from app.services.chat_replay import live, live_runtime
from app.services.chat_replay.live import LivePoll, parse_live_actions
from app.services.chat_replay.parse import ChatItem
from app.services.chat_replay.youtube import ChatHandle, ChatReplayError
from app.services.comments.fetch import RETRY

YT = "livevideo01"
T0 = 1_763_740_800_000  # a send time, epoch ms

FIXTURE = Path(__file__).parent / "fixtures" / "chat_replay" / "live_chunk.json"


def _item(cid: str, sent_ms: int) -> ChatItem:
    return ChatItem(id=cid, offset_ms=sent_ms, kind="text", author="Ada")


def _handle() -> ChatHandle:
    return ChatHandle(yt_id=YT, api_key="k", context={}, headers={}, cookies=False)


class FakeYouTube:
    """A live chat that hands out queued polls; the last one repeats empty."""

    def __init__(self, first: LivePoll | None = None) -> None:
        self.opens = 0
        self.polls = 0
        self.first = first or LivePoll(
            [_item("a", T0), _item("b", T0 + 1000)], [], "T1", 10
        )
        self.queue: list[LivePoll | Exception] = []
        self.polled = threading.Event()

    def open(self, yt_id: str):
        self.opens += 1
        return _handle(), self.first, "is_live"

    def poll(self, handle, token, offset_ms):
        self.polls += 1
        self.polled.set()
        if self.queue:
            nxt = self.queue.pop(0)
            if isinstance(nxt, Exception):
                raise nxt
            return nxt
        return LivePoll([], [], token, 10)


@pytest.fixture
def yt(monkeypatch, init_db):
    fake = FakeYouTube()
    monkeypatch.setattr(live, "open_live_chat", fake.open)
    monkeypatch.setattr(live, "poll_live_chat", fake.poll)
    monkeypatch.setattr(live_runtime, "MIN_POLL_SEC", 0.01)
    yield fake
    init_db["ctx"].live_chat.stop_all()


@pytest.fixture
def runtime(init_db):
    return init_db["ctx"].live_chat


def _wait(pred, timeout: float = 3.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("condition never held")


def test_live_actions_parse_with_send_times_and_removals():
    items, removed = parse_live_actions(json.loads(FIXTURE.read_text())["actions"])
    assert [(i.id, i.kind, i.offset_ms) for i in items] == [
        ("l1", "text", T0),
        ("l2", "paid", T0 + 5000),
    ]
    assert removed == ["l0"]


def test_two_viewers_share_one_poller(yt, runtime):
    yt.queue.append(LivePoll([_item("c", T0 + 2000)], [], "T2", 10))
    first = runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    second = runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    assert [i.id for i in first.items] == ["a", "b"] == [i.id for i in second.items]
    _wait(lambda: yt.polls >= 1)
    page = runtime.read(YT, cutoff_ms=T0 + 10_000, after=first.next_after)
    assert [i.id for i in page.items] == ["c"]
    assert yt.opens == 1


def test_only_messages_up_to_the_cutoff_and_after_the_cursor(yt, runtime):
    page = runtime.read(YT, cutoff_ms=T0 + 500, after=0)
    assert [i.id for i in page.items] == ["a"]
    assert page.earliest_ms == T0
    more = runtime.read(YT, cutoff_ms=T0 + 5_000, after=page.next_after)
    assert [i.id for i in more.items] == ["b"]


def test_at_most_the_newest_limit(monkeypatch, init_db):
    fake = FakeYouTube(
        LivePoll([_item(f"m{n}", T0 + n) for n in range(500)], [], "T1", 10)
    )
    monkeypatch.setattr(live, "open_live_chat", fake.open)
    monkeypatch.setattr(live, "poll_live_chat", fake.poll)
    runtime = init_db["ctx"].live_chat
    try:
        page = runtime.read(YT, cutoff_ms=T0 + 1000, after=0, limit=300)
        assert len(page.items) == 300
        assert page.items[-1].id == "m499"
    finally:
        runtime.stop_all()


def test_a_deleted_message_is_removed_and_reported(yt, runtime):
    first = runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    yt.queue.append(LivePoll([], ["a"], "T2", 10))
    _wait(lambda: yt.polls >= 1)
    _wait(
        lambda: (
            runtime.read(YT, cutoff_ms=T0 + 10_000, after=first.next_after).removed
            == ["a"]
        )
    )
    assert [i.id for i in runtime.read(YT, cutoff_ms=T0 + 10_000, after=0).items] == [
        "b"
    ]


def test_polling_stops_without_readers_and_restarts_with_the_same_sequence(
    yt, runtime, monkeypatch
):
    now = [1000.0]
    monkeypatch.setattr(runtime, "clock", lambda: now[0])
    first = runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    _wait(lambda: yt.polls >= 1)
    now[0] += live_runtime.READ_IDLE_SEC + 1
    _wait(lambda: not runtime.polling(YT))
    yt.queue.append(LivePoll([_item("c", T0 + 3000)], [], "T2", 10))
    runtime.read(YT, cutoff_ms=T0 + 10_000, after=first.next_after)
    assert runtime.polling(YT)
    _wait(
        lambda: (
            [
                i.id
                for i in runtime.read(
                    YT, cutoff_ms=T0 + 10_000, after=first.next_after
                ).items
            ]
            == ["c"]
        )
    )
    assert yt.opens == 1


def test_the_end_of_the_broadcast_stops_polling_and_keeps_the_buffer(yt, runtime):
    yt.queue.append(LivePoll([_item("c", T0 + 3000)], [], None, 10))
    runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    _wait(lambda: not runtime.polling(YT))
    page = runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    assert page.status == "ok"
    assert [i.id for i in page.items] == ["a", "b", "c"]
    assert not runtime.polling(YT)


def test_a_rate_limit_pauses_and_the_buffer_is_still_served(yt, runtime, init_db):
    yt.queue.append(ChatReplayError(RETRY))
    runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    _wait(lambda: init_db["ctx"].chat_replay.seconds_paused() > 0)
    _wait(lambda: not runtime.polling(YT))
    page = runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    assert [i.id for i in page.items] == ["a", "b"]
    assert not runtime.polling(YT)


def test_the_buffer_is_bounded(monkeypatch, yt, runtime):
    monkeypatch.setattr(live_runtime, "MAX_MESSAGES", 3)
    yt.queue.append(
        LivePoll([_item(f"n{k}", T0 + 2000 + k) for k in range(5)], [], "T2", 10)
    )
    runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    _wait(lambda: yt.polls >= 2)
    page = runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    assert [i.id for i in page.items] == ["n2", "n3", "n4"]


def test_no_chat_is_none(monkeypatch, runtime, init_db):
    monkeypatch.setattr(live, "open_live_chat", lambda yt_id: (None, None, "is_live"))
    assert runtime.read(YT, cutoff_ms=T0, after=0).status == "none"
    assert not runtime.polling(YT)


def test_the_browser_suite_never_reaches_youtube(monkeypatch, runtime, init_db):
    monkeypatch.setattr(init_db["ctx"], "e2e", True)
    monkeypatch.setattr(live, "open_live_chat", lambda yt_id: pytest.fail("opened"))
    assert runtime.read(YT, cutoff_ms=T0, after=0).status == "none"


def test_stop_all_joins_every_poller(yt, runtime):
    runtime.read(YT, cutoff_ms=T0, after=0)
    assert runtime.polling(YT)
    runtime.stop_all()
    assert not runtime.polling(YT)


# --- Review fixes ------------------------------------------------------------------


def test_a_cursor_from_before_a_restart_starts_over(yt, runtime):
    page = runtime.read(YT, cutoff_ms=T0 + 10_000, after=5000)
    assert [i.id for i in page.items] == ["a", "b"]


def test_a_failing_reopen_backs_off(monkeypatch, yt, runtime):
    now = [1000.0]
    monkeypatch.setattr(runtime, "clock", lambda: now[0])
    from app.services.comments.fetch import FAILED

    yt.queue.append(ChatReplayError(FAILED))
    runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    _wait(lambda: not runtime.polling(YT) and yt.polls >= 1)

    def broken(yt_id):
        yt.opens += 1
        raise ChatReplayError(FAILED)

    monkeypatch.setattr(live, "open_live_chat", broken)
    for _ in range(5):
        page = runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
        assert [i.id for i in page.items] == ["a", "b"]  # the buffer is still served
    assert yt.opens == 2  # the first open, then one reopen until the backoff passes
    assert not runtime.polling(YT)
    now[0] += 600
    runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    assert yt.opens == 3


def test_no_chat_is_checked_again_later(monkeypatch, runtime, init_db):
    now = [1000.0]
    monkeypatch.setattr(runtime, "clock", lambda: now[0])
    opens = []

    def no_chat(yt_id):
        opens.append(yt_id)
        return None, None, "is_live"

    monkeypatch.setattr(live, "open_live_chat", no_chat)
    runtime.read(YT, cutoff_ms=T0, after=0)
    runtime.read(YT, cutoff_ms=T0, after=0)
    assert len(opens) == 1
    now[0] += live_runtime.RECHECK_SEC + 1
    runtime.read(YT, cutoff_ms=T0, after=0)
    assert len(opens) == 2


def test_unavailable_on_a_reopen_keeps_the_buffer(monkeypatch, yt, runtime):
    from app.services.comments.fetch import FAILED, UNAVAILABLE

    yt.queue.append(ChatReplayError(FAILED))
    runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    _wait(lambda: not runtime.polling(YT) and yt.polls >= 1)

    def private(yt_id):
        raise ChatReplayError(UNAVAILABLE)

    monkeypatch.setattr(live, "open_live_chat", private)
    page = runtime.read(YT, cutoff_ms=T0 + 10_000, after=0)
    assert (page.status, [i.id for i in page.items]) == ("ok", ["a", "b"])


def test_moderator_deletions_are_removals():
    actions = [
        {
            "markChatItemAsDeletedAction": {
                "targetItemId": "l9",
                "deletedStateMessage": {},
            }
        }
    ]
    assert parse_live_actions(actions) == ([], ["l9"])

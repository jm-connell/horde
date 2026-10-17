"""LiveDirectory bookkeeping and the background poll pass (no network)."""

from __future__ import annotations

import time

import pytest

from app.models import ChannelFollow
from app.services.live import directory as live_dir
from app.services.live.directory import LiveDirectory, poll_due_channels
from app.services.live.page import LiveBroadcast
from app.services.url_safety import UnsafeUrlError, UrlFetchError

A = "https://youtube.com/@alpha"
B = "https://youtube.com/@bravo"
C = "https://youtube.com/@charlie"


def _b(video_id: str = "aaaaaaaaaaa", channel: str | None = "Chan") -> LiveBroadcast:
    return LiveBroadcast(video_id, "t", channel, None, 5, None)


def _no_stop(_seconds: float) -> bool:
    return False


def _follow(session, user, url: str, name: str | None = None, followed: bool = True):
    session.add(
        ChannelFollow(
            user_id=user.id, channel_url=url, channel_name=name, followed=followed
        )
    )
    session.commit()


def _poll(directory: LiveDirectory, *, interval: float = 60.0, sleep=_no_stop):
    poll_due_channels(directory, sleep, interval=interval, spacing=0.0)


def test_poll_records_live_and_not_live(session, admin_user, monkeypatch):
    _follow(session, admin_user, A, "Alpha")
    _follow(session, admin_user, B, "Bravo")
    answers = {A: _b("aaaaaaaaaaa", "Alpha Live"), B: None}
    monkeypatch.setattr(live_dir, "check_channel", lambda url: answers[url])
    d = LiveDirectory()
    _poll(d)
    sa, sb = d.get(A), d.get(B)
    assert sa is not None and sa.broadcast is not None
    assert sa.channel_name == "Alpha Live"  # the broadcast's name wins
    assert sb is not None and sb.broadcast is None and sb.channel_name == "Bravo"
    assert [s.channel_url for s in d.live()] == [A]
    assert d.last_pass_at is not None


def test_unfollowed_rows_are_not_polled(session, admin_user, monkeypatch):
    _follow(session, admin_user, A)
    _follow(session, admin_user, B, followed=False)
    seen: list[str] = []
    monkeypatch.setattr(live_dir, "check_channel", lambda url: seen.append(url))
    _poll(LiveDirectory())
    assert seen == [A]


def test_recently_checked_channels_are_skipped(session, admin_user, monkeypatch):
    _follow(session, admin_user, A)
    _follow(session, admin_user, B)
    seen: list[str] = []
    monkeypatch.setattr(live_dir, "check_channel", lambda url: seen.append(url))
    d = LiveDirectory()
    d.record(A, None, None)  # just checked
    _poll(d, interval=3600)
    assert seen == [B]
    seen.clear()
    _poll(d, interval=3600)
    assert seen == []


def test_due_orders_never_checked_then_oldest(monkeypatch):
    now = 10_000.0
    monkeypatch.setattr(time, "time", lambda: now)
    d = LiveDirectory()
    monkeypatch.setattr(time, "time", lambda: now - 500)
    d.record(A, None, None)
    monkeypatch.setattr(time, "time", lambda: now - 900)
    d.record(B, None, None)
    monkeypatch.setattr(time, "time", lambda: now - 10)
    d.record("https://youtube.com/@fresh", None, None)
    monkeypatch.setattr(time, "time", lambda: now)
    targets = {
        A: None,
        B: None,
        C: None,
        "https://youtube.com/@fresh": None,
    }
    assert d.due(targets, 100) == [C, B, A]
    assert d.due(targets, 1000) == [C]


def test_429_pauses_and_stops_the_pass(session, admin_user, monkeypatch):
    for url in (A, B, C):
        _follow(session, admin_user, url)
    seen: list[str] = []

    def check(url: str):
        seen.append(url)
        raise UrlFetchError("Server answered 429")

    monkeypatch.setattr(live_dir, "check_channel", check)
    d = LiveDirectory()
    before = time.time()
    _poll(d)
    assert len(seen) == 1
    assert d.paused_until >= before + live_dir.RATE_LIMIT_BACKOFF_SEC - 1
    assert d.last_pass_at is None
    # While paused, nothing is checked.
    _poll(d)
    assert len(seen) == 1


def test_other_failures_keep_the_previous_broadcast(session, admin_user, monkeypatch):
    _follow(session, admin_user, A, "Alpha")
    _follow(session, admin_user, B, "Bravo")
    d = LiveDirectory()
    d.record(A, "Alpha", _b())
    old = d.get(A)
    assert old is not None

    def check(url: str):
        if url == A:
            raise UrlFetchError("Server answered 500")
        raise UnsafeUrlError("nope")

    monkeypatch.setattr(live_dir, "check_channel", check)
    monkeypatch.setattr(time, "time", lambda: old.checked_at + 1000)
    _poll(d, interval=10)
    kept = d.get(A)
    assert kept is not None and kept.broadcast == old.broadcast
    assert kept.checked_at > old.checked_at
    assert kept.confirmed_at == old.confirmed_at
    failed_new = d.get(B)
    assert failed_new is not None and failed_new.broadcast is None
    assert failed_new.channel_name == "Bravo"
    assert d.paused_until == 0.0
    assert d.last_pass_at is not None  # a normal failure does not abort the pass


def test_unexpected_errors_are_recorded_and_the_pass_goes_on(
    session, admin_user, monkeypatch
):
    _follow(session, admin_user, A)
    _follow(session, admin_user, B)
    seen: list[str] = []

    def check(url: str):
        seen.append(url)
        raise RuntimeError("boom")

    monkeypatch.setattr(live_dir, "check_channel", check)
    d = LiveDirectory()
    _poll(d)
    assert sorted(seen) == [A, B]
    assert d.get(A) is not None and d.get(B) is not None


def test_sleep_returning_true_stops_the_pass(session, admin_user, monkeypatch):
    for url in (A, B):
        _follow(session, admin_user, url)
    seen: list[str] = []
    monkeypatch.setattr(live_dir, "check_channel", lambda url: seen.append(url))
    d = LiveDirectory()
    _poll(d, sleep=lambda _s: True)
    assert len(seen) == 1
    assert d.last_pass_at is None


def test_retain_drops_unfollowed_channels(session, admin_user, monkeypatch):
    _follow(session, admin_user, A)
    monkeypatch.setattr(live_dir, "check_channel", lambda url: None)
    d = LiveDirectory()
    d.record(B, None, _b())
    d.record(A, None, None)
    _poll(d, interval=3600)
    assert d.get(B) is None
    assert d.get(A) is not None


def test_retain_directly():
    d = LiveDirectory()
    d.record(A, None, None)
    d.record(B, None, None)
    d.retain({B})
    assert d.get(A) is None and d.get(B) is not None


def test_live_filters_by_channel_set_and_sorts_by_name():
    d = LiveDirectory()
    d.record(A, "zulu", _b("aaaaaaaaaaa", None))
    d.record(B, "Alpha", _b("bbbbbbbbbbb", None))
    d.record(C, "Charlie", None)
    assert [s.channel_url for s in d.live()] == [B, A]
    assert [s.channel_url for s in d.live({A, C})] == [A]
    assert d.live(set()) == []


def test_live_drops_stale_entries(monkeypatch):
    d = LiveDirectory()
    d.record(A, "Alpha", _b())
    start = time.time()
    assert len(d.live()) == 1
    monkeypatch.setattr(time, "time", lambda: start + live_dir.STALE_LIVE_SEC + 5)
    assert d.live() == []


def test_record_failure_for_unknown_channel_creates_not_live_state():
    d = LiveDirectory()
    d.record_failure(A, "Alpha")
    state = d.get(A)
    assert state is not None and state.broadcast is None
    assert state.channel_name == "Alpha"


def test_check_channel_uses_ytdlp_when_page_unreadable(monkeypatch):
    from app.services.live.page import LivePageUnreadable

    monkeypatch.setattr(live_dir, "fetch_live_page", lambda url: "<html>")

    def unreadable(_html: str):
        raise LivePageUnreadable("abcdefghijk")

    monkeypatch.setattr(live_dir, "parse_live_page", unreadable)
    seen: list[str] = []

    def confirm(video_id: str):
        seen.append(video_id)
        return _b(video_id)

    monkeypatch.setattr(live_dir, "_confirm_with_ytdlp", confirm)
    got = live_dir.check_channel(A)
    assert seen == ["abcdefghijk"]
    assert got is not None and got.video_id == "abcdefghijk"


@pytest.mark.parametrize("seed_name", [None, "Seeded"])
def test_seed_puts_states_directly(seed_name):
    d = LiveDirectory()
    d.seed([live_dir.ChannelLiveState(A, seed_name, _b(), time.time(), time.time())])
    assert [s.channel_url for s in d.live()] == [A]


def test_live_channels_are_rechecked_first():
    d = LiveDirectory()
    d.record("https://youtube.com/@old", None, None)
    d.record("https://youtube.com/@live", None, _b())
    targets = {
        "https://youtube.com/@new": None,
        "https://youtube.com/@old": None,
        "https://youtube.com/@live": None,
    }
    assert d.due(targets, 0)[0] == "https://youtube.com/@live"


def test_live_entries_outlive_a_long_pass(monkeypatch):
    d = LiveDirectory()
    d.record("https://youtube.com/@a", "A", _b())
    real = time.time()
    monkeypatch.setattr(
        live_dir.time, "time", lambda: real + live_dir.STALE_LIVE_SEC + 60
    )
    assert d.live() == []
    d.pass_duration = live_dir.STALE_LIVE_SEC  # 400+ follows: a pass takes ages
    assert [s.channel_url for s in d.live()] == ["https://youtube.com/@a"]

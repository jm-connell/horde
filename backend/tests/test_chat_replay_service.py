"""Reading chat replay around a position: tokens and chunks cached on the context."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

import pytest
from sqlmodel import Session

from app.models import Video
from app.services.chat_replay import service, youtube
from app.services.chat_replay.parse import ChatItem
from app.services.chat_replay.youtube import ChatHandle, ChatReplayError, Chunk, Opened
from app.services.comments.fetch import FAILED, LATER, RETRY, UNAVAILABLE

YT = "abcdefghijk"


def _item(cid: str, offset_ms: int) -> ChatItem:
    return ChatItem(id=cid, offset_ms=offset_ms, kind="text", author="Ada")


def _handle(yt_id: str = YT) -> ChatHandle:
    return ChatHandle(
        yt_id=yt_id,
        api_key="k",
        context={},
        headers={},
        cookies=False,
        seek_token="SEEK",
    )


FIRST = Chunk(
    items=[_item("a", 1_000), _item("b", 65_000)],
    replay_token="REPLAY",
    seek_token="SEEK",
    end_ms=65_000,
)


@dataclass
class Calls:
    opens: list[str] = field(default_factory=list)
    fetches: list[tuple[str, int]] = field(default_factory=list)


@pytest.fixture
def calls(monkeypatch, init_db) -> Calls:
    """Fake YouTube: a chat replay with FIRST as its first chunk."""
    record = Calls()

    def open_chat(yt_id: str) -> Opened:
        record.opens.append(yt_id)
        return Opened("was_live", _handle(yt_id), FIRST)

    def fetch_chunk(handle: ChatHandle, token: str, offset_ms: int) -> Chunk:
        record.fetches.append((token, offset_ms))
        return Chunk(
            items=[_item(f"at-{offset_ms}", offset_ms)],
            replay_token=f"NEXT-{offset_ms}",
            seek_token="SEEK2",
            end_ms=offset_ms + 30_000,
        )

    monkeypatch.setattr(youtube, "open_chat", open_chat)
    monkeypatch.setattr(youtube, "fetch_chunk", fetch_chunk)
    return record


def test_no_chat_replay_answers_none_and_is_remembered(monkeypatch, calls):
    monkeypatch.setattr(
        youtube,
        "open_chat",
        lambda yt_id: calls.opens.append(yt_id) or Opened("was_live", None, None),
    )
    assert service.read_at(YT, 0).status == "none"
    assert service.read_at(YT, 60_000).status == "none"
    assert calls.opens == [YT]


def test_a_position_in_the_first_chunk_needs_no_request(calls):
    page = service.read_at(YT, 30_000)
    assert page.status == "ok"
    assert [i.id for i in page.items] == ["a", "b"]
    assert page.next_cursor == "65000~REPLAY"
    assert calls.fetches == []


def test_a_jump_uses_the_seek_token_and_is_cached(calls):
    first = service.read_at(YT, 7_200_000)
    again = service.read_at(YT, 7_201_000)  # same 5 s bucket
    assert calls.fetches == [("SEEK", 7_200_000)]
    assert [i.id for i in again.items] == [i.id for i in first.items]
    assert first.next_cursor == "7230000~NEXT-7200000"
    # The jump's newer seek token is used for the next jump.
    service.read_at(YT, 9_000_000)
    assert calls.fetches[-1] == ("SEEK2", 9_000_000)


def test_next_uses_the_replay_token_from_the_cursor(calls):
    page = service.read_next(YT, "65000~REPLAY")
    assert calls.fetches == [("REPLAY", 60_000)]
    assert page.next_cursor == "90000~NEXT-60000"
    service.read_next(YT, "65000~REPLAY")
    assert len(calls.fetches) == 1  # cached


def test_two_viewers_share_one_open(monkeypatch, calls):
    started = threading.Event()

    def slow_open(yt_id: str) -> Opened:
        started.set()
        time.sleep(0.2)
        calls.opens.append(yt_id)
        return Opened("was_live", _handle(yt_id), FIRST)

    monkeypatch.setattr(youtube, "open_chat", slow_open)
    results: list[str] = []
    threads = [
        threading.Thread(target=lambda: results.append(service.read_at(YT, 0).status))
        for _ in range(2)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == ["ok", "ok"]
    assert calls.opens == [YT]


def test_a_rate_limit_pauses_every_read(monkeypatch, calls, init_db):
    def limited(handle, token, offset_ms):
        raise ChatReplayError(RETRY)

    monkeypatch.setattr(youtube, "fetch_chunk", limited)
    with pytest.raises(ChatReplayError) as first:
        service.read_at(YT, 7_200_000)
    assert first.value.status == RETRY
    with pytest.raises(ChatReplayError) as second:
        service.read_at("zzzzzzzzzzz", 0)
    assert second.value.status == RETRY
    assert "zzzzzzzzzzz" not in calls.opens  # no YouTube request while paused
    assert init_db["ctx"].chat_replay.seconds_paused() > 0


@pytest.mark.parametrize("status", [LATER, FAILED])
def test_other_failures_raise_without_pausing(monkeypatch, calls, init_db, status):
    def broken(yt_id):
        raise ChatReplayError(status)

    monkeypatch.setattr(youtube, "open_chat", broken)
    with pytest.raises(ChatReplayError):
        service.read_at(YT, 0)
    assert init_db["ctx"].chat_replay.seconds_paused() == 0


def test_unavailable_is_a_page_not_an_error(monkeypatch, calls):
    def private(yt_id):
        raise ChatReplayError(UNAVAILABLE)

    monkeypatch.setattr(youtube, "open_chat", private)
    page = service.read_at(YT, 0)
    assert (page.status, page.items, page.next_cursor) == ("unavailable", [], None)


def test_an_unknown_library_video_learns_its_live_status(calls, session, add_video):
    unknown = add_video(source_url=f"https://www.youtube.com/watch?v={YT}", yt_id=YT)
    known = add_video(
        source_url="https://www.youtube.com/watch?v=yyyyyyyyyyy",
        yt_id="yyyyyyyyyyy",
        live_status="not_live",
    )
    service.read_at(YT, 0)
    service.read_at("yyyyyyyyyyy", 0)
    with Session(session.get_bind()) as fresh:
        assert fresh.get(Video, unknown.id).live_status == "was_live"
        assert fresh.get(Video, known.id).live_status == "not_live"


@pytest.mark.parametrize(
    ("message", "status"),
    [
        ("Sign in to confirm you're not a bot", RETRY),
        ("HTTP Error 429: Too Many Requests", RETRY),
        ("Video unavailable. This video has been removed by the uploader", UNAVAILABLE),
        (
            "Private video. Sign in if you've been granted access to this video",
            UNAVAILABLE,
        ),
        ("Something odd happened", FAILED),
    ],
)
def test_open_chat_failures_are_classified(monkeypatch, message, status):
    def boom(yt_id, url, with_cookies):
        raise RuntimeError(message)

    monkeypatch.setattr(youtube, "_open", boom)
    with pytest.raises(ChatReplayError) as err:
        youtube.open_chat(YT)
    assert err.value.status == status


def test_no_network_is_later(monkeypatch):
    def offline(yt_id, url, with_cookies):
        from yt_dlp.networking.exceptions import TransportError

        raise TransportError("Temporary failure in name resolution")

    monkeypatch.setattr(youtube, "_open", offline)
    with pytest.raises(ChatReplayError) as err:
        youtube.open_chat(YT)
    assert err.value.status == LATER


def test_chunk_end_counts_dropped_messages():
    lcc = {
        "actions": [
            {
                "replayChatItemAction": {
                    "videoOffsetTimeMsec": "5000",
                    "actions": [
                        {
                            "addChatItemAction": {
                                "item": {"liveChatPlaceholderItemRenderer": {"id": "p"}}
                            }
                        }
                    ],
                }
            }
        ],
        "continuations": [{"liveChatReplayContinuationData": {"continuation": "R"}}],
    }
    chunk = youtube.chunk_from(lcc)
    assert (chunk.items, chunk.end_ms, chunk.replay_token) == ([], 5000, "R")


# --- Review fixes ----------------------------------------------------------------


def test_no_seek_token_past_the_first_chunk_reads_nothing(monkeypatch, calls):
    """Without a way to jump, never hand back the start of the chat for a later
    position: the client would then read every chunk up to it."""

    def open_without_seek(yt_id: str) -> Opened:
        handle = _handle(yt_id)
        handle.seek_token = None
        return Opened("was_live", handle, FIRST)

    monkeypatch.setattr(youtube, "open_chat", open_without_seek)
    page = service.read_at(YT, 7_200_000)
    assert (page.status, page.items, page.next_cursor) == ("ok", [], None)
    assert calls.fetches == []
    assert [i.id for i in service.read_at(YT, 10_000).items] == ["a", "b"]


def test_an_empty_first_chunk_still_jumps(monkeypatch, calls):
    empty_first = Chunk(items=[], replay_token=None, seek_token="SEEK", end_ms=None)
    monkeypatch.setattr(
        youtube,
        "open_chat",
        lambda yt_id: Opened("was_live", _handle(yt_id), empty_first),
    )
    service.read_at(YT, 7_200_000)
    assert calls.fetches == [("SEEK", 7_200_000)]


@pytest.mark.parametrize("status", ["post_live", "not_live", "is_live"])
def test_only_a_finished_stream_has_chat(monkeypatch, calls, status):
    monkeypatch.setattr(
        youtube, "open_chat", lambda yt_id: Opened(status, _handle(yt_id), FIRST)
    )
    assert service.read_at(YT, 0).status == "none"


def test_a_failed_read_opens_afresh_on_retry(monkeypatch, calls):
    failures = iter([ChatReplayError(FAILED)])

    def flaky(handle, token, offset_ms):
        error = next(failures, None)
        if error:
            raise error
        return Chunk(items=[], replay_token=None, seek_token=None, end_ms=None)

    monkeypatch.setattr(youtube, "fetch_chunk", flaky)
    with pytest.raises(ChatReplayError):
        service.read_at(YT, 7_200_000)
    service.read_at(YT, 7_200_000)
    assert calls.opens == [YT, YT]


def test_the_browser_suite_never_reaches_youtube(monkeypatch, calls, init_db):
    monkeypatch.setattr(init_db["ctx"], "e2e", True)
    assert service.read_at(YT, 0).status == "none"
    assert calls.opens == []


class _FakeIE:
    """Just enough of yt-dlp's YoutubeBaseInfoExtractor for ``youtube._open``."""

    _YT_INITIAL_PLAYER_RESPONSE_RE = "x"

    def __init__(self, chat_data: dict) -> None:
        self.chat_data = chat_data

    def _download_webpage(self, url, video_id, note=None):
        return "chat" if "live_chat_replay" in url else "watch"

    def extract_yt_initial_data(self, video_id, page, fatal=True):
        if page == "chat":
            return self.chat_data
        return {
            "contents": {
                "twoColumnWatchNextResults": {
                    "conversationBar": {
                        "liveChatRenderer": {
                            "continuations": [
                                {"reloadContinuationData": {"continuation": "R"}}
                            ]
                        }
                    }
                }
            }
        }

    def _search_json(self, *args, **kwargs):
        return {"videoDetails": {"isLiveContent": True}}

    def extract_ytcfg(self, video_id, page):
        return {"INNERTUBE_API_KEY": "k", "INNERTUBE_CONTEXT": {"client": {}}}

    def generate_api_headers(self, **kwargs):
        return {}


def _fake_extractor(monkeypatch, chat_data: dict) -> None:
    from contextlib import contextmanager

    @contextmanager
    def extractor(with_cookies):
        yield _FakeIE(chat_data)

    monkeypatch.setattr(youtube, "_extractor", extractor)


def test_a_chat_page_youtube_no_longer_lays_out_is_a_failure(monkeypatch):
    _fake_extractor(monkeypatch, {"something": "else"})
    with pytest.raises(ChatReplayError) as err:
        youtube.open_chat(YT)
    assert err.value.status == FAILED


def test_a_readable_chat_page_opens(monkeypatch):
    _fake_extractor(
        monkeypatch,
        {"continuationContents": {"liveChatContinuation": {"actions": []}}},
    )
    opened = youtube.open_chat(YT)
    assert opened.live_status == "was_live"
    assert opened.handle is not None


def test_the_first_failure_before_retrying_with_cookies_is_logged(monkeypatch, caplog):
    attempts: list[bool] = []

    def open_once(yt_id, url, with_cookies):
        attempts.append(with_cookies)
        if not with_cookies:
            raise RuntimeError("Sign in to confirm your age")
        return Opened("was_live", None, None)

    monkeypatch.setattr(youtube, "_open", open_once)
    monkeypatch.setattr(youtube, "should_retry_with_cookies", lambda opts, exc: True)
    monkeypatch.setattr(youtube, "remember_cookie_required", lambda url: None)
    with caplog.at_level("DEBUG", logger="app.services.chat_replay.youtube"):
        youtube.open_chat(YT)
    assert attempts == [False, True]
    assert any(r.exc_info for r in caplog.records)


def test_cursors_take_any_base64_token():
    assert service.CURSOR_RE.fullmatch("65000~op2w0wR+bA/c=_-%3D")

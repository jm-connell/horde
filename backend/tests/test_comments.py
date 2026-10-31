"""Saved YouTube comments: fetching, saving, the fetcher's order, the API, search
and the video chat."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlmodel import Session, select

from app.models import Video, VideoComment, VideoCommentState
from app.services import app_settings
from app.services.comments import fetch, live, store, worker
from app.services.comments.fetch import FetchedComment, FetchResult

CSRF = {"X-Horde-Request": "1"}


def _raw(cid: str, text_: str, *, parent: str = "root", **extra: Any) -> dict:
    return {"id": cid, "text": text_, "parent": parent, **extra}


def _comment(cid: str, text_: str, *, parent: str | None = None, **extra: Any):
    return FetchedComment(
        comment_id=cid,
        parent_comment_id=parent,
        author=extra.get("author", "viewer"),
        author_is_uploader=extra.get("author_is_uploader", False),
        is_pinned=extra.get("is_pinned", False),
        is_hearted=extra.get("is_hearted", False),
        like_count=extra.get("like_count"),
        text=text_,
        published_at=None,
    )


@pytest.fixture
def no_gate(monkeypatch):
    """Run fetches straight away (the extract gate spaces calls over a second)."""
    monkeypatch.setattr(fetch, "call_gated", lambda fn, **_: fn())


def _saved(session: Session, video_id: int) -> list[VideoComment]:
    return store.saved_comments(session, video_id)


# --- Fetching ------------------------------------------------------------------


def test_the_reply_budget_goes_to_the_top_threads():
    args = fetch._ydl_opts(100, replies=True)["extractor_args"]["youtube"]
    # total, top-level, replies in all, replies per thread, depth
    assert args["max_comments"] == ["all", "100", "100", "10", "2"]
    assert args["comment_sort"] == ["top"]
    no_replies = fetch._ydl_opts(300, replies=False)["extractor_args"]["youtube"]
    assert no_replies["max_comments"][1:3] == ["300", "0"]


def test_comments_are_read_from_ytdlp_without_processing_formats(monkeypatch):
    """The real yt-dlp path: the page's comment count survives, comments come from
    the post-extractor, and no format has to exist."""
    import yt_dlp
    from yt_dlp.extractor.common import InfoExtractor

    class FakeYoutubeIE(InfoExtractor):
        IE_NAME = "fakeyoutube"
        _VALID_URL = r"https://www\.youtube\.com/watch\?v=(?P<id>[\w-]{11})"

        def _real_extract(self, url):
            video_id = self._match_id(url)
            return {
                "id": video_id,
                "title": "t",
                "comment_count": 4321,
                "__post_extractor": self.extract_comments(video_id),
            }

        def _get_comments(self, video_id):
            yield _raw("a", "first", is_pinned=True, author_is_uploader=True)
            yield _raw("a.1", "a reply", parent="a")
            yield _raw("b", "second", like_count=7, is_favorited=True)

    class FakeYoutubeDL(yt_dlp.YoutubeDL):
        def __init__(self, params=None, auto_init=True):
            super().__init__(params, auto_init=False)
            self.add_info_extractor(FakeYoutubeIE())

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYoutubeDL)
    monkeypatch.setattr(fetch, "call_gated", lambda fn, **_: fn())
    result = fetch._fetch(fetch.video_url("abcdefghijk"), 100, True, 2)
    assert result.status == fetch.SAVED
    assert result.total_count == 4321
    assert [(c.comment_id, c.parent_comment_id) for c in result.comments] == [
        ("a", None),
        ("a.1", "a"),
        ("b", None),
    ]
    first, _, second = result.comments
    assert first.is_pinned and first.author_is_uploader and not first.is_hearted
    assert second.is_hearted and second.like_count == 7


def test_only_the_page_extract_holds_the_gate(monkeypatch):
    """Previews and downloads must not wait for the comment pages."""
    import yt_dlp
    from yt_dlp.extractor.common import InfoExtractor

    state = {"in_gate": False, "pages_in_gate": None, "spacing": None}

    def gated(fn, **_):
        state["in_gate"] = True
        try:
            return fn()
        finally:
            state["in_gate"] = False

    class FakeYoutubeIE(InfoExtractor):
        IE_NAME = "fakeyoutube"
        _VALID_URL = r"https://www\.youtube\.com/watch\?v=(?P<id>[\w-]{11})"

        def _real_extract(self, url):
            video_id = self._match_id(url)
            return {
                "id": video_id,
                "title": "t",
                "__post_extractor": self.extract_comments(video_id),
            }

        def _get_comments(self, video_id):
            state["pages_in_gate"] = state["in_gate"]
            state["spacing"] = self.get_param("sleep_interval_requests")
            yield _raw("a", "first")

    class FakeYoutubeDL(yt_dlp.YoutubeDL):
        def __init__(self, params=None, auto_init=True):
            super().__init__(params, auto_init=False)
            self.add_info_extractor(FakeYoutubeIE())

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYoutubeDL)
    monkeypatch.setattr(fetch, "call_gated", gated)
    assert fetch.fetch_comments("abcdefghijk").status == fetch.SAVED
    assert state["pages_in_gate"] is False
    assert state["spacing"] == fetch.PAGE_SPACING_SEC
    live_read = fetch.fetch_comments("abcdefghijk", priority=0)
    assert live_read.status == fetch.SAVED and state["spacing"] == 0.0


def test_parsing_drops_duplicates_orphans_and_empty_comments():
    parsed = fetch.parse_comments(
        [
            _raw("a", "hello", timestamp=1_700_000_000, like_count=3),
            _raw("a", "hello again"),  # YouTube looping
            _raw("x.1", "reply to a thread that was not read", parent="x"),
            _raw("b", "   "),
            "not a dict",
            _raw("c", "fine", like_count=True),
        ]
    )
    assert [c.comment_id for c in parsed] == ["a", "c"]
    assert parsed[0].published_at == datetime.fromtimestamp(1_700_000_000, UTC)
    assert parsed[1].like_count is None


def test_turned_off_comments_are_reported_as_disabled(monkeypatch, no_gate):
    monkeypatch.setattr(
        fetch,
        "_extract",
        lambda url, opts, **_: {"comment_count": None, "comments": None},
    )
    assert fetch.fetch_comments("abcdefghijk").status == fetch.DISABLED


@pytest.mark.parametrize(
    ("message", "status"),
    [
        ("Sign in to confirm you're not a bot", fetch.RETRY),
        ("HTTP Error 429: Too Many Requests", fetch.RETRY),
        (
            "Video unavailable. This video has been removed by the uploader",
            "unavailable",
        ),
        (
            "Private video. Sign in if you've been granted access to this video",
            "unavailable",
        ),
        ("Something odd happened", fetch.FAILED),
    ],
)
def test_failures_are_classified(monkeypatch, no_gate, message, status):
    def boom(url, opts, **_):
        raise RuntimeError(message)

    monkeypatch.setattr(fetch, "_extract", boom)
    assert fetch.fetch_comments("abcdefghijk").status == status


def test_a_busy_gate_or_no_network_is_not_a_failure(monkeypatch, no_gate):
    from app.services.ytdlp_common import ExtractQueueTimeout

    def busy(url, opts, **_):
        raise ExtractQueueTimeout("Gave up waiting")

    monkeypatch.setattr(fetch, "_extract", busy)
    assert fetch.fetch_comments("abcdefghijk").status == fetch.LATER

    def offline(url, opts, **_):
        from yt_dlp.networking.exceptions import TransportError

        raise TransportError("Temporary failure in name resolution")

    monkeypatch.setattr(fetch, "_extract", offline)
    assert fetch.fetch_comments("abcdefghijk").status == fetch.LATER


# --- Saving --------------------------------------------------------------------


def test_a_fetch_replaces_the_saved_comments(session, add_video):
    video = add_video(published_at=datetime.now(UTC) - timedelta(days=400))
    store.apply_result(
        session, video, FetchResult(fetch.SAVED, [_comment("old", "old")], 1)
    )
    store.apply_result(
        session,
        video,
        FetchResult(
            fetch.SAVED,
            [_comment("a", "top"), _comment("a.1", "reply", parent="a")],
            total_count=50,
        ),
    )
    assert [c.comment_id for c in _saved(session, video.id)] == ["a", "a.1"]
    state = session.get(VideoCommentState, video.id)
    assert (state.status, state.total_count) == ("saved", 50)
    assert state.next_attempt_at is not None


def test_comments_are_fetched_again_at_a_week_a_month_six_months_and_a_year(
    session, add_video
):
    published = datetime.now(UTC) - timedelta(days=2)
    video = add_video(published_at=published)
    store.apply_result(session, video, FetchResult(fetch.SAVED, [_comment("a", "x")]))
    state = session.get(VideoCommentState, video.id)
    assert abs(
        state.next_attempt_at.replace(tzinfo=UTC) - (published + timedelta(days=7))
    ) < timedelta(seconds=1)

    def next_age(days_old: float) -> int | None:
        at = store.refresh_at(video, published + timedelta(days=days_old))
        return None if at is None else (at - published).days

    # A fetch that ran late (Horde was off) skips the ages already past, and an
    # age a few days away (the comments have barely changed); past a year,
    # every six months from the fetch.
    assert [next_age(d) for d in (6.9, 7.5, 28, 40, 200, 364, 366, 600)] == [
        30,
        30,
        182,
        182,
        365,
        364 + 182,
        366 + 182,
        600 + 182,
    ]


def test_an_old_video_is_fetched_again_every_six_months(session, add_video):
    video = add_video(published_at=datetime.now(UTC) - timedelta(days=900))
    before = datetime.now(UTC)
    store.apply_result(session, video, FetchResult(fetch.SAVED, [_comment("a", "x")]))
    next_at = session.get(VideoCommentState, video.id).next_attempt_at
    assert (next_at.replace(tzinfo=UTC) - before).days == 182


def test_comments_turned_off_later_keep_what_was_saved(session, add_video):
    video = add_video()
    store.apply_result(session, video, FetchResult(fetch.SAVED, [_comment("a", "x")]))
    store.apply_result(session, video, FetchResult(fetch.DISABLED))
    assert [c.comment_id for c in _saved(session, video.id)] == ["a"]
    assert session.get(VideoCommentState, video.id).status == "disabled"


def test_a_refetch_that_finds_nothing_keeps_what_was_saved(session, add_video):
    published = datetime.now(UTC) - timedelta(days=10)
    video = add_video(published_at=published)
    store.apply_result(session, video, FetchResult(fetch.SAVED, [_comment("a", "x")]))
    store.apply_result(session, video, FetchResult(fetch.SAVED, []))
    assert [c.comment_id for c in _saved(session, video.id)] == ["a"]
    # ...and the schedule moves on to the next age.
    next_at = session.get(VideoCommentState, video.id).next_attempt_at
    assert next_at.replace(tzinfo=UTC) - published >= timedelta(days=30)


def test_later_is_tried_again_without_counting(
    session, add_video, init_db, monkeypatch
):
    video = add_video()
    monkeypatch.setattr(
        fetch, "fetch_comments", lambda yt_id, **_: FetchResult(fetch.LATER)
    )
    for _ in range(store.MAX_ATTEMPTS + 1):
        assert worker.fetch_next() is True
        session.expire_all()
        state = session.get(VideoCommentState, video.id)
        assert state.attempts == 0 and state.next_attempt_at is not None
        state.next_attempt_at = datetime.now(UTC) - timedelta(seconds=1)
        session.add(state)
        session.commit()
    assert 0 < init_db["ctx"].comments.seconds_paused() <= worker.PAUSE_ON_LATER_SEC


def test_failures_back_off_then_give_up(session, add_video):
    video = add_video(published_at=datetime.now(UTC) - timedelta(days=900))
    waits = []
    statuses = []
    for _ in range(store.MAX_ATTEMPTS):
        before = datetime.now(UTC)
        store.apply_result(session, video, FetchResult(fetch.FAILED))
        state = session.get(VideoCommentState, video.id)
        statuses.append(state.status)
        waits.append(
            None
            if state.next_attempt_at is None
            else round(
                (state.next_attempt_at.replace(tzinfo=UTC) - before).total_seconds()
                / 3600
            )
        )
    assert waits == [1, 4, 182 * 24]  # then the six-monthly refresh
    assert statuses == ["pending", "pending", "failed"]


def test_a_young_video_given_up_on_tries_again_at_its_next_age(session, add_video):
    published = datetime.now(UTC) - timedelta(days=1)
    video = add_video(published_at=published)
    for _ in range(store.MAX_ATTEMPTS):
        store.apply_result(session, video, FetchResult(fetch.FAILED))
    state = session.get(VideoCommentState, video.id)
    assert state.status == "failed" and state.attempts == 0
    assert abs(
        state.next_attempt_at.replace(tzinfo=UTC) - (published + timedelta(days=7))
    ) < timedelta(seconds=1)


def test_a_rate_limit_does_not_count_as_an_attempt(session, add_video):
    video = add_video()
    store.apply_result(session, video, FetchResult(fetch.RETRY))
    state = session.get(VideoCommentState, video.id)
    assert state.attempts == 0 and state.next_attempt_at is not None


# --- The fetcher ---------------------------------------------------------------


def test_the_fetcher_takes_new_videos_first_and_skips_what_it_cannot_fetch(
    session, add_video
):
    now = datetime.now(UTC)
    older = add_video(added_at=now - timedelta(days=3))
    newer = add_video(added_at=now - timedelta(days=1))
    add_video(added_at=now, needs_review=True)
    add_video(added_at=now, source_url=None, file_path="Alpha/2024/clip [clip-1].mp4")
    retry_due = add_video(added_at=now)
    not_due = add_video(added_at=now)
    session.add(
        VideoCommentState(
            video_id=retry_due.id, status="failed", next_attempt_at=now - timedelta(1)
        )
    )
    session.add(
        VideoCommentState(
            video_id=not_due.id, status="failed", next_attempt_at=now + timedelta(1)
        )
    )
    session.commit()

    order = []
    while (video := worker.next_video(session)) is not None:
        order.append(video.id)
        session.merge(VideoCommentState(video_id=video.id, next_attempt_at=None))
        session.commit()
    assert order == [newer.id, older.id, retry_due.id]


def test_fetch_next_saves_and_a_rate_limit_pauses_everyone(
    session, add_video, init_db, monkeypatch
):
    video = add_video()
    calls = []

    def fake(yt_id, **_):
        calls.append(yt_id)
        return FetchResult(fetch.SAVED, [_comment("a", "nice")], 9)

    monkeypatch.setattr(fetch, "fetch_comments", fake)
    assert worker.fetch_next() is True
    assert calls == [video.youtube_id]
    session.expire_all()
    assert [c.text for c in _saved(session, video.id)] == ["nice"]
    assert worker.fetch_next() is False  # nothing else is due

    other = add_video()
    monkeypatch.setattr(
        fetch, "fetch_comments", lambda yt_id, **_: FetchResult("retry")
    )
    assert worker.fetch_next() is True
    assert init_db["ctx"].comments.seconds_paused() > 3000
    session.expire_all()
    assert session.get(VideoCommentState, other.id).next_attempt_at is not None


def test_comments_off_turns_the_whole_feature_off(
    client, session, add_video, monkeypatch
):
    from app.services import comments
    from app.services.ai import embeddings

    video = add_video(title="Shop tour")
    store.apply_result(
        session, video, FetchResult(fetch.SAVED, [_comment("a", "zeppelin rides")])
    )
    monkeypatch.setattr(fetch, "fetch_comments", lambda *a, **k: pytest.fail("fetched"))
    app_settings.save({"comments_enabled": False})

    assert comments.enabled() is False
    assert client.get(f"/api/videos/{video.id}/comments").json() == {
        "status": "off",
        "youtube_id": None,
        "fetched_at": None,
        "total_count": None,
        "items": [],
        "next_limit": None,
    }
    for resp in (
        client.post(f"/api/videos/{video.id}/comments/refresh"),
        client.get("/api/comments/youtube/abcdefghijk"),
    ):
        assert (resp.status_code, resp.json()["code"]) == (409, "comments_off")
    assert client.get("/api/videos", params={"q": "zeppelin"}).json()["items"] == []
    context = embeddings.build_chat_context(session, video, "what did people say?")
    assert "zeppelin" not in context

    # Back on: what was saved is all there again, nothing refetched.
    app_settings.save({"comments_enabled": True})
    items = client.get(f"/api/videos/{video.id}/comments").json()["items"]
    assert [c["text"] for c in items] == ["zeppelin rides"]


def test_the_switch_is_admins_to_change_and_everyone_sees_it(
    client, member_client, init_db
):
    assert member_client.get("/api/settings").json()["comments_enabled"] is True
    assert (
        member_client.patch(
            "/api/settings", json={"comments_enabled": False}
        ).status_code
        == 403
    )
    assert (
        client.patch("/api/settings", json={"comments_enabled": False}).json()[
            "comments_enabled"
        ]
        is False
    )
    # Members' watch pages hide comments too, so they read the real value.
    assert member_client.get("/api/settings").json()["comments_enabled"] is False
    wake = init_db["ctx"].comments.wake
    wake.clear()
    client.patch("/api/settings", json={"comments_enabled": True})
    assert wake.is_set()


# --- The API -------------------------------------------------------------------


def test_saved_comments_come_back_as_threads(client, session, add_video):
    video = add_video()
    store.apply_result(
        session,
        video,
        FetchResult(
            fetch.SAVED,
            [
                _comment("p", "pinned note", is_pinned=True, author_is_uploader=True),
                _comment("a", "great video", like_count=12, is_hearted=True),
                _comment("a.1", "agreed", parent="a"),
                _comment("b", "first!"),
            ],
            total_count=1234,
        ),
    )
    body = client.get(f"/api/videos/{video.id}/comments").json()
    assert body["status"] == "saved"
    assert body["total_count"] == 1234
    assert body["youtube_id"] == video.youtube_id
    assert body["next_limit"] is None  # fewer than 100 were there
    assert [c["id"] for c in body["items"]] == ["p", "a", "b"]
    assert body["items"][0]["is_pinned"] and body["items"][0]["author_is_uploader"]
    assert body["items"][1]["is_hearted"] and body["items"][1]["like_count"] == 12
    assert [r["text"] for r in body["items"][1]["replies"]] == ["agreed"]


def test_a_full_page_offers_more(client, session, add_video):
    video = add_video()
    store.apply_result(
        session,
        video,
        FetchResult(
            fetch.SAVED,
            [_comment(f"c{i}", f"comment {i}") for i in range(fetch.TOP_COMMENTS)],
        ),
    )
    assert client.get(f"/api/videos/{video.id}/comments").json()["next_limit"] == 300


def test_no_more_is_offered_once_youtube_no_longer_shows_them(
    client, session, add_video
):
    video = add_video()
    full = [_comment(f"c{i}", f"comment {i}") for i in range(fetch.TOP_COMMENTS)]
    store.apply_result(session, video, FetchResult(fetch.SAVED, full))
    store.apply_result(session, video, FetchResult(fetch.DISABLED))
    body = client.get(f"/api/videos/{video.id}/comments").json()
    assert body["status"] == "disabled" and len(body["items"]) == 100
    assert body["next_limit"] is None


def test_the_status_says_why_there_are_no_comments(
    client, member_client, session, add_video
):
    upload = add_video(source_url=None, file_path="Alpha/2024/home movie.mp4")
    assert client.get(f"/api/videos/{upload.id}/comments").json()["status"] == (
        "not_youtube"
    )
    video = add_video()
    url = f"/api/videos/{video.id}/comments"
    assert member_client.get(url).json()["status"] == "pending"
    store.apply_result(session, video, FetchResult(fetch.FAILED))
    assert client.get(url).json()["status"] == "pending"  # it will try again soon
    for _ in range(store.MAX_ATTEMPTS - 1):
        store.apply_result(session, video, FetchResult(fetch.FAILED))
    assert client.get(url).json()["status"] == "failed"

    later = add_video()
    app_settings.save({"comments_enabled": False})
    assert client.get(f"/api/videos/{later.id}/comments").json()["status"] == "off"
    resp = client.get("/api/videos/999999/comments")
    assert (resp.status_code, resp.json()["code"]) == (404, "not_found")


def test_more_comments_are_read_live_and_kept_for_a_while(client, monkeypatch):
    calls = []

    def fake(yt_id, *, limit, replies, priority):
        calls.append((yt_id, limit, replies))
        return FetchResult(
            fetch.SAVED,
            [_comment(f"c{i}", f"comment {i}") for i in range(limit)],
            total_count=5000,
        )

    monkeypatch.setattr(live, "fetch_comments", fake)
    url = "/api/comments/youtube/abcdefghijk"
    body = client.get(url, params={"limit": 300}).json()
    assert body["status"] == "ok"
    assert len(body["items"]) == 300 and body["next_limit"] == 1000
    client.get(url, params={"limit": 300})
    assert calls == [("abcdefghijk", 300, False)]
    first = client.get(url).json()
    assert len(first["items"]) == 100 and calls[-1] == ("abcdefghijk", 100, True)
    last = client.get(url, params={"limit": 1000}).json()
    assert last["next_limit"] is None


def test_simultaneous_live_reads_share_one_fetch(init_db, monkeypatch):
    import threading
    import time

    calls = []

    def slow(yt_id, **_):
        calls.append(yt_id)
        time.sleep(0.2)
        return FetchResult(fetch.SAVED, [_comment("a", "x")])

    monkeypatch.setattr(live, "fetch_comments", slow)
    ctx = init_db["ctx"]
    results = []

    def read():
        from app import context

        previous = context.activate(ctx)
        try:
            results.append(live.fetch_live("abcdefghijk", 100))
        finally:
            context.deactivate(previous)

    threads = [threading.Thread(target=read) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert calls == ["abcdefghijk"]
    assert [r.status for r in results] == [fetch.SAVED] * 3


def test_live_comments_refuse_bad_input_and_report_failures(client, monkeypatch):
    resp = client.get("/api/comments/youtube/not-an-id")
    assert (resp.status_code, resp.json()["code"]) == (422, "invalid_youtube_id")
    resp = client.get("/api/comments/youtube/abcdefghijk", params={"limit": 50})
    assert (resp.status_code, resp.json()["code"]) == (422, "invalid_limit")

    results = iter(
        [
            FetchResult("retry"),
            FetchResult(fetch.LATER),
            FetchResult(fetch.FAILED),
            FetchResult(fetch.DISABLED),
        ]
    )
    monkeypatch.setattr(live, "fetch_comments", lambda *a, **k: next(results))
    url = "/api/comments/youtube/abcdefghijk"
    resp = client.get(url)
    assert (resp.status_code, resp.json()["code"]) == (503, "youtube_rate_limited")
    resp = client.get(url)
    assert (resp.status_code, resp.json()["code"]) == (503, "youtube_unreachable")
    resp = client.get(url)
    assert (resp.status_code, resp.json()["code"]) == (502, "comments_unavailable")
    assert client.get(url).json() == {
        "status": "disabled",
        "total_count": None,
        "items": [],
        "next_limit": None,
    }


# --- Search, chat and deletion -------------------------------------------------


def test_search_finds_a_video_through_its_comments_after_title_matches(
    client, session, add_video
):
    by_title = add_video(title="Rebuilding a carburetor")
    by_comment = add_video(title="Shop tour", channel="Beta")
    add_video(title="Unrelated")
    store.apply_result(
        session,
        by_comment,
        FetchResult(
            fetch.SAVED,
            [
                _comment(
                    "a", "The carburetor rebuild at 12:30 saved my bike", like_count=4
                )
            ],
        ),
    )
    items = client.get("/api/videos", params={"q": "carburetor"}).json()["items"]
    assert [v["id"] for v in items] == [by_title.id, by_comment.id]
    assert items[1]["match_reason"]["source"] == "comments"
    assert "carburetor" in items[1]["match_reason"]["snippet"]
    # Filters still apply to videos found through comments.
    alpha = client.get("/api/videos", params={"q": "carburetor", "channel": "Alpha"})
    assert [v["id"] for v in alpha.json()["items"]] == [by_title.id]


def test_the_video_chat_sees_the_top_comments_with_the_creator_marked(
    session, add_video
):
    from app.services.ai import embeddings

    video = add_video(title="Engine teardown")
    store.apply_result(
        session,
        video,
        FetchResult(
            fetch.SAVED,
            [
                _comment(
                    "p",
                    "Correction: the bolt is 10 mm",
                    author_is_uploader=True,
                    is_pinned=True,
                ),
                _comment("a", "What torque did you use?", like_count=40),
                _comment("a.1", "25 Nm", parent="a", author_is_uploader=True),
                _comment("a.2", "thanks", parent="a"),
                _comment("b", "x" * 900),
            ],
        ),
    )
    context = embeddings.build_chat_context(session, video, "what did people say?")
    assert "Top viewer comments" in context
    assert "- [the creator, pinned] Correction: the bolt is 10 mm" in context
    assert "- What torque did you use? (40 likes)" in context
    assert "  - reply [the creator] 25 Nm" in context
    assert "thanks" not in context  # viewers' replies stay out
    assert "x" * 400 not in context  # one comment is cut short


def test_a_thread_too_long_for_the_chat_is_skipped_not_the_rest(session, add_video):
    video = add_video()
    long_thread = [_comment("p", "intro", author_is_uploader=True)] + [
        _comment(f"p.{i}", "y" * 390, parent="p", author_is_uploader=True)
        for i in range(9)
    ]
    store.apply_result(
        session,
        video,
        FetchResult(fetch.SAVED, [*long_thread, _comment("b", "short and sweet")]),
    )
    lines = store.chat_lines(session, video.id)
    assert lines == ["- short and sweet"]


def test_deleting_a_video_removes_its_comments_and_their_index(session, add_video):
    from app.services.video_delete import delete_video_cascade

    video = add_video()
    store.apply_result(
        session, video, FetchResult(fetch.SAVED, [_comment("a", "zeppelin")])
    )
    delete_video_cascade(session, session.get(Video, video.id), delete_files=False)
    assert session.exec(select(VideoComment)).all() == []
    assert session.get(VideoCommentState, video.id) is None
    hits = session.execute(
        text(
            "SELECT count(*) FROM video_comments_fts WHERE video_comments_fts MATCH 'zeppelin'"
        )
    ).scalar()
    assert hits == 0


# --- Refreshing by hand --------------------------------------------------------


def test_refresh_fetches_and_saves_now(client, session, add_video, monkeypatch):
    from app.services.ytdlp_common import EXTRACT_PRIORITY_INTERACTIVE

    video = add_video(published_at=datetime.now(UTC) - timedelta(days=900))
    store.apply_result(session, video, FetchResult(fetch.SAVED, [_comment("old", "x")]))
    calls = []

    def fake(yt_id, **kwargs):
        calls.append((yt_id, kwargs["priority"]))
        return FetchResult(fetch.SAVED, [_comment("new", "fresh take")], 77)

    monkeypatch.setattr(fetch, "fetch_comments", fake)
    resp = client.post(f"/api/videos/{video.id}/comments/refresh")
    assert resp.status_code == 200
    body = resp.json()
    assert [c["id"] for c in body["items"]] == ["new"]
    assert body["status"] == "saved" and body["total_count"] == 77
    assert calls == [(video.youtube_id, EXTRACT_PRIORITY_INTERACTIVE)]


def test_only_a_youtube_video_can_be_refreshed(client, add_video, monkeypatch):
    """Who may refresh (Edit details) is pinned in test_permissions.GATES."""
    monkeypatch.setattr(fetch, "fetch_comments", lambda *a, **k: pytest.fail("fetched"))
    upload = add_video(source_url=None, file_path="Alpha/2024/home movie.mp4")
    resp = client.post(f"/api/videos/{upload.id}/comments/refresh")
    assert (resp.status_code, resp.json()["code"]) == (409, "not_youtube")


def test_a_rate_limited_refresh_says_so_and_pauses_the_fetcher(
    client, add_video, init_db, monkeypatch
):
    video = add_video()
    monkeypatch.setattr(fetch, "fetch_comments", lambda *a, **k: FetchResult("retry"))
    resp = client.post(f"/api/videos/{video.id}/comments/refresh")
    assert (resp.status_code, resp.json()["code"]) == (503, "youtube_rate_limited")
    assert init_db["ctx"].comments.seconds_paused() > 3000


def test_a_failed_refresh_leaves_the_schedule_alone(
    client, session, add_video, monkeypatch
):
    video = add_video(published_at=datetime.now(UTC) - timedelta(days=900))
    url = f"/api/videos/{video.id}/comments"
    assert client.get(url).json()["status"] == "pending"
    outcomes = iter([fetch.FAILED, fetch.FAILED, fetch.FAILED, fetch.LATER, "retry"])
    monkeypatch.setattr(
        fetch, "fetch_comments", lambda *a, **k: FetchResult(next(outcomes))
    )
    for _ in range(5):
        assert client.post(f"{url}/refresh").status_code in (502, 503)
    assert session.get(VideoCommentState, video.id) is None
    assert client.get(url).json()["status"] == "pending"


def test_a_fetch_saved_at_the_same_moment_by_the_fetcher_does_not_clash(
    session, add_video, init_db, monkeypatch
):
    """The fetcher commits a video's first state row while a refresh saves it."""
    from sqlalchemy.dialects.sqlite import insert as real_insert

    video = add_video()

    def insert_after_the_fetcher(model):
        with Session(init_db["engine"]) as other:
            other.add(VideoCommentState(video_id=video.id, status="pending"))
            other.commit()
        return real_insert(model)

    monkeypatch.setattr(store, "sqlite_insert", insert_after_the_fetcher)
    store.apply_result(session, video, FetchResult(fetch.SAVED, [_comment("a", "x")]))
    assert session.get(VideoCommentState, video.id).status == "saved"

"""Ask leaves sponsor reads out of answers, using SponsorBlock's segments."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlmodel import Session, select

from app import config
from app.models import KbChannel, KbChannelStatus, KbVideo, as_utc
from app.services.knowledge import (
    captions,
    chunking,
    indexing,
    listing,
    retrieval,
    sponsorblock,
    worker,
)

AD = "this episode is brought to you by david protein bars use code huberman"
TALK = "protein intake research says one point six grams per kilogram helps"


def _vtt(seconds: int, text_at) -> str:
    out = ["WEBVTT", ""]
    for s in range(0, seconds, 3):
        out += [
            f"00:{s // 60:02d}:{s % 60:02d}.000 --> "
            f"00:{(s + 3) // 60:02d}:{(s + 3) % 60:02d}.000",
            f"{text_at(s)} {s}",
            "",
        ]
    return "\n".join(out)


# Ad read from 90 s to 170 s, the real talk about protein after 200 s.
EPISODE = _vtt(
    300,
    lambda s: AD if 90 <= s < 170 else TALK if s >= 200 else "welcome to the show",
)


def _channel(session: Session, **fields) -> KbChannel:
    channel = KbChannel(
        channel_url=fields.pop("channel_url", "https://youtube.com/@hubermanlab"),
        channel_name="Huberman Lab",
        status=fields.pop("status", KbChannelStatus.ready),
        **fields,
    )
    session.add(channel)
    session.commit()
    session.refresh(channel)
    return channel


def _video(
    session: Session, channel: KbChannel, yt_id: str, vtt: str = EPISODE, **fields
) -> KbVideo:
    assert channel.id is not None
    video = KbVideo(kb_channel_id=channel.id, yt_id=yt_id, **fields)
    session.add(video)
    session.commit()
    session.refresh(video)
    indexing.apply_result(
        session, video, captions.CaptionResult(captions.FETCHED, vtt=vtt)
    )
    session.refresh(video)
    return video


@pytest.fixture
def sponsor_api(monkeypatch):
    """Turn SponsorBlock on and answer its requests with ``reply(request)``."""
    monkeypatch.setattr(config, "ASK_SPONSORBLOCK", True)
    calls: list[httpx.Request] = []
    state: dict = {"reply": lambda request: httpx.Response(404)}

    def fake_get(url, params=None, **kwargs):
        request = httpx.Request("GET", url, params=params)
        calls.append(request)
        response = state["reply"](request)
        response.request = request
        return response

    monkeypatch.setattr(sponsorblock.httpx, "get", fake_get)
    state["calls"] = calls
    return state


# --- the request ---------------------------------------------------------------


def test_fetch_parses_segments_and_sends_only_the_id(sponsor_api):
    sponsor_api["reply"] = lambda r: httpx.Response(
        200,
        json=[
            {"category": "sponsor", "segment": [90.0, 170.5], "actionType": "skip"},
            {"category": "selfpromo", "segment": [280, 295], "actionType": "mute"},
            # Not ad reads: a whole-video label, a highlight, a broken row.
            {"category": "sponsor", "segment": [0, 0], "actionType": "full"},
            {"category": "poi_highlight", "segment": [10, 10], "actionType": "poi"},
            {"category": "sponsor", "segment": "junk"},
        ],
    )
    assert sponsorblock.fetch("abcdefghijk") == [
        (90.0, 170.5, "sponsor"),
        (280.0, 295.0, "selfpromo"),
    ]
    [request] = sponsor_api["calls"]
    assert request.url.host == "sponsor.ajay.app"
    assert request.url.params["videoID"] == "abcdefghijk"
    assert set(json.loads(request.url.params["categories"])) >= {
        "sponsor",
        "selfpromo",
        "interaction",
    }
    # Nothing about the user or the server goes along.
    assert set(request.url.params) == {"videoID", "categories", "actionTypes"}


@pytest.mark.parametrize("status", [404, 400])
def test_fetch_no_segments(sponsor_api, status):
    sponsor_api["reply"] = lambda r: httpx.Response(status, text="Not Found")
    assert sponsorblock.fetch("abcdefghijk") == []


def test_fetch_failures_are_retried_later(sponsor_api):
    def timeout(request):
        raise httpx.ReadTimeout("slow", request=request)

    for reply in (
        timeout,
        lambda r: httpx.Response(500),
        lambda r: httpx.Response(429),
        lambda r: httpx.Response(200, text="<html>"),
    ):
        sponsor_api["reply"] = reply
        assert sponsorblock.fetch("abcdefghijk") is None


# --- storage and pacing --------------------------------------------------------


def test_refresh_stores_segments_and_when(session, init_db, sponsor_api):
    video = _video(session, _channel(session), "abcdefghijk")
    sponsor_api["reply"] = lambda r: httpx.Response(
        200, json=[{"category": "sponsor", "segment": [90, 170]}]
    )
    assert sponsorblock.refresh(video.id, video.yt_id)
    session.refresh(video)
    assert json.loads(video.sponsor_segments) == [[90.0, 170.0, "sponsor"]]
    assert video.sponsor_checked_at is not None
    # Spaced out: the next request waits.
    assert not sponsorblock.refresh(video.id, video.yt_id)
    assert len(sponsor_api["calls"]) == 1


def test_no_segments_are_recorded_as_checked(session, init_db, sponsor_api):
    video = _video(session, _channel(session), "abcdefghijk")
    assert sponsorblock.refresh(video.id, video.yt_id)  # 404
    session.refresh(video)
    assert video.sponsor_segments is None
    assert video.sponsor_checked_at is not None


def test_a_failure_leaves_the_video_due_and_pauses_requests(
    session, init_db, sponsor_api
):
    video = _video(session, _channel(session), "abcdefghijk")
    sponsor_api["reply"] = lambda r: httpx.Response(503)
    assert sponsorblock.refresh(video.id, video.yt_id)
    session.refresh(video)
    assert video.sponsor_checked_at is None
    pacer = init_db["ctx"].knowledge.sponsor
    assert pacer.seconds_until_free() > sponsorblock.FAILURE_PAUSE_SEC - 5
    assert sponsorblock.has_due()
    assert not sponsorblock.step()


def test_off_means_no_requests(session, init_db, sponsor_api, monkeypatch):
    monkeypatch.setattr(config, "ASK_SPONSORBLOCK", False)
    video = _video(session, _channel(session), "abcdefghijk")
    assert not sponsorblock.refresh(video.id, video.yt_id)
    assert not sponsorblock.step()
    assert not sponsorblock.has_due()
    assert sponsor_api["calls"] == []


# --- the worker ----------------------------------------------------------------


def test_worker_asks_after_storing_captions_without_holding_the_db(
    session, init_db, sponsor_api, monkeypatch
):
    channel = _channel(session, status=KbChannelStatus.indexing)
    assert channel.id is not None
    session.add(KbVideo(kb_channel_id=channel.id, yt_id="abcdefghijk"))
    session.commit()
    monkeypatch.setattr(worker, "next_due_video", lambda s: None)
    monkeypatch.setattr(
        captions,
        "fetch_remote",
        lambda yt_id: captions.CaptionResult(captions.FETCHED, vtt=EPISODE),
    )
    db_path = str(init_db["engine"].url.database)

    def reply(request):
        # The captions are already committed, and nothing holds the write lock.
        conn = sqlite3.connect(db_path, timeout=0.5)
        try:
            conn.execute("BEGIN IMMEDIATE")
            status = conn.execute(
                "SELECT fetch_status FROM kb_videos WHERE yt_id = 'abcdefghijk'"
            ).fetchone()[0]
            conn.rollback()
        finally:
            conn.close()
        assert status == captions.FETCHED
        return httpx.Response(200, json=[{"category": "sponsor", "segment": [90, 170]}])

    sponsor_api["reply"] = reply
    assert worker.fetch_next_video()
    assert len(sponsor_api["calls"]) == 1
    video = session.exec(select(KbVideo)).one()
    session.refresh(video)
    assert video.sponsor_segments and video.sponsor_checked_at is not None


def test_a_sponsorblock_failure_never_fails_indexing(
    session, init_db, sponsor_api, monkeypatch
):
    channel = _channel(session, status=KbChannelStatus.indexing)
    assert channel.id is not None
    session.add(KbVideo(kb_channel_id=channel.id, yt_id="abcdefghijk"))
    session.commit()
    monkeypatch.setattr(worker, "next_due_video", lambda s: None)
    monkeypatch.setattr(
        captions,
        "fetch_remote",
        lambda yt_id: captions.CaptionResult(captions.FETCHED, vtt=EPISODE),
    )

    def down(request):
        raise httpx.ConnectError("down", request=request)

    sponsor_api["reply"] = down
    assert worker.fetch_next_video()
    video = session.exec(select(KbVideo)).one()
    session.refresh(video)
    assert video.fetch_status == captions.FETCHED
    assert video.sponsor_checked_at is None  # the backfill asks again later


def test_backfill_asks_about_older_videos_newest_first(session, init_db, sponsor_api):
    channel = _channel(session)
    older = _video(session, channel, "olderolder1", position=5)
    newer = _video(session, channel, "newernewer1", position=0)
    paused = _channel(session, status=KbChannelStatus.paused, channel_url="x")
    _video(session, paused, "pausedvideo")
    pacer = init_db["ctx"].knowledge.sponsor
    assert sponsorblock.step()
    assert not sponsorblock.step()  # spaced out
    pacer._next_at = 0.0
    assert sponsorblock.step()
    pacer._next_at = 0.0
    assert not sponsorblock.step()  # a paused channel's video waits
    asked = [r.url.params["videoID"] for r in sponsor_api["calls"]]
    assert asked == [newer.yt_id, older.yt_id]


def test_relisting_asks_again_about_recent_videos(
    session, init_db, sponsor_api, monkeypatch
):
    channel = _channel(session, last_listed_at=datetime(2020, 1, 1, tzinfo=UTC))
    now = datetime.now(UTC)
    two_days_ago = now - timedelta(days=2)
    recent = _video(
        session, channel, "recentvideo", published_at=now.date().isoformat()
    )
    old = _video(session, channel, "oldvideo123", published_at="2019-05-01")
    just_checked = _video(
        session, channel, "justchecked", published_at=now.date().isoformat()
    )
    for video, checked in ((recent, two_days_ago), (old, two_days_ago)):
        video.sponsor_checked_at = checked
        video.sponsor_segments = '[[1.0, 2.0, "sponsor"]]'
        session.add(video)
    just_checked.sponsor_checked_at = now
    session.add(just_checked)
    session.commit()
    found = listing.Listing(
        channel_name="Huberman Lab",
        uploads=[
            listing.Upload(v.yt_id, v.title, v.published_at, None, False, i)
            for i, v in enumerate((recent, old, just_checked))
        ],
    )
    monkeypatch.setattr(listing, "list_channel", lambda *a, **k: found)
    assert worker.list_due_channel()
    for video in (recent, old, just_checked):
        session.refresh(video)
    assert recent.sponsor_checked_at is None
    # Its old segments stay in use until the new answer.
    assert recent.sponsor_segments
    assert as_utc(old.sponsor_checked_at) == pytest.approx(
        two_days_ago, abs=timedelta(seconds=1)
    )
    assert just_checked.sponsor_checked_at is not None
    assert sponsorblock.step()
    assert sponsor_api["calls"][0].url.params["videoID"] == "recentvideo"


# --- answers and search --------------------------------------------------------


def _ads(session: Session, video: KbVideo, *spans: tuple[float, float]) -> None:
    video.sponsor_segments = json.dumps([[s, e, "sponsor"] for s, e in spans])
    video.sponsor_checked_at = datetime.now(UTC)
    session.add(video)
    session.commit()


def _excerpts(session, init_db, channel, terms):
    return retrieval.retrieve(
        session,
        init_db["ctx"].knowledge.vectors,
        [channel],
        "how much protein should I eat?",
        retrieval.Expansion(terms=terms),
        budget_chars=60000,
    )


def test_ad_passages_are_left_out_of_answers(session, init_db):
    channel = _channel(session)
    video = _video(session, channel, "abcdefghijk", title="Protein")
    before = _excerpts(session, init_db, channel, ["protein"])
    assert any("david" in e.text for e in before)  # without segments it is cited
    _ads(session, video, (90, 171))
    after = _excerpts(session, init_db, channel, ["protein"])
    assert after, "the real talk about protein stays"
    assert any("one point six grams" in e.text for e in after)
    assert not any("david" in e.text for e in after)
    for e in after:  # every excerpt still points at its own words
        assert not sponsorblock.mostly_ad(
            e.start_sec, e.end_sec, sponsorblock.parse(video.sponsor_segments)
        )


def test_a_passage_partly_inside_an_ad_keeps_the_rest(session, init_db):
    channel = _channel(session)
    video = _video(session, channel, "abcdefghijk")
    passages = chunking.build_passages(chunking.unpack_lines(video.cues))
    # A short ad (20 s) inside the first passage.
    first = passages[0]
    start = first.start_sec + 30
    _ads(session, video, (start, start + 20))
    [kept] = [
        e
        for e in _excerpts(session, init_db, channel, ["welcome", "show"])
        if e.start_sec == pytest.approx(first.start_sec)
    ]
    assert "welcome to the show" in kept.text
    for line_start in range(int(start), int(start) + 18, 3):
        assert f"show {line_start} " not in f"{kept.text} "
    assert f"show {int(start) - 3}" in kept.text
    assert f"show {int(start) + 21}" in kept.text


def test_said_in_videos_skips_ad_reads(client, session):
    channel = _channel(session)
    video = _video(session, channel, "abcdefghijk")
    r = client.get("/api/ask/search", params={"q": "david bars"})
    assert r.json()["items"], r.text
    _ads(session, video, (90, 171))
    r = client.get("/api/ask/search", params={"q": "david bars"})
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []
    r = client.get("/api/ask/search", params={"q": "kilogram"})
    assert r.json()["items"]


# --- helpers -------------------------------------------------------------------


def test_overlapping_segments_merge():
    spans = sponsorblock.parse('[[10, 20, "sponsor"], [15, 30, "selfpromo"]]')
    assert spans == [(10.0, 30.0)]
    assert sponsorblock.ad_share(0, 40, spans) == pytest.approx(0.5)
    assert sponsorblock.mostly_ad(0, 40, spans)
    assert not sponsorblock.mostly_ad(0, 41, spans)
    assert sponsorblock.parse("not json") == []


def test_millisecond_bounds_keep_exactly_the_passages_lines():
    """Stored lines are rounded to 1/100 s; passage bounds come from the VTT."""
    lines = [(0.0, "a"), (5.0, "b"), (10.0, "ad"), (15.0, "c"), (78.1, "next")]
    kept = sponsorblock.without_ads(lines, 0.0, 78.104, [(10.0, 15.0)])
    assert kept is not None
    assert kept[2] == "a b c"  # not the next passage's first line
    kept = sponsorblock.without_ads(
        [(198.26, "first"), (204.27, "ad"), (210.0, "last")],
        198.264,
        215.0,
        [(204.0, 209.0)],
    )
    assert kept is not None
    assert kept[0] == pytest.approx(198.264) and kept[2] == "first last"


def test_a_video_that_keeps_failing_does_not_stall_the_backfill(
    session, init_db, sponsor_api
):
    channel = _channel(session)
    bad = _video(session, channel, "badbadbad01", position=0)
    good = _video(session, channel, "goodgood001", position=1)
    sponsor_api["reply"] = lambda r: httpx.Response(
        500 if r.url.params["videoID"] == bad.yt_id else 404
    )
    pacer = init_db["ctx"].knowledge.sponsor
    for _ in range(3):
        pacer._next_at = 0.0
        assert sponsorblock.step()
    asked = [r.url.params["videoID"] for r in sponsor_api["calls"]]
    assert asked == [bad.yt_id, good.yt_id, bad.yt_id]
    session.refresh(good)
    assert good.sponsor_checked_at is not None


def test_said_in_videos_keeps_a_hit_that_also_matches_outside_the_ad(client, session):
    channel = _channel(session)
    video = _video(
        session,
        channel,
        "abcdefghijk",
        _vtt(
            60,
            lambda s: (
                "david protein bar ad"
                if s == 30
                else "protein research talk"
                if s == 45
                else "filler"
            ),
        ),
    )
    _ads(session, video, (29, 34))
    [hit] = client.get("/api/ask/search", params={"q": "protein"}).json()["items"]
    assert hit["start_sec"] == pytest.approx(40.0)  # the talk, not the ad at 28

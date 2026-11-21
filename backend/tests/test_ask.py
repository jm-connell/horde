"""Ask (channel knowledge): channel management, caption indexing and keyword search."""

from __future__ import annotations

import pytest
from sqlmodel import Session, col, select

from app.models import KbChannel, KbChannelStatus, KbChunk, KbVideo
from app.services.knowledge import (
    captions,
    chunking,
    indexing,
    listing,
    moments,
    worker,
)
from app.services.knowledge import search as kb_search

# YouTube auto-captions repeat the previous line at the top of each cue.
ROLLING_VTT = """WEBVTT

00:00:01.000 --> 00:00:03.000
the 4runner has a timing belt

00:00:03.000 --> 00:00:06.000
the 4runner has a timing belt
so change it every ninety thousand

00:00:06.000 --> 00:00:09.000
so change it every ninety thousand
miles or the engine is done
"""


def _long_vtt(seconds: int, words_per_cue: str = "word") -> str:
    out = ["WEBVTT", ""]
    for s in range(0, seconds, 3):
        out += [
            f"00:{s // 60:02d}:{s % 60:02d}.000 --> 00:{(s + 3) // 60:02d}:{(s + 3) % 60:02d}.000",
            f"{words_per_cue} {s}",
            "",
        ]
    return "\n".join(out)


# --- chunking ------------------------------------------------------------------


def test_caption_lines_drop_rolling_repeats():
    lines = chunking.lines_from_vtt(ROLLING_VTT)
    joined = " ".join(t for _, t in lines)
    assert joined.count("timing belt") == 1
    assert joined.count("ninety thousand") == 1
    assert "engine is done" in joined
    assert lines[0][0] == pytest.approx(1.0)


def test_passages_overlap_and_keep_time():
    lines = chunking.lines_from_vtt(_long_vtt(300))
    passages = chunking.build_passages(lines)
    assert len(passages) >= 4
    for a, b in zip(passages, passages[1:], strict=False):
        assert b.start_sec < a.end_sec  # overlapping
        assert b.start_sec > a.start_sec  # always moving on
        assert (
            a.end_sec - a.start_sec <= chunking.PASSAGE_SEC + chunking.LINE_WINDOW_SEC
        )
    assert passages[0].start_sec == pytest.approx(0.0)


def test_lines_round_trip():
    lines = [(1.5, "hello"), (6.0, "wörld")]
    assert chunking.unpack_lines(chunking.pack_lines(lines)) == lines


# --- query building ------------------------------------------------------------


def test_match_expression_quotes_every_term():
    expr = kb_search.match_expression(['4Runner"); DROP TABLE x; --', "NEAR(a b)"])
    assert expr is not None
    assert "DROP" not in expr.split('"')[0]
    for part in expr.split(" OR "):
        assert part.startswith('"')


def test_match_expression_keeps_phrases_and_drops_stopwords():
    expr = kb_search.match_expression(
        kb_search.query_terms('what does he say about "for runner" gaskets')
    )
    assert expr == '"for runner" OR "gasket"*'


def test_terms_match_other_endings_of_their_last_word():
    """ "Dopamine fasting" missed a podcast's "the dopamine fast"; no stemmer
    in the index, so a term's last word is cut to its stem and prefixed."""
    expr = kb_search.match_expression(
        ["dopamine fasting", "recommended", "batteries", "oil change", "torque"]
    )
    assert expr == (
        '"dopamine fast"* OR "recommend"* OR "batter"* OR "oil change" OR "torque"*'
    )
    # Short words are left alone: "string" is not "str".
    assert kb_search.match_expression(["string"]) == '"string"*'


def test_match_expression_empty_when_only_stopwords():
    assert kb_search.match_expression(["what", "the", "?"]) is None


# --- helpers -------------------------------------------------------------------


def _channel(session: Session, **fields) -> KbChannel:
    channel = KbChannel(
        channel_url=fields.pop("channel_url", "https://youtube.com/@carcarenut"),
        channel_name=fields.pop("channel_name", "The Car Care Nut"),
        status=fields.pop("status", KbChannelStatus.indexing),
        **fields,
    )
    session.add(channel)
    session.commit()
    session.refresh(channel)
    return channel


def _video(session: Session, channel: KbChannel, yt_id: str, **fields) -> KbVideo:
    assert channel.id is not None
    video = KbVideo(kb_channel_id=channel.id, yt_id=yt_id, **fields)
    session.add(video)
    session.commit()
    session.refresh(video)
    return video


def _index(session: Session, video: KbVideo, vtt: str = ROLLING_VTT) -> None:
    indexing.apply_result(
        session, video, captions.CaptionResult(captions.FETCHED, vtt=vtt)
    )


# --- indexing ------------------------------------------------------------------


def test_fetched_captions_become_searchable_passages(session):
    channel = _channel(session)
    video = _video(session, channel, "abcdefghijk", title="4Runner maintenance")
    _index(session, video)
    session.refresh(video)
    assert video.fetch_status == captions.FETCHED
    assert chunking.unpack_lines(video.cues)
    hits = kb_search.search(session, ["timing belt"], channel_ids=None, limit=10)
    assert len(hits) == 1
    assert hits[0].start_sec == pytest.approx(1.0)
    assert kb_search.MARK_START in hits[0].snippet
    # The title is searchable too, as the metadata passage.
    meta = kb_search.search(session, ["maintenance"], channel_ids=None, limit=10)
    assert [h.chunk_index for h in meta] == [chunking.META_CHUNK_INDEX]


def test_reindexing_replaces_passages_and_fts(session):
    channel = _channel(session)
    video = _video(session, channel, "abcdefghijk")
    _index(session, video)
    _index(session, video, ROLLING_VTT.replace("timing belt", "water pump"))
    assert not kb_search.search(session, ["timing belt"], channel_ids=None, limit=10)
    assert kb_search.search(session, ["water pump"], channel_ids=None, limit=10)


def test_rate_limit_backs_off_and_failures_give_up(session):
    channel = _channel(session)
    video = _video(session, channel, "abcdefghijk")
    backoff = indexing.apply_result(
        session, video, captions.CaptionResult(captions.RETRY)
    )
    assert backoff and backoff > 0
    assert video.fetch_status == indexing.PENDING and video.next_attempt_at
    for _ in range(indexing.MAX_ATTEMPTS):
        indexing.apply_result(session, video, captions.CaptionResult(captions.FAILED))
    assert video.fetch_status == captions.FAILED


def test_channel_becomes_ready_when_nothing_is_pending(session):
    channel = _channel(session)
    video = _video(session, channel, "abcdefghijk")
    assert channel.id is not None
    indexing.finish_if_done(session, channel.id)
    session.refresh(channel)
    assert channel.status == KbChannelStatus.indexing
    _index(session, video)
    indexing.finish_if_done(session, channel.id)
    session.refresh(channel)
    assert channel.status == KbChannelStatus.ready


def test_search_filters_by_channel(session):
    a = _channel(session)
    b = _channel(
        session, channel_url="https://youtube.com/@other", channel_name="Other"
    )
    _index(session, _video(session, a, "aaaaaaaaaaa"))
    _index(session, _video(session, b, "bbbbbbbbbbb"))
    assert a.id is not None
    hits = kb_search.search(session, ["timing"], channel_ids=[a.id], limit=10)
    assert {h.kb_channel_id for h in hits} == {a.id}
    assert kb_search.search(session, ["timing"], channel_ids=[], limit=10) == []


# --- worker --------------------------------------------------------------------


def test_worker_lists_a_new_channel(session, monkeypatch):
    channel = _channel(session, status=KbChannelStatus.queued)
    found = listing.Listing(
        channel_name="The Car Care Nut",
        uploads=[
            listing.Upload(
                "aaaaaaaaaaa", "Newest", "2025-01-01T00:00:00Z", 600.0, False, 0
            ),
            listing.Upload("bbbbbbbbbbb", "Older", None, None, False, 1),
        ],
    )
    monkeypatch.setattr(listing, "list_channel", lambda *a, **k: found)
    assert worker.list_due_channel()
    session.refresh(channel)
    assert channel.status == KbChannelStatus.indexing
    assert channel.last_listed_at is not None
    rows = session.exec(select(KbVideo).order_by(col(KbVideo.position))).all()
    assert [r.yt_id for r in rows] == ["aaaaaaaaaaa", "bbbbbbbbbbb"]
    assert not worker.list_due_channel()  # not due again for a day


def test_worker_records_a_listing_error(session, monkeypatch):
    channel = _channel(session, status=KbChannelStatus.queued)

    def boom(*a, **k):
        raise RuntimeError("ERROR: This channel does not exist")

    monkeypatch.setattr(listing, "list_channel", boom)
    assert worker.list_due_channel()
    session.refresh(channel)
    assert channel.status == KbChannelStatus.error
    assert channel.last_error


def test_worker_reads_library_captions_without_youtube(
    session, add_video, init_db, monkeypatch
):
    path = "Nut/2024/Belt [abcdefghijk].en.vtt"
    dest = init_db["downloads"] / path
    dest.parent.mkdir(parents=True)
    dest.write_text(ROLLING_VTT)
    add_video(
        yt_id="abcdefghijk",
        source_url="https://www.youtube.com/watch?v=abcdefghijk",
        subtitles=f'[{{"lang": "en", "path": "{path}", "auto": true}}]',
    )
    channel = _channel(session)
    _video(session, channel, "abcdefghijk")
    monkeypatch.setattr(
        captions, "fetch_remote", lambda yt_id: pytest.fail("must not reach YouTube")
    )
    init_db["ctx"].timedtext.block(600)  # even while YouTube is backed off
    assert worker.fetch_next_video()
    video = session.exec(select(KbVideo)).one()
    session.refresh(video)
    assert video.fetch_status == captions.FETCHED
    assert video.caption_auto is True


def test_worker_waits_for_the_pacer_and_library_retries(session, init_db, monkeypatch):
    channel = _channel(session)
    _video(session, channel, "abcdefghijk")
    calls: list[str] = []
    monkeypatch.setattr(
        captions,
        "fetch_remote",
        lambda yt_id: (
            calls.append(yt_id) or captions.CaptionResult(captions.NO_CAPTIONS)
        ),
    )
    pacer = init_db["ctx"].timedtext
    pacer.block(60)
    assert not worker.fetch_next_video()
    assert calls == []

    pacer._blocked_until = None
    monkeypatch.setattr(worker, "next_due_video", lambda s: object())
    assert not worker.fetch_next_video()
    assert calls == []

    monkeypatch.setattr(worker, "next_due_video", lambda s: None)
    assert worker.fetch_next_video()
    assert calls == ["abcdefghijk"]
    assert pacer.seconds_blocked() == 0  # background fetches never block library work


def test_worker_rate_limit_blocks_everyone(session, init_db, monkeypatch):
    channel = _channel(session)
    _video(session, channel, "abcdefghijk")
    monkeypatch.setattr(worker, "next_due_video", lambda s: None)
    monkeypatch.setattr(
        captions, "fetch_remote", lambda yt_id: captions.CaptionResult(captions.RETRY)
    )
    assert worker.fetch_next_video()
    assert init_db["ctx"].timedtext.seconds_blocked() > 0


def test_paused_channels_are_not_fetched(session, monkeypatch):
    channel = _channel(session, status=KbChannelStatus.paused)
    _video(session, channel, "abcdefghijk")
    monkeypatch.setattr(worker, "next_due_video", lambda s: None)
    assert not worker.fetch_next_video()


def test_recover_restarts_cut_off_listings(session):
    channel = _channel(session, status=KbChannelStatus.listing)
    assert worker.recover() == 1
    session.refresh(channel)
    assert channel.status == KbChannelStatus.queued


# --- API -----------------------------------------------------------------------


@pytest.fixture
def fake_preview(monkeypatch):
    def preview(url: str) -> listing.Preview:
        return listing.Preview(
            channel_name="The Car Care Nut",
            channel_url="https://www.youtube.com/@TheCarCareNut",
            video_count=412,
            has_streams=True,
        )

    monkeypatch.setattr(listing, "preview", preview)


def test_preview_and_add_channel(client, fake_preview, init_db):
    r = client.get("/api/ask/channels/preview", params={"url": "@TheCarCareNut"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["channel_url"] == "https://youtube.com/@thecarcarenut"
    assert body["has_streams"] is True and body["existing_id"] is None

    r = client.post("/api/ask/channels", json={"url": "@TheCarCareNut"})
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["status"] == "queued"
    assert created["include_streams"] is False
    assert init_db["ctx"].knowledge.wake.is_set()

    again = client.post(
        "/api/ask/channels",
        json={"url": "https://www.youtube.com/@thecarcarenut/videos"},
    )
    assert again.status_code == 409
    assert again.json()["code"] == "exists"
    preview = client.get("/api/ask/channels/preview", params={"url": "@TheCarCareNut"})
    assert preview.json()["existing_id"] == created["id"]


@pytest.mark.parametrize(
    "url",
    ["https://example.com/@x", "https://www.youtube.com/watch?v=abcdefghijk", "hello"],
)
def test_add_channel_rejects_non_channels(client, url):
    r = client.post("/api/ask/channels", json={"url": url})
    assert r.status_code == 400
    assert r.json()["code"] == "invalid_channel"


def test_list_channels_counts_progress(client, session):
    channel = _channel(session)
    _index(session, _video(session, channel, "aaaaaaaaaaa"))
    _video(session, channel, "bbbbbbbbbbb")
    _video(session, channel, "ccccccccccc", fetch_status=captions.MEMBERS_ONLY)
    r = client.get("/api/ask/channels")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    [item] = body["items"]
    assert (item["videos"], item["fetched"], item["pending"], item["unavailable"]) == (
        3,
        1,
        1,
        1,
    )
    assert item["passages"] >= 1


def test_members_see_a_generic_error(member_client, session):
    _channel(
        session,
        status=KbChannelStatus.error,
        last_error="ERROR: http://proxy:9 refused",
    )
    [item] = member_client.get("/api/ask/channels").json()["items"]
    assert "proxy" not in item["last_error"]


def test_turning_streams_off_removes_them(client, session):
    channel = _channel(session, include_streams=True)
    _index(session, _video(session, channel, "aaaaaaaaaaa"))
    _index(session, _video(session, channel, "sssssssssss", is_stream=True))
    r = client.patch(f"/api/ask/channels/{channel.id}", json={"include_streams": False})
    assert r.status_code == 200, r.text
    assert [v.yt_id for v in session.exec(select(KbVideo)).all()] == ["aaaaaaaaaaa"]
    hits = kb_search.search(session, ["timing"], channel_ids=None, limit=10)
    assert len(hits) == 1

    r = client.patch(f"/api/ask/channels/{channel.id}", json={"include_streams": True})
    assert r.json()["status"] == "queued"  # listed again to find the streams


def test_pause_resume_and_remove(client, session):
    channel = _channel(session)
    _index(session, _video(session, channel, "aaaaaaaaaaa"))
    assert (
        client.post(f"/api/ask/channels/{channel.id}/pause").json()["status"]
        == "paused"
    )
    assert (
        client.post(f"/api/ask/channels/{channel.id}/resume").json()["status"]
        == "queued"
    )
    assert client.delete(f"/api/ask/channels/{channel.id}").status_code == 204
    assert session.exec(select(KbChannel)).all() == []
    assert session.exec(select(KbChunk)).all() == []
    assert kb_search.search(session, ["timing"], channel_ids=None, limit=10) == []
    assert client.delete(f"/api/ask/channels/{channel.id}").status_code == 404


def test_search_endpoint_links_the_library_copy(client, session, add_video):
    channel = _channel(session)
    _index(session, _video(session, channel, "aaaaaaaaaaa", title="Maintenance"))
    for i in range(3):
        _index(session, _video(session, channel, f"zzzzzzzzzz{i}"))
    lib = add_video(yt_id="aaaaaaaaaaa", source_url="https://youtu.be/aaaaaaaaaaa")
    r = client.get("/api/ask/search", params={"q": "timing belt", "limit": 2})
    assert r.status_code == 200, r.text
    page = r.json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    rest = client.get(
        "/api/ask/search",
        params={"q": "timing belt", "limit": 2, "cursor": page["next_cursor"]},
    ).json()
    assert len(rest["items"]) == 2 and rest["next_cursor"] is None
    by_id = {i["yt_id"]: i for i in page["items"] + rest["items"]}
    assert by_id["aaaaaaaaaaa"]["library_video_id"] == lib.id
    assert by_id["aaaaaaaaaaa"]["channel_name"] == "The Car Care Nut"
    # The card's channel name opens the channel page, which needs its URL.
    assert by_id["aaaaaaaaaaa"]["channel_url"].startswith("https://youtube.com/@")


def test_search_endpoint_survives_hostile_queries(client, session):
    _index(session, _video(session, _channel(session), "aaaaaaaaaaa"))
    for q in [
        '"',
        "AND OR NOT",
        "*",
        "NEAR(",
        "timing\x00belt",
        "'; DROP TABLE kb_chunks; --",
    ]:
        r = client.get("/api/ask/search", params={"q": q})
        assert r.status_code == 200, (q, r.text)


# --- exact moments -------------------------------------------------------------


def test_moment_finds_the_line_inside_a_passage():
    lines = [
        (0.0, "intro talk"),
        (5.0, "more intro"),
        (50.0, "the timing belt snapped"),
    ]
    assert moments.moment(lines, 0.0, 75.0, {"timing", "belt"}) == pytest.approx(48.0)
    # No match: the passage start. Lines outside the passage never count.
    assert moments.moment(lines, 0.0, 40.0, {"timing"}) == 0.0
    assert moments.moment(lines, 0.0, 75.0, set()) == 0.0


def test_moment_matches_word_endings():
    lines = [(0.0, "hello"), (30.0, "both gaskets leaked")]
    assert moments.moment(lines, 0.0, 75.0, moments.words("gasket")) == pytest.approx(
        28.0
    )


def test_search_links_to_the_matching_line(client, session):
    vtt = "WEBVTT\n\n" + "\n".join(
        f"00:00:{s:02d}.000 --> 00:00:{s + 3:02d}.000\n"
        + ("the head gasket blew" if s == 42 else f"filler {s}")
        + "\n"
        for s in range(0, 60, 3)
    )
    _index(session, _video(session, _channel(session), "aaaaaaaaaaa"), vtt)
    [hit] = client.get("/api/ask/search", params={"q": "head gasket"}).json()["items"]
    assert hit["start_sec"] == pytest.approx(40.0, abs=5.0)


# --- review regressions ----------------------------------------------------------


def test_turning_streams_off_during_a_listing_discards_it(client, session, monkeypatch):
    channel = _channel(session, status=KbChannelStatus.queued, include_streams=True)
    found = listing.Listing(
        uploads=[listing.Upload("sssssssssss", "Stream", None, None, True, 0)]
    )

    def slow_listing(*a, **k):
        # The user turns streams off while the listing runs.
        r = client.patch(
            f"/api/ask/channels/{channel.id}", json={"include_streams": False}
        )
        assert r.status_code == 200
        return found

    monkeypatch.setattr(listing, "list_channel", slow_listing)
    assert worker.list_due_channel()
    assert session.exec(select(KbVideo)).all() == []
    session.refresh(channel)
    assert channel.status == KbChannelStatus.queued  # listed again with the new choice


def test_pausing_during_a_listing_stays_paused(client, session, monkeypatch):
    channel = _channel(session, status=KbChannelStatus.queued)
    found = listing.Listing(
        uploads=[listing.Upload("aaaaaaaaaaa", "A", None, None, False, 0)]
    )

    def pause_then_list(*a, **k):
        assert client.post(f"/api/ask/channels/{channel.id}/pause").status_code == 200
        return found

    monkeypatch.setattr(listing, "list_channel", pause_then_list)
    worker.list_due_channel()
    session.refresh(channel)
    assert channel.status == KbChannelStatus.paused


def test_dense_timestamps_do_not_multiply_passages():
    lines = [(0.0, "word " * 30) for _ in range(100)]
    passages = chunking.build_passages(lines)
    # About 15,000 characters at 1,400 a passage, each line in one passage only
    # (it used to step one line at a time: 87 near-copies).
    assert len(passages) <= 12
    assert sum(len(p.text) for p in passages) < 16_000


def test_age_restricted_is_retried_and_rate_limits_give_up(session):
    channel = _channel(session)
    video = _video(session, channel, "abcdefghijk")
    for _ in range(indexing.MAX_RETRIES):
        indexing.apply_result(session, video, captions.CaptionResult(captions.RETRY))
    assert video.fetch_status == captions.FAILED


def test_search_caps_the_channel_list(client):
    r = client.get("/api/ask/search", params={"q": "x", "channel_id": list(range(60))})
    assert r.status_code == 422


def test_search_endpoint_covers_every_channel_unless_one_is_chosen(client, session):
    nut = _channel(session)
    fix = _channel(
        session, channel_url="https://youtube.com/@chrisfix", channel_name="ChrisFix"
    )
    _index(session, _video(session, nut, "aaaaaaaaaaa"))
    _index(session, _video(session, fix, "bbbbbbbbbbb"))
    everything = client.get("/api/ask/search", params={"q": "timing belt"}).json()[
        "items"
    ]
    assert {h["channel_name"] for h in everything} == {"The Car Care Nut", "ChrisFix"}
    one = client.get(
        "/api/ask/search", params={"q": "timing belt", "channel_id": fix.id}
    ).json()["items"]
    assert {h["channel_name"] for h in one} == {"ChrisFix"}


def test_turning_ask_on_subscribes_whoever_did_it(client, fake_preview):
    """Asking a channel and then not finding it anywhere in Horde was
    disorienting: an indexed channel had no place outside Settings."""
    url = "https://youtube.com/@thecarcarenut"

    def subscribed() -> list[tuple[str, str]]:
        items = client.get("/api/follows").json()["items"]
        return [(i["channel_url"], i["source"]) for i in items]

    created = client.post("/api/ask/channels", json={"url": "@TheCarCareNut"}).json()
    assert subscribed() == [(url, "ask")]

    # Unsubscribing is the user's choice: turning Ask on again leaves it.
    r = client.request("DELETE", "/api/follows", params={"channel_url": url})
    assert r.status_code == 200, r.text
    assert client.delete(f"/api/ask/channels/{created['id']}").status_code == 204
    assert (
        client.post("/api/ask/channels", json={"url": "@TheCarCareNut"}).status_code
        == 201
    )
    assert subscribed() == []


# The real look-up: conftest swaps it for one that refuses to read YouTube.
_REAL_PREVIEW = listing.preview


def test_a_channel_youtube_does_not_have_is_not_found(client, monkeypatch):
    """The feed fetch ignores YouTube's 404, so a mistyped handle came back as
    a nameless channel with no uploads, was added, and showed as ready."""
    monkeypatch.setattr(listing, "preview", _REAL_PREVIEW)
    monkeypatch.setattr(
        listing,
        "_page",
        lambda *a, **k: {"channel": None, "entries": [], "has_more": False},
    )
    r = client.get("/api/ask/channels/preview", params={"url": "@nosuchchannel"})
    assert r.status_code == 404 and r.json()["code"] == "not_found"
    with pytest.raises(listing.ChannelNotFound):
        listing.list_channel(
            "https://youtube.com/@nosuchchannel", include_streams=False, max_videos=5
        )


def test_channels_are_indexed_in_turn_newest_first(session):
    """Added together, the last channel waited for every video of the others."""
    from app.services.knowledge import worker

    first = _channel(
        session, channel_url="https://youtube.com/@first", channel_name="First"
    )
    second = _channel(
        session, channel_url="https://youtube.com/@second", channel_name="Second"
    )
    for channel in (first, second):
        for position in range(3):
            session.add(
                KbVideo(
                    kb_channel_id=channel.id,
                    yt_id=f"{channel.channel_name}{position}"[:11].ljust(11, "x"),
                    position=position,
                )
            )
    session.commit()
    order = []
    for _ in range(4):
        video = worker._next_video(session)
        assert video is not None
        order.append((video.kb_channel_id, video.position))
        video.fetch_status = "fetched"
        session.add(video)
        session.commit()
    assert order == [(first.id, 0), (second.id, 0), (first.id, 1), (second.id, 1)]


# --- how much of a channel is indexed ------------------------------------------


def _uploads(n: int, first: int = 0) -> list[listing.Upload]:
    return [
        listing.Upload(f"v{first + i:010d}", f"Video {first + i}", None, None, False, i)
        for i in range(n)
    ]


def test_listing_asks_for_the_limit_in_force(session, monkeypatch, client):
    own = _channel(session, status=KbChannelStatus.queued, max_videos=80)
    asked: list[int] = []

    def fake(url, *, include_streams, max_videos):
        asked.append(max_videos)
        return listing.Listing(channel_name="x", uploads=[])

    monkeypatch.setattr(listing, "list_channel", fake)
    assert worker.list_due_channel()
    session.refresh(own)
    own.max_videos = None
    own.status = KbChannelStatus.queued
    session.add(own)
    session.commit()
    assert worker.list_due_channel()
    assert asked == [80, 500]  # its own, then the app-wide default


def test_lowering_the_limit_deletes_the_videos_beyond_it(client, session, monkeypatch):
    channel = _channel(session, status=KbChannelStatus.queued)
    monkeypatch.setattr(
        listing,
        "list_channel",
        lambda url, *, include_streams, max_videos: listing.Listing(
            channel_name="x", uploads=_uploads(120)[:max_videos]
        ),
    )
    assert worker.list_due_channel()
    oldest = session.exec(select(KbVideo).where(KbVideo.position == 119)).one()
    _index(session, oldest)
    assert kb_search.search(session, ["timing"], channel_ids=None, limit=10)

    r = client.patch(f"/api/ask/channels/{channel.id}", json={"max_videos": 50})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["max_videos"], body["limit"], body["status"]) == (50, 50, "queued")
    assert worker.list_due_channel()
    session.expire_all()
    rows = session.exec(select(KbVideo)).all()
    assert len(rows) == 50 and max(r.position for r in rows) == 49
    assert kb_search.search(session, ["timing"], channel_ids=None, limit=10) == []

    # Back to the app-wide limit: the older videos are listed again.
    r = client.patch(f"/api/ask/channels/{channel.id}", json={"max_videos": None})
    assert (r.json()["max_videos"], r.json()["limit"]) == (None, 500)
    assert worker.list_due_channel()
    assert len(session.exec(select(KbVideo)).all()) == 120


def test_a_video_youtube_stopped_listing_is_kept_within_the_limit(session):
    channel = _channel(session)
    indexing.apply_listing(session, channel, listing.Listing(uploads=_uploads(3)), 500)
    indexing.apply_listing(
        session, channel, listing.Listing(uploads=_uploads(2, first=1)), 500
    )
    assert len(session.exec(select(KbVideo)).all()) == 3


def test_limit_is_validated_and_needs_the_permission(client, member_client, session):
    channel = _channel(session)
    url = f"/api/ask/channels/{channel.id}"
    assert client.patch(url, json={"max_videos": 10}).status_code == 422
    assert client.patch(url, json={"max_videos": 5001}).status_code == 422
    assert member_client.patch(url, json={"max_videos": 100}).status_code == 403
    # Changing only the limit leaves the streams choice alone.
    assert client.patch(url, json={"max_videos": 100}).json()["include_streams"] is (
        False
    )


def test_changing_the_app_wide_limit_lists_its_channels_again(client, session):
    follows_default = _channel(session, status=KbChannelStatus.ready)
    own = _channel(
        session,
        channel_url="https://youtube.com/@own",
        status=KbChannelStatus.ready,
        max_videos=80,
    )
    paused = _channel(
        session,
        channel_url="https://youtube.com/@paused",
        status=KbChannelStatus.paused,
    )
    r = client.patch("/api/settings", json={"ask_max_videos": 200})
    assert r.status_code == 200, r.text
    assert r.json()["ask_max_videos"] == 200
    for row in (follows_default, own, paused):
        session.refresh(row)
    assert follows_default.status == KbChannelStatus.queued
    assert own.status == KbChannelStatus.ready
    assert paused.status == KbChannelStatus.paused
    items = {c["id"]: c for c in client.get("/api/ask/channels").json()["items"]}
    assert items[follows_default.id]["limit"] == 200
    assert items[own.id]["limit"] == 80
    # Saving the same number again lists nothing.
    follows_default.status = KbChannelStatus.ready
    session.add(follows_default)
    session.commit()
    client.patch("/api/settings", json={"ask_max_videos": 200})
    session.refresh(follows_default)
    assert follows_default.status == KbChannelStatus.ready


def test_channel_total_comes_from_the_catalog_or_a_short_listing(client, session):
    from app.models import ChannelCatalog

    capped = _channel(session, max_videos=50)
    whole = _channel(session, channel_url="https://youtube.com/@whole", max_videos=50)
    unknown = _channel(session, channel_url="https://youtube.com/@unknown")
    for channel, n in ((capped, 50), (whole, 12)):
        channel.last_listed_at = channel.created_at
        session.add(channel)
        session.commit()
        indexing.apply_listing(
            session,
            channel,
            listing.Listing(uploads=_uploads(n, first=channel.id * 1000)),
            50,
        )
    session.add(
        ChannelCatalog(
            channel_url="https://www.youtube.com/@carcarenut", channel_total=2310
        )
    )
    session.commit()
    items = {c["id"]: c for c in client.get("/api/ask/channels").json()["items"]}
    assert items[capped.id]["channel_total"] == 2310
    assert items[whole.id]["channel_total"] == 12
    assert items[unknown.id]["channel_total"] is None


# --- subscriptions that predate automatic indexing -----------------------------


def test_existing_subscriptions_are_added_to_ask_once(session, admin_user, init_db):
    from app.services import app_settings, follows
    from app.services.knowledge import subscriptions

    have = _channel(session, channel_url="https://youtube.com/channel/UCcarcarenut01")
    follows.follow(session, admin_user.id, "https://www.youtube.com/@one", "One")
    # Ask has this one under its id: the same name by handle is the same channel.
    follows.follow(
        session, admin_user.id, "https://www.youtube.com/@carcarenut", have.channel_name
    )
    follows.follow(session, admin_user.id, "https://www.youtube.com/@gone", "Gone")
    follows.unfollow(session, admin_user.id, "https://www.youtube.com/@gone")

    assert subscriptions.add_subscribed_once() == 1
    rows = {c.channel_url: c for c in session.exec(select(KbChannel)).all()}
    assert set(rows) == {have.channel_url, "https://youtube.com/@one"}
    added = rows["https://youtube.com/@one"]
    assert added.status == KbChannelStatus.queued
    assert (added.channel_name, added.added_by) == ("One", admin_user.id)
    assert added.max_videos is None
    assert app_settings.load()["ask_subscriptions_indexed"] is True

    # Once: a channel turned off afterwards stays off.
    session.delete(added)
    session.commit()
    assert subscriptions.add_subscribed_once() == 0
    assert len(session.exec(select(KbChannel)).all()) == 1


def test_a_subscription_ask_already_has_under_another_address_is_dropped(
    session, monkeypatch
):
    have = _channel(session, channel_url="https://youtube.com/channel/UCsame0000001")
    alias = _channel(
        session,
        channel_url="https://youtube.com/@samechannel",
        channel_name=None,
        status=KbChannelStatus.queued,
    )
    monkeypatch.setattr(
        listing,
        "list_channel",
        lambda *a, **k: listing.Listing(
            channel_name="The Car Care Nut",
            channel_url="https://www.youtube.com/channel/UCsame0000001",
            uploads=_uploads(3),
        ),
    )
    have.last_listed_at = have.created_at
    session.add(have)
    session.commit()
    assert alias.id is not None
    assert worker.list_due_channel()
    session.expire_all()
    assert [c.id for c in session.exec(select(KbChannel)).all()] == [have.id]
    assert session.exec(select(KbVideo)).all() == []

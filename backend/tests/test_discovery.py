"""Recommended+: stream history, feedback, the gatherer and the mixed feed.

Vectors are tiny and hand made, as in ``test_recommend.py``: ``_vec(a)`` is a
unit vector at angle ``a`` in the plane of the first two axes, so closeness is
plain from the angles.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import select

from app.models import (
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    DiscoveryHit,
    DiscoveryVideo,
    UserStreamState,
    VideoEmbedding,
)
from app.services.ai import embeddings


def _vec(angle: float, axis: int = 0) -> list[float]:
    out = [0.0, 0.0, 0.0, 0.0]
    out[axis] = math.cos(angle)
    out[axis + 1] = math.sin(angle)
    return out


def _yt(yt_id: str) -> str:
    return f"https://www.youtube.com/watch?v={yt_id}"


@pytest.fixture
def ai_on(monkeypatch):
    """Embeddings count as available (vectors are written by the tests)."""
    for target in (
        "app.services.discovery.feed.get_embed_provider",
        "app.services.ai.provider.get_embed_provider",
    ):
        monkeypatch.setattr(target, lambda: object())


def _embed(session, video, vec):
    session.add(
        VideoEmbedding(
            video_id=video.id,
            chunk_index=-1,
            model="m",
            dim=len(vec),
            vector=embeddings.pack_vector(vec),
            content_hash="h",
        )
    )
    session.commit()


def _discovered(session, user, yt_id, title, channel, vec=None, **fields):
    row = DiscoveryVideo(
        yt_id=yt_id,
        url=_yt(yt_id),
        title=title,
        channel=channel,
        channel_url=f"https://www.youtube.com/@{channel.lower().replace(' ', '')}",
        embed_model="m" if vec else "",
        embed_dim=len(vec) if vec else 0,
        vector=embeddings.pack_vector(vec) if vec else b"",
        **fields,
    )
    session.add(row)
    session.commit()
    session.add(
        DiscoveryHit(
            user_id=user.id,
            discovery_video_id=row.id,
            source=fields.pop("source", "search") if False else "search",
            seed="q",
        )
    )
    session.commit()
    return row


def _feed(client, **params):
    body = client.get("/api/discover/feed", params=params).json()
    return body


def test_feed_starts_empty_and_marks_the_user_active(client, session, admin_user):
    from app.models import DiscoveryState

    body = _feed(client)
    assert body["items"] == []
    assert body["status"]["cold"] is True
    state = session.get(DiscoveryState, admin_user.id)
    assert state is not None and state.last_viewed_at is not None
    # The first visit asks for a run at once.
    assert state.requested_at is not None


def test_stream_watch_is_recorded_and_leaves_the_feed(
    client, session, admin_user, add_video
):
    resp = client.post(
        "/api/discover/history",
        json={
            "url": _yt("streamed001"),
            "title": "A stream",
            "channel": "Chan",
            "position_sec": 50,
            "duration_sec": 100,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "yt_id": "streamed001",
        "watched_sec": 50.0,
        "finished": False,
    }
    resp = client.post(
        "/api/discover/history",
        json={"url": _yt("streamed001"), "position_sec": 95, "duration_sec": 100},
    )
    assert resp.json()["finished"] is True
    row = session.get(UserStreamState, (admin_user.id, "streamed001"))
    session.refresh(row)
    assert row.title == "A stream" and row.finished_at is not None

    bad = client.post(
        "/api/discover/history",
        json={"url": "https://example.com/x", "position_sec": 1},
    )
    assert bad.status_code == 400
    assert bad.json()["code"] == "not_youtube_video"


def test_feed_pages_survive_the_cache(client, session, admin_user):
    """The ranked feed is cached between requests; its videos must stay readable,
    and a channel's videos past the new-channel cap still come, at the end."""
    for n in range(3):
        _discovered(session, admin_user, f"found{n:06d}", f"Found {n}", "Chan")
    first = client.get("/api/discover/feed", params={"limit": 2})
    assert first.status_code == 200, first.text
    again = client.get("/api/discover/feed", params={"limit": 2})
    assert again.json()["items"] == first.json()["items"]
    cursor = first.json()["next_cursor"]
    assert cursor
    more = client.get("/api/discover/feed", params={"cursor": cursor})
    assert more.status_code == 200, more.text
    keys = [i["key"] for i in first.json()["items"] + more.json()["items"]]
    assert sorted(keys) == ["found000000", "found000001", "found000002"]
    assert more.json()["next_cursor"] is None


# --- the mixed feed -----------------------------------------------------------


def _catalog(session, channel, rows):
    """An indexed channel; ``rows`` are (yt_id, title, days_old, vec)."""
    url = f"https://www.youtube.com/@{channel.lower()}"
    catalog = ChannelCatalog(
        channel_url=url, channel_name=channel, status=ChannelCatalogStatus.ready
    )
    session.add(catalog)
    session.commit()
    for pos, (yt_id, title, days_old, vec) in enumerate(rows):
        row = ChannelCatalogVideo(
            catalog_id=catalog.id,
            yt_id=yt_id,
            url=_yt(yt_id),
            title=title,
            duration=600.0,
            position=pos,
            published_at=(datetime.now(UTC) - timedelta(days=days_old)).strftime(
                "%Y%m%d"
            ),
        )
        session.add(row)
        session.commit()
        if vec is not None:
            session.add(
                ChannelCatalogEmbedding(
                    catalog_video_id=row.id,
                    model="m",
                    dim=len(vec),
                    vector=embeddings.pack_vector(vec),
                )
            )
            session.commit()
    return url


def _watched(session, add_video, set_watch, user, vec, *, channel, days_ago=1, **kw):
    video = add_video(channel=channel, **kw)
    _embed(session, video, vec)
    set_watch(user, video, 0, datetime.now(UTC) - timedelta(days=days_ago))
    return video


def _items(client, **params):
    body = client.get("/api/discover/feed", params={"limit": 60, **params}).json()
    return body["items"]


def test_feed_mixes_followed_uploads_similar_and_new_channels(
    client, session, add_video, set_watch, admin_user, ai_on
):
    from app.services import follows

    # Recent taste: two topics, x-axis (most) and the far side of the plane.
    for n in range(4):
        _watched(
            session,
            add_video,
            set_watch,
            admin_user,
            _vec(0.02 * n),
            channel="Lab",
            title=f"Lab {n}",
            yt_id=f"labwatched{n}",
        )
    _watched(
        session,
        add_video,
        set_watch,
        admin_user,
        _vec(0.0, axis=2),
        channel="Cook",
        title="Cook 0",
        yt_id="cookwatch00",
    )
    url = _catalog(
        session,
        "Lab",
        [
            ("labnewupl01", "Lab upload", 2, _vec(0.05)),
            ("laboldupl01", "Lab old", 400, _vec(0.04)),
        ],
    )
    follows.follow(session, admin_user.id, url, "Lab")
    _discovered(
        session, admin_user, "newlabvid01", "Close to Lab", "Stranger", _vec(0.03)
    )
    _discovered(
        session, admin_user, "newcookvid1", "Close to Cook", "Chef", _vec(0.01, axis=2)
    )
    _discovered(
        session, admin_user, "farawayvid1", "Unrelated", "Nobody", _vec(0.0, axis=1)
    )

    items = _items(client)
    by_key = {i["key"]: i for i in items}
    assert by_key["labnewupl01"]["reason"]["text"] == "New from Lab"
    assert by_key["labnewupl01"]["source"] == "channels"
    assert by_key["newlabvid01"]["reason"]["kind"] == "new_channel"
    assert by_key["newlabvid01"]["source"] == "new"
    assert by_key["newcookvid1"]["reason"]["kind"] == "new_channel"
    order = [i["key"] for i in items]
    # Relevant picks come before the unrelated one, which only fills the end.
    assert order.index("farawayvid1") > order.index("newcookvid1")
    assert order.index("farawayvid1") > order.index("newlabvid01")
    # Watched videos never come back.
    assert not {"labwatched0", "cookwatch00"} & set(order)


def test_feed_leaves_out_streamed_and_blocked_videos(
    client, session, admin_user, ai_on
):
    _discovered(session, admin_user, "streamedvid", "Seen as a stream", "Chan A")
    _discovered(session, admin_user, "blockedvid1", "Blocked", "Spam Channel")
    _discovered(session, admin_user, "keptvideo01", "Kept", "Chan B")
    client.post(
        "/api/discover/history",
        json={"url": _yt("streamedvid"), "position_sec": 30, "duration_sec": 600},
    )
    resp = client.post(
        "/api/discover/feedback",
        json={
            "kind": "channel",
            "key": "https://www.youtube.com/@spamchannel",
            "label": "Spam Channel",
        },
    )
    assert resp.status_code == 200, resp.text
    keys = [i["key"] for i in _items(client)]
    assert "keptvideo01" in keys
    assert "streamedvid" not in keys and "blockedvid1" not in keys

    # Undo brings the channel back.
    client.delete(f"/api/discover/feedback/{resp.json()['id']}")
    assert "blockedvid1" in [i["key"] for i in _items(client)]


def test_feedback_belongs_to_its_user(client, member_client, session, admin_user):
    row = client.post(
        "/api/discover/feedback",
        json={"kind": "video", "key": "abcdefghijk", "label": "x"},
    ).json()
    assert member_client.get("/api/discover/feedback").json()["items"] == []
    gone = member_client.delete(f"/api/discover/feedback/{row['id']}")
    assert gone.status_code == 404
    assert len(client.get("/api/discover/feedback").json()["items"]) == 1
    # The same feedback twice is one row.
    client.post(
        "/api/discover/feedback",
        json={"kind": "video", "key": "abcdefghijk", "label": "x"},
    )
    assert len(client.get("/api/discover/feedback").json()["items"]) == 1


def test_mix_follows_the_shares_and_spreads_channels():
    from app.services.discovery import feed
    from app.services.discovery.candidates import Candidate

    def items(bucket, n, channels):
        return [
            feed.FeedItem(
                Candidate(
                    key=f"{bucket}{i}",
                    pool="discovery",
                    title="",
                    channel=channels[i % len(channels)],
                    channel_url="",
                ),
                bucket,
                1.0 - i * 0.01,
                feed.Reason("x", "x"),
            )
            for i in range(n)
        ]

    out = feed.mix(
        {
            "subscriptions": items(
                "subscriptions", 40, ["S1", "S2", "S3", "S4", "S5", "S6"]
            ),
            "similar": items("similar", 40, ["M1", "M2", "M3", "M4", "M5", "M6"]),
            "new": items("new", 40, [f"N{i}" for i in range(20)]),
            "throwback": items("throwback", 40, ["T1", "T2", "T3", "T4", "T5", "T6"]),
        }
    )
    first = out[:40]
    counts = {b: sum(1 for i in first if i.bucket == b) for b in feed.SHARES}
    for bucket, share in feed.SHARES.items():
        assert abs(counts[bucket] - 40 * share) <= 2, counts
    # No channel twice within CHANNEL_GAP slots.
    names = [i.candidate.channel for i in out[:100]]
    for n in range(len(names) - feed.CHANNEL_GAP + 1):
        window = names[n : n + feed.CHANNEL_GAP]
        assert len(window) == len(set(window)), window
    # Throwbacks keep to their cap (3 per channel); the 22 past it wait at the end.
    assert len(out) == 160
    placed, overflow = out[:138], out[138:]
    for channel in ["T1", "T2", "T3", "T4", "T5", "T6"]:
        assert sum(1 for i in placed if i.candidate.channel == channel) == 3
    assert {i.bucket for i in overflow} == {"throwback"}


def test_an_empty_bucket_does_not_inflate_the_sprinkles():
    from app.services.discovery import feed

    shares = feed.effective_shares({"similar", "new", "throwback"})
    assert abs(sum(shares.values()) - 1) < 1e-9
    assert shares["new"] <= feed.SHARE_CAPS["new"]
    assert shares["throwback"] <= feed.SHARE_CAPS["throwback"]
    assert shares["similar"] > feed.SHARES["similar"]


def test_shown_videos_sink_over_visits(session, admin_user):
    from app.models import RecImpression
    from app.services.discovery import feedback

    feedback.record_shown(session, admin_user.id, ["aaaaaaaaaaa"])
    # The visit in progress does not count yet, and a second show in it is free.
    feedback.record_shown(session, admin_user.id, ["aaaaaaaaaaa"])
    assert feedback.earlier_visits(session, admin_user.id) == {}
    row = session.get(RecImpression, (admin_user.id, "aaaaaaaaaaa"))
    assert row.shown_count == 1
    row.last_shown_at = datetime.now(UTC) - timedelta(hours=3)
    session.add(row)
    session.commit()
    feedback.record_shown(session, admin_user.id, ["aaaaaaaaaaa"])
    session.refresh(row)
    assert row.shown_count == 2
    assert feedback.earlier_visits(session, admin_user.id) == {"aaaaaaaaaaa": 1}
    assert feedback.impression_penalty(1) > 0
    assert feedback.worn_out(feedback.IMPRESSION_CAP)


# --- the gatherer ---------------------------------------------------------------


def _entry(yt_id, title, channel="Found Channel"):
    return {
        "id": yt_id,
        "url": _yt(yt_id),
        "title": title,
        "channel": channel,
        "channel_url": f"https://www.youtube.com/@{channel.lower().replace(' ', '')}",
        "duration": 600,
        "view_count": 5000,
        "published_at": None,
        "description": "about it",
    }


@pytest.fixture
def youtube(monkeypatch):
    """Record the gatherer's YouTube requests and answer them from ``answers``."""
    from app.services.discovery import gather

    calls: list[tuple[str, str]] = []
    answers: dict[str, object] = {}

    def search(query, *, this_year, limit):
        calls.append(("search", query))
        result = answers.get(query, [_entry(f"s{len(calls):010d}", f"About {query}")])
        if isinstance(result, Exception):
            raise result
        return result

    def up_next(yt_id):
        calls.append(("related", yt_id))
        result = answers.get(yt_id, [_entry(f"r{len(calls):010d}", "Up next")])
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(gather, "search_youtube_for_discovery", search)
    monkeypatch.setattr(gather, "youtube_up_next", up_next)
    # No chat model here: searches come from the titles.
    monkeypatch.setattr(gather, "llm_queries", lambda groups: False)
    return calls, answers


def _history(session, add_video, set_watch, user):
    titles = [
        ("Racking a homelab server", "Alpha"),
        ("Homelab server power draw", "Alpha"),
        ("Proxmox homelab cluster build", "Beta"),
        ("Dovetail joints by hand", "Woody"),
        ("Hand cut dovetail joints", "Woody"),
    ]
    for n, (title, channel) in enumerate(titles):
        video = add_video(title=title, channel=channel, yt_id=f"histvideo{n:02d}")
        set_watch(user, video, 0, datetime.now(UTC) - timedelta(days=n + 1))


def test_gather_run_stores_hits_and_does_not_repeat_itself(
    session, add_video, set_watch, admin_user, youtube, tmp_dirs
):
    from app.services.discovery import gather

    calls, _answers = youtube
    runtime = tmp_dirs["ctx"].discovery
    _history(session, add_video, set_watch, admin_user)
    found = gather.gather_for(session, runtime, admin_user.id)
    searches = [q for kind, q in calls if kind == "search"]
    related = [s for kind, s in calls if kind == "related"]
    assert 1 <= len(searches) <= gather.SEARCHES_PER_RUN
    assert 1 <= len(related) <= gather.RELATED_PER_RUN
    # Searches come from what sets the titles apart, not from channel names.
    assert any("homelab" in q or "dovetail" in q for q in searches), searches
    assert not any(q.lower() in {"alpha", "beta", "woody"} for q in searches)
    assert found == len(calls)
    hits = session.exec(select(DiscoveryHit)).all()
    assert len(hits) == found and {h.source for h in hits} == {"search", "related"}

    # A second run soon after asks for nothing it already asked.
    calls.clear()
    gather.gather_for(session, runtime, admin_user.id)
    assert not set(searches) & {q for kind, q in calls if kind == "search"}
    assert not set(related) & {s for kind, s in calls if kind == "related"}


def test_gather_backs_off_when_youtube_pushes_back(
    session, add_video, set_watch, admin_user, youtube, tmp_dirs
):
    import time

    from app.services.discovery import gather

    calls, answers = youtube
    runtime = tmp_dirs["ctx"].discovery
    _history(session, add_video, set_watch, admin_user)
    bot = RuntimeError("Sign in to confirm you're not a bot")
    for key in ("histvideo00", "histvideo01", "histvideo02"):
        answers[key] = bot
    original_search = gather.search_youtube_for_discovery

    def failing_search(query, **kw):
        original_search(query, **kw)
        raise bot

    gather.search_youtube_for_discovery = failing_search
    try:
        gather.gather_for(session, runtime, admin_user.id)
    finally:
        gather.search_youtube_for_discovery = original_search
    # The first push-back stops the run and pauses all gathering.
    assert len(calls) == 1
    assert runtime.paused_until > time.monotonic() + gather.BACKOFF_START_SEC - 5
    first = runtime.backoff_sec
    calls.clear()
    gather.gather_for(session, runtime, admin_user.id)
    assert calls == []  # still paused
    runtime.paused_until = 0
    gather.search_youtube_for_discovery = failing_search
    try:
        gather.gather_for(session, runtime, admin_user.id)
    finally:
        gather.search_youtube_for_discovery = original_search
    assert runtime.backoff_sec == min(gather.BACKOFF_MAX_SEC, first * 2)


def test_gather_keeps_to_the_hourly_cap(
    session, add_video, set_watch, admin_user, youtube, tmp_dirs, monkeypatch
):
    import time

    from app.services.discovery import gather

    calls, _answers = youtube
    runtime = tmp_dirs["ctx"].discovery
    _history(session, add_video, set_watch, admin_user)
    monkeypatch.setattr(gather, "HOURLY_REQUEST_CAP", 2)
    runtime.recent_requests = [time.monotonic() - 4000]  # over an hour ago: forgotten
    gather.gather_for(session, runtime, admin_user.id)
    assert len(calls) == 2


def test_only_active_users_are_gathered_for(session, admin_user, member_user, tmp_dirs):
    from app.models import DiscoveryState
    from app.services.discovery import gather

    now = datetime.now(UTC)
    session.add(
        DiscoveryState(user_id=admin_user.id, last_viewed_at=now, last_run_at=now)
    )
    session.add(
        DiscoveryState(
            user_id=member_user.id,
            last_viewed_at=now - gather.ACTIVE_FOR - timedelta(hours=1),
        )
    )
    session.commit()
    assert gather.due_users(session, now) == []  # ran just now; member idle
    assert gather.due_users(session, now + gather.RUN_INTERVAL) == [admin_user.id]
    runtime = tmp_dirs["ctx"].discovery
    assert gather.request_refresh(session, runtime, admin_user.id) is False  # too soon
    session.get(DiscoveryState, admin_user.id).last_run_at = now - timedelta(hours=1)
    session.commit()
    assert gather.request_refresh(session, runtime, admin_user.id) is True
    assert gather.due_users(session, datetime.now(UTC)) == [admin_user.id]


def test_refresh_says_when_looking_on_youtube_is_off(client):
    client.patch("/api/settings", json={"discovery_enabled": False})
    body = client.post("/api/discover/refresh").json()
    assert body["queued"] is False and "off" in body["detail"]
    status = client.get("/api/discover/status").json()
    assert status["enabled"] is False


def test_found_videos_already_in_the_library_are_not_stored(
    session, add_video, admin_user
):
    from app.services.discovery import gather

    request = gather._Request("search", "q", "recent")
    added = gather.store_results(
        session,
        admin_user.id,
        request,
        [
            _entry("inlibrary01", "Have it"),
            _entry("brandnew001", "New"),
            _entry("blocked0001", "No", "Spam"),
        ],
        in_library={"inlibrary01"},
        blocked=lambda key, url, name: name == "Spam",
    )
    assert added == 1
    assert [v.yt_id for v in session.exec(select(DiscoveryVideo)).all()] == [
        "brandnew001"
    ]


def test_prune_forgets_old_hits_and_unreferenced_videos(session, admin_user):
    from app.services.discovery import gather

    old = _discovered(session, admin_user, "oldfound001", "Old", "Chan")
    _discovered(session, admin_user, "newfound001", "New", "Chan")
    hit = session.exec(
        select(DiscoveryHit).where(DiscoveryHit.discovery_video_id == old.id)
    ).one()
    hit.found_at = datetime.now(UTC) - gather.HIT_TTL - timedelta(days=1)
    session.add(hit)
    session.commit()
    gather.prune(session, admin_user.id)
    left = [v.yt_id for v in session.exec(select(DiscoveryVideo)).all()]
    assert left == ["newfound001"]


# --- interests and searches -------------------------------------------------------


def test_interests_split_recent_from_dormant(
    session, add_video, set_watch, admin_user, tmp_dirs, ai_on
):
    from app.services.discovery import history, interests

    now = datetime.now(UTC)
    for n in range(6):
        _watched(
            session,
            add_video,
            set_watch,
            admin_user,
            _vec(0.02 * n),
            channel="Lab",
            days_ago=n + 1,
        )
    for n in range(4):  # a year ago, another topic: dormant
        _watched(
            session,
            add_video,
            set_watch,
            admin_user,
            _vec(0.02 * n, axis=2),
            channel="F1",
            days_ago=300 + n,
        )
    for n in range(3):  # a year ago, the same topic as now: not dormant
        _watched(
            session,
            add_video,
            set_watch,
            admin_user,
            _vec(0.03 * n),
            channel="OldLab",
            days_ago=320 + n,
        )
    recent, dormant = interests.interests(
        session, tmp_dirs["ctx"].discovery, history.watches(session, admin_user.id), now
    )
    assert {c for g in recent for c in g.channels} == {"Lab"}
    assert [g.channels for g in dormant] == [["F1"]]


def test_chat_model_searches_are_cleaned(monkeypatch):
    from app.services.discovery import interests
    from app.services.discovery.history import Watch

    group = interests.Interest(
        era="recent",
        watches=[
            Watch(
                "k", None, None, "Rack build", "Alpha", "", datetime.now(UTC), 1.0, True
            )
        ],
        weights=[1.0],
    )

    class Fake:
        def chat(self, *a, **kw):
            return '{"groups": [{"group": 1, "queries": ["\\"server rack build\\"", "Alpha", "x", "homelab rack cooling"]}, {"group": 9, "queries": ["nope"]}]}'

    monkeypatch.setattr(interests, "llm_features_allowed", lambda: (True, None))
    monkeypatch.setattr(interests, "get_llm_provider", lambda: Fake())
    monkeypatch.setattr(interests, "resolve_llm_model", lambda llm: "m")
    monkeypatch.setattr(interests, "require_llm_chat_model", lambda llm, m: None)
    assert interests.llm_queries([group]) is True
    # Quotes stripped; a channel's own name and too-short text dropped.
    assert group.queries == ["server rack build", "homelab rack cooling"]


def test_plan_has_one_throwback_search_and_an_old_favourite():
    from app.services.discovery import gather, interests
    from app.services.discovery.history import Watch

    now = datetime.now(UTC)

    def watch(key, days, finished=True):
        return Watch(
            key,
            key,
            None,
            f"t {key}",
            "c",
            "",
            now - timedelta(days=days),
            1.0,
            finished,
        )

    recent = [
        interests.Interest("recent", [], [], queries=["a one", "a two"]),
        interests.Interest("recent", [], [], queries=["b one"]),
    ]
    dormant = [interests.Interest("throwback", [], [], queries=["old one"])]
    history = [
        watch("recent00001", 1),
        watch("recent00002", 2),
        watch("oldfavorite", 200),
    ]
    plan = gather.plan_requests(recent, dormant, history, {}, now)
    searches = [r for r in plan if r.kind == "search"]
    assert [r.key for r in searches] == ["old one", "a one", "b one", "a two"]
    assert [r.era for r in searches][0] == "throwback"
    assert searches[1].this_year and not searches[3].this_year
    related = [r for r in plan if r.kind == "related"]
    assert ("oldfavorite", "throwback") in [(r.key, r.era) for r in related]
    # Already asked recently: skipped.
    asked = {"q:a one": now.isoformat(), "s:recent00001": now.isoformat()}
    plan = gather.plan_requests(recent, dormant, history, asked, now)
    assert "a one" not in [r.key for r in plan]
    assert "recent00001" not in [r.key for r in plan]


def test_up_next_is_read_with_yt_dlps_own_parsers():
    import yt_dlp
    from yt_dlp.extractor.youtube import YoutubeTabIE

    from app.services.ytdlp_extract import parse_up_next

    def lockup(vid, title, chan, handle):
        return {
            "lockupViewModel": {
                "contentId": vid,
                "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
                "contentImage": {
                    "thumbnailViewModel": {
                        "image": {
                            "sources": [
                                {
                                    "url": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                                    "width": 480,
                                    "height": 360,
                                }
                            ]
                        },
                        "overlays": [
                            {
                                "thumbnailOverlayBadgeViewModel": {
                                    "thumbnailBadges": [
                                        {"thumbnailBadgeViewModel": {"text": "12:34"}}
                                    ]
                                }
                            }
                        ],
                    }
                },
                "metadata": {
                    "lockupMetadataViewModel": {
                        "title": {"content": title},
                        "metadata": {
                            "contentMetadataViewModel": {
                                "metadataRows": [
                                    {
                                        "metadataParts": [
                                            {
                                                "text": {
                                                    "content": chan,
                                                    "commandRuns": [
                                                        {
                                                            "onTap": {
                                                                "innertubeCommand": {
                                                                    "browseEndpoint": {
                                                                        "browseId": "UC"
                                                                        + "a" * 22,
                                                                        "canonicalBaseUrl": f"/@{handle}",
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    ],
                                                }
                                            }
                                        ]
                                    },
                                    {
                                        "metadataParts": [
                                            {"text": {"content": "1.2M views"}},
                                            {
                                                "text": {"content": "3 weeks ago"},
                                                "accessibilityLabel": "3 weeks ago",
                                            },
                                        ]
                                    },
                                ]
                            }
                        },
                    }
                },
            }
        }

    response = {
        "contents": {
            "twoColumnWatchNextResults": {
                "secondaryResults": {
                    "secondaryResults": {
                        "results": [
                            lockup(
                                "abcdefghijk", "Building a rack", "Rack Guy", "rackguy"
                            ),
                            {
                                "itemSectionRenderer": {
                                    "contents": [
                                        lockup(
                                            "bcdefghijkl", "Second", "Other", "other"
                                        )
                                    ]
                                }
                            },
                            {
                                "lockupViewModel": {
                                    "contentId": "PLxyz",
                                    "contentType": "LOCKUP_CONTENT_TYPE_PLAYLIST",
                                }
                            },
                            lockup(
                                "abcdefghijk", "Building a rack", "Rack Guy", "rackguy"
                            ),
                            {"continuationItemRenderer": {}},
                        ]
                    }
                }
            }
        }
    }
    with yt_dlp.YoutubeDL({"quiet": True}) as ydl:
        entries = parse_up_next(ydl.get_info_extractor(YoutubeTabIE.ie_key()), response)
    assert [
        (e["id"], e["title"], e["channel"], e["duration"], e["view_count"])
        for e in entries
    ] == [
        ("abcdefghijk", "Building a rack", "Rack Guy", 754, 1_200_000),
        ("bcdefghijkl", "Second", "Other", 754, 1_200_000),
    ]
    assert entries[0]["channel_url"] == "https://www.youtube.com/@rackguy"


# --- Recommended (library + every catalog) ------------------------------------------


def test_recommended_includes_unfollowed_catalogs_but_not_streamed_or_blocked(
    client, session, add_video, set_watch, admin_user
):
    seen = add_video(title="Seen", channel="Loved")
    set_watch(admin_user, seen, 0, datetime.now(UTC))
    _catalog(
        session,
        "Elsewhere",
        [
            ("elseupload1", "Unfollowed upload", 3, None),
            ("elsestream1", "Streamed", 4, None),
        ],
    )
    _catalog(session, "Spam", [("spamupload1", "Spam upload", 2, None)])
    client.post(
        "/api/discover/history",
        json={"url": _yt("elsestream1"), "position_sec": 60, "duration_sec": 600},
    )
    client.post(
        "/api/discover/feedback", json={"kind": "channel", "key": "", "label": "Spam"}
    )
    body = client.get(
        "/api/ai/recommendations", params={"include_streams": True}
    ).json()
    titles = [
        (i["stream"] or i["video"])["title"]
        for s in body["sections"]
        for i in s["items"]
    ]
    assert "Unfollowed upload" in titles
    assert "Streamed" not in titles and "Spam upload" not in titles


# --- review regressions -----------------------------------------------------------


def test_paging_keeps_the_visits_ranking_when_the_user_watches_meanwhile(
    client, session, admin_user
):
    for n in range(30):
        _discovered(session, admin_user, f"fd{n:09d}", f"Found {n}", f"Channel {n}")
    first = client.get("/api/discover/feed", params={"limit": 10}).json()
    # Watching one of them (mini player while scrolling) changes the history.
    client.post(
        "/api/discover/history",
        json={"url": _yt(first["items"][0]["key"]), "position_sec": 60},
    )
    keys = [i["key"] for i in first["items"]]
    cursor = first["next_cursor"]
    while cursor:
        page = client.get("/api/discover/feed", params={"cursor": cursor}).json()
        keys += [i["key"] for i in page["items"]]
        cursor = page["next_cursor"]
    assert sorted(keys) == [f"fd{n:09d}" for n in range(30)]
    # A new visit ranks again and leaves the watched one out.
    again = [i["key"] for i in _items(client)]
    assert first["items"][0]["key"] not in again


def test_household_switch_stops_cold_start_pooling(
    session, add_video, set_watch, admin_user, member_user, client
):
    from app.services.discovery import feed

    for n in range(4):
        set_watch(admin_user, add_video(title=f"Admin {n}", channel="Theirs"), 0)
    pooled, cold = feed.taste_history(session, member_user.id)
    assert cold and len(pooled) == 4
    client.patch("/api/settings", json={"discovery_household": False})
    pooled, cold = feed.taste_history(session, member_user.id)
    assert cold and pooled == []


def test_first_visit_state_is_created_once(session, admin_user, tmp_dirs):
    from app.models import DiscoveryState
    from app.services.discovery import gather

    session.add(DiscoveryState(user_id=admin_user.id))
    session.commit()
    # A second request that missed the row still gets it, not an error.
    session.expunge_all()
    row = gather._state(session, admin_user.id)
    assert row.user_id == admin_user.id


def test_members_without_ai_get_keyword_searches(
    session, add_video, set_watch, member_user, youtube, tmp_dirs, monkeypatch
):
    from app.services.discovery import gather

    asked: list[str] = []
    monkeypatch.setattr(
        gather, "llm_queries", lambda groups: asked.append("llm") or False
    )
    session.get(type(member_user), member_user.id).permissions = '["download"]'
    session.commit()
    _history(session, add_video, set_watch, member_user)
    gather.gather_for(session, tmp_dirs["ctx"].discovery, member_user.id)
    assert asked == []
    calls, _ = youtube
    assert any(kind == "search" for kind, _q in calls)


def test_gather_pauses_between_calls(
    session, add_video, set_watch, admin_user, youtube, tmp_dirs
):
    from app.services.discovery import gather

    pauses: list[float] = []
    _history(session, add_video, set_watch, admin_user)
    gather.gather_for(
        session,
        tmp_dirs["ctx"].discovery,
        admin_user.id,
        pause=lambda sec: pauses.append(sec) or False,
    )
    calls, _ = youtube
    assert pauses == [gather.REQUEST_PAUSE_SEC] * (len(calls) - 1)

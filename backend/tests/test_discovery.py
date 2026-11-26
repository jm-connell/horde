"""Recommended+: stream history, feedback, the gatherer and the mixed feed.

Vectors are tiny and hand made, as in ``test_recommend.py``: ``_vec(a)`` is a
unit vector at angle ``a`` in the plane of the first two axes, so closeness is
plain from the angles.
"""

from __future__ import annotations

import math
import time
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
from app.services.discovery.tuning import DEFAULTS


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
        "app.services.discovery.relevance.get_embed_provider",
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
    from app.services.discovery import mix, picks
    from app.services.discovery.candidates import Candidate

    def items(bucket, n, channels):
        return [
            picks.FeedItem(
                Candidate(
                    key=f"{bucket}{i}",
                    pool="discovery",
                    title="",
                    channel=channels[i % len(channels)],
                    channel_url="",
                ),
                bucket,
                1.0 - i * 0.01,
                picks.Reason("x", "x"),
            )
            for i in range(n)
        ]

    out = mix.mix(
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
    balanced = DEFAULTS.shares.normalized()
    counts = {b: sum(1 for i in first if i.bucket == b) for b in balanced}
    for bucket, share in balanced.items():
        assert abs(counts[bucket] - 40 * share) <= 2, counts
    # No channel twice within the Balanced channel gap.
    names = [i.candidate.channel for i in out[:100]]
    for n in range(len(names) - DEFAULTS.channel_gap + 1):
        window = names[n : n + DEFAULTS.channel_gap]
        assert len(window) == len(set(window)), window
    # Throwbacks keep to their cap (3 per channel); the 22 past it wait at the end.
    assert len(out) == 160
    placed, overflow = out[:138], out[138:]
    for channel in ["T1", "T2", "T3", "T4", "T5", "T6"]:
        assert sum(1 for i in placed if i.candidate.channel == channel) == 3
    assert {i.bucket for i in overflow} == {"throwback"}


def test_mix_stops_at_the_feeds_size():
    """The mixer places no more picks than the feed keeps: mixing a pool of
    thousands to throw most of it away was half the cost of a ranking."""
    from app.services.discovery import mix, picks
    from app.services.discovery.candidates import Candidate

    def buckets():
        return {
            bucket: [
                picks.FeedItem(
                    Candidate(
                        key=f"{bucket}{i}",
                        pool="discovery",
                        title="",
                        channel=f"{bucket}-{i % 50}",
                        channel_url="",
                    ),
                    bucket,
                    1.0 - i * 0.001,
                    picks.Reason("x", "x"),
                )
                for i in range(400)
            ]
            for bucket in ("subscriptions", "similar", "new", "throwback")
        }

    everything = mix.mix(buckets(), limit=1600)
    assert len(everything) == 1600
    top = mix.mix(buckets(), limit=100)
    assert [i.candidate.key for i in top] == [i.candidate.key for i in everything[:100]]
    assert len(mix.mix(buckets())) == mix.FEED_MAX


def test_a_recipe_scores_its_terms_in_order():
    """A pick's score parts are its recipe's terms, weight times signal, then
    the popularity lean; a label can be renamed for the candidate."""
    from app.services.discovery import scoring

    now = datetime.now(UTC)
    scorer = scoring.Scorer(DEFAULTS, now)
    parts = scorer.parts(
        "subscriptions",
        {"channel_now": 0.6, "taste_capped": 0.5},
        now - timedelta(days=10),
        0.5,
        {"channel_now": "Followed channel"},
    )
    assert [label for label, _value in parts] == [
        "Freshness",
        "Followed channel",
        "Match to your taste",
        "Popularity",
    ]
    # Ten days is the subscriptions half-life: half of the freshness weight.
    assert parts[0][1] == pytest.approx(0.55 / 2)
    assert [value for _label, value in parts[1:]] == pytest.approx([0.15, 0.1, 0.0])
    # A rewatch is not scored on views at all.
    rewatch = scorer.parts(
        "rewatch",
        {"taste_capped": 1.0, "known": 1.0, "rewatched": 1.0, "time_away": 1.0},
        None,
        1.0,
    )
    assert sum(value for _label, value in rewatch) == pytest.approx(1.0)
    assert "Popularity" not in dict(rewatch)


def test_throwbacks_stay_out_of_the_top_of_the_feed():
    from app.services.discovery import mix, picks
    from app.services.discovery.candidates import Candidate

    def items(bucket, n):
        return [
            picks.FeedItem(
                Candidate(
                    key=f"{bucket}{i}",
                    pool="discovery",
                    title="",
                    channel=f"{bucket}{i}",
                    channel_url="",
                ),
                bucket,
                # Throwbacks score best, so only the hold keeps them down.
                (2.0 if bucket == "throwback" else 1.0) - i * 0.01,
                picks.Reason("x", "x"),
            )
            for i in range(n)
        ]

    out = mix.mix(
        {b: items(b, 30) for b in ("subscriptions", "similar", "new", "throwback")}
    )
    top = out[: mix.THROWBACK_HOLD]
    assert all(i.bucket != "throwback" for i in top)
    # They come in after the hold, spread out rather than in one run.
    after = [i.bucket for i in out[mix.THROWBACK_HOLD : mix.THROWBACK_HOLD + 20]]
    assert 1 <= after.count("throwback") <= 5, after
    # With nothing else to show, throwbacks still fill the feed.
    assert len(mix.mix({"throwback": items("throwback", 5)})) == 5


def test_an_empty_bucket_does_not_inflate_the_sprinkles():
    from app.services.discovery import mix

    shares = mix.effective_shares({"similar", "new", "throwback"})
    assert abs(sum(shares.values()) - 1) < 1e-9
    balanced = DEFAULTS.shares.normalized()
    for bucket in ("new", "throwback"):
        assert shares[bucket] <= balanced[bucket] * mix.SHARE_CAP_RATIO[bucket]
    assert shares["similar"] > balanced["similar"]


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


# --- library + every catalog -------------------------------------------------------


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
    items = _items(client)
    titles = [(i["stream"] or i["video"])["title"] for i in items]
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


def test_requests_that_arrive_together_share_one_ranking(
    session, init_db, admin_user, tmp_dirs, monkeypatch
):
    """The home page asks for the first page and the channel suggestions at
    once; the second waits for the first's ranking instead of ranking too."""
    import threading
    import time

    from sqlmodel import Session

    from app import context
    from app.services.discovery import feed

    _discovered(session, admin_user, "found000001", "Found", "Chan")
    runtime = context.current().discovery
    built = []
    real = feed.build_feed

    ranking = threading.Event()

    def slow(*args, **kwargs):
        built.append(1)
        ranking.set()
        time.sleep(0.3)
        return real(*args, **kwargs)

    monkeypatch.setattr(feed, "build_feed", slow)
    feeds = []

    def ask(fresh):
        with Session(init_db["engine"]) as own:
            feeds.append(feed.ranked_feed(own, runtime, admin_user.id, 7, fresh=fresh))

    threads = [threading.Thread(target=ask, args=(fresh,)) for fresh in (True, False)]
    threads[0].start()
    # The second asks while the first is ranking, so it cannot find it cached.
    assert ranking.wait(timeout=10)
    threads[1].start()
    for thread in threads:
        thread.join()
    assert len(built) == 1
    assert feeds[0] is feeds[1]


def test_a_busy_history_keeps_its_old_channels(
    client, session, add_video, set_watch, admin_user, ai_on
):
    """A channel watched long ago stays a throwback, and is not "new", however
    much was watched since: the newest 600 watches used to be all that was read."""
    from app import context
    from app.services.discovery import history
    from app.services.discovery.feed import build_feed

    now = datetime.now(UTC)
    for n in range(6):
        _watched(
            session,
            add_video,
            set_watch,
            admin_user,
            _vec(0.0, axis=2),
            channel="OldFav",
            title=f"OldFav {n}",
            days_ago=200 + n,
        )
    for n in range(4):
        _watched(
            session,
            add_video,
            set_watch,
            admin_user,
            _vec(0.02 * n),
            channel="Lab",
            title=f"Lab {n}",
            days_ago=2,
        )
    _catalog(session, "OldFav", [("oldfavnew01", "New upload", 3, _vec(0.01, axis=2))])
    session.add_all(
        UserStreamState(
            user_id=admin_user.id,
            yt_id=f"st{n:09d}",
            url=_yt(f"st{n:09d}"),
            title=f"Stream {n}",
            channel=f"Chan{n % 30}",
            watched_sec=600,
            duration_sec=600,
            finished_at=now,
            last_watched_at=now - timedelta(days=5 + n * 95 / 650),
        )
        for n in range(history.HISTORY_LIMIT + 50)
    )
    session.commit()

    # The taste read reaches past its newest 600 to the older watches...
    read = history.watches(session, admin_user.id, older_than=now - timedelta(days=60))
    assert sum(1 for w in read if w.channel == "OldFav") == 6
    assert len(history.watches(session, admin_user.id)) == history.HISTORY_LIMIT
    # ...and the feed still knows the channel.
    feed = build_feed(session, context.current().discovery, admin_user.id, 1)
    pick = next(i for i in feed.items if i.candidate.key == "oldfavnew01")
    assert (pick.bucket, pick.reason.text) == ("throwback", "You used to watch OldFav")
    assert pick.eligible


def test_the_watch_log_reads_every_source_once(
    session, add_video, set_watch, admin_user
):
    """Library, streamed and imported watches of one video are one watch (the
    library's), and an imported channel counts as watched."""
    from app.services.discovery import history
    from app.services.takeout import history as takeout
    from app.services.takeout.parse import WatchView

    now = datetime.now(UTC)
    video = add_video(channel="Lab", title="Lab", source_url=_yt("labvideo001"))
    set_watch(admin_user, video, 0, now - timedelta(days=1))
    takeout.store_views(
        session,
        admin_user.id,
        [
            WatchView("labvideo001", now - timedelta(days=900), "Lab", "Lab"),
            WatchView("oldimport01", now - timedelta(days=800), "Old", "Imported"),
            WatchView("oldimport01", now - timedelta(days=700), "Old", "Imported"),
        ],
    )
    log = history.watch_log(session, admin_user.id)
    assert [(w.key, w.channel, w.engagement) for w in log] == [
        ("labvideo001", "Lab", 1.0),
        ("oldimport01", "Imported", history.YOUTUBE_REWATCH_ENGAGEMENT),
    ]
    older = history.watches(
        session, admin_user.id, limit=1, older_than=now - timedelta(days=60)
    )
    assert [w.key for w in older] == ["labvideo001", "oldimport01"]
    assert older[1].title == "Old"
    # A channel renamed between two imports goes by its newest name, as in
    # ``watches``, whichever name sorts last.
    takeout.store_views(
        session,
        admin_user.id,
        [
            WatchView("renamed0001", now - timedelta(days=400), "Clip", "Zeta Old"),
            WatchView("renamed0001", now - timedelta(days=300), "Clip", "Alpha New"),
        ],
    )
    names = {w.key: w.channel for w in history.watch_log(session, admin_user.id)}
    assert names["renamed0001"] == "Alpha New"
    assert names == {w.key: w.channel for w in history.watches(session, admin_user.id)}
    assert log[0].video_id == video.id


def test_a_downloaded_video_is_not_a_new_channel(
    client, session, add_video, set_watch, admin_user, ai_on
):
    """A library video from a channel not watched yet ranks with the familiar
    picks: it does not take the new-channel share, floor or two-per-channel cap."""
    for n in range(4):
        _watched(
            session,
            add_video,
            set_watch,
            admin_user,
            _vec(0.02 * n),
            channel="Lab",
            title=f"Lab {n}",
            days_ago=2,
        )
    for n in range(3):
        video = add_video(channel="Shelf", title=f"Shelf {n}")
        _embed(session, video, _vec(0.03 + 0.01 * n))
    _discovered(
        session, admin_user, "strangervid", "Close to Lab", "Stranger", _vec(0.03)
    )

    by_title = {(i.get("video") or i["stream"])["title"]: i for i in _items(client)}
    for n in range(3):
        pick = by_title[f"Shelf {n}"]
        assert pick["why"]["bucket"] == "similar"
        assert pick["reason"]["kind"] != "new_channel"
    assert by_title["Close to Lab"]["reason"]["kind"] == "new_channel"


def test_household_switch_stops_cold_start_pooling(
    session, add_video, set_watch, admin_user, member_user, client
):
    from app.services.discovery import household

    for n in range(4):
        set_watch(admin_user, add_video(title=f"Admin {n}", channel="Theirs"), 0)
    pooled, cold = household.taste_history(session, member_user.id)
    assert cold and len(pooled) == 4
    client.patch("/api/settings", json={"discovery_household": False})
    pooled, cold = household.taste_history(session, member_user.id)
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


# --- followed channels' live broadcasts -------------------------------------------


def _go_live(app, session, user, channel, video_id, *, follow=True):
    from app.services import follows
    from app.services.live.page import LiveBroadcast

    url = f"https://youtube.com/@{channel.lower()}"
    if follow:
        follows.follow(session, user.id, url, channel)
    app.state.ctx.live.directory.record(
        url,
        channel,
        LiveBroadcast(video_id, f"{channel} live", channel, None, 100, None),
    )
    return url


def test_live_broadcasts_lead_recommended_plus_when_watched_lately(
    app, client, session, add_video, set_watch, admin_user, ai_on
):
    from app.services.live.picks import LATER_POSITION

    for n in range(8):
        _discovered(session, admin_user, f"found{n:06d}", f"Found {n}", f"Chan {n}")
    loved = _go_live(app, session, admin_user, "Loved", "lovedlive01")
    set_watch(admin_user, add_video(channel="Loved", channel_url=loved), 0)
    _go_live(app, session, admin_user, "Followed", "followlive1")
    _go_live(app, session, admin_user, "Stranger", "strangelive", follow=False)

    first = client.get("/api/discover/feed", params={"limit": 4}).json()
    keys = [i["key"] for i in first["items"]]
    assert keys[0] == "lovedlive01"
    assert keys.index("followlive1") == 1 + LATER_POSITION
    assert "strangelive" not in keys
    lead = first["items"][0]
    assert lead["reason"]["kind"] == "live"
    assert lead["source"] == "channels"
    assert lead["stream"]["live_status"] == "is_live"
    assert lead["stream"]["channel_url"] == loved
    # The live cards ride on the first page only; paging is unchanged.
    later = client.get(
        "/api/discover/feed", params={"cursor": first["next_cursor"]}
    ).json()
    assert not {"lovedlive01", "followlive1"} & {i["key"] for i in later["items"]}


def test_hidden_live_streams_stay_out_of_recommended_plus(
    app, client, session, admin_user
):
    from app.services import follows

    _discovered(session, admin_user, "found000001", "Found", "Chan")
    quiet = _go_live(app, session, admin_user, "Quiet", "quietlive01")
    follows.set_hide_live(session, admin_user.id, quiet, True)
    keys = [i["key"] for i in client.get("/api/discover/feed").json()["items"]]
    assert "quietlive01" not in keys and "found000001" in keys


def test_a_blocked_channels_live_broadcast_stays_out(
    app, client, session, add_video, set_watch, admin_user
):
    seen = add_video(title="Seen", channel="Loved")
    set_watch(admin_user, seen, 0, datetime.now(UTC) - timedelta(days=60))
    _go_live(app, session, admin_user, "Loved", "lovedlive01")
    blocked = _go_live(app, session, admin_user, "Muted", "mutedlive01")
    client.post(
        "/api/discover/feedback",
        json={"kind": "channel", "key": blocked, "label": "Muted"},
    )
    first = client.get("/api/discover/feed").json()
    live = [i["key"] for i in first["items"] if i["reason"]["kind"] == "live"]
    assert live == ["lovedlive01"]


def test_live_picks_are_capped_and_match_streamed_watches(
    app, client, session, admin_user
):
    from app.services.live.picks import MAX_OTHER, MAX_RECENT

    total = MAX_RECENT + MAX_OTHER + 2
    for n in range(total):
        _go_live(app, session, admin_user, f"Chan{n}", f"livevideo{n:02d}")
    # Watched as a stream under another name: matched by its channel URL.
    client.post(
        "/api/discover/history",
        json={
            "url": _yt("watchedvid1"),
            "channel": "Chan Seven (renamed)",
            "channel_url": "https://www.youtube.com/@Chan7",
            "position_sec": 60,
            "duration_sec": 600,
        },
    )
    keys = [i["key"] for i in _items(client)]
    live = [k for k in keys if k.startswith("livevideo")]
    assert len(live) == 1 + MAX_OTHER
    assert keys[0] == "livevideo07"


def test_channel_suggestion_says_what_the_channel_is_like():
    """A suggestion carries its picks' typical views and length, and a short
    reason naming the watch that led to it."""
    from app.services.discovery.candidates import Candidate
    from app.services.discovery.feedback import Exclusions
    from app.services.discovery.picks import ChannelStat, Feed
    from app.services.discovery.suggest import suggestions

    def cand(i: int, views: int | None, seconds: float | None) -> Candidate:
        return Candidate(
            key=f"sky{i:08d}",
            pool="discovery",
            title=f"Sky {i}",
            channel="Northern Skies",
            channel_url="https://youtube.com/@northernskies",
            view_count=views,
            duration=seconds,
        )

    stat = ChannelStat("Northern Skies", "https://youtube.com/@northernskies")
    stat.items = [cand(1, 1000, 600), cand(2, 3000, 900), cand(3, None, 1200)]
    stat.scores = [0.9, 0.8, 0.7]
    stat.seeds = {"Aurora over the fjord"}
    stat.queries.update(
        {"night sky photography tips": 2, "northern lights": 1, "Night Sky": 1}
    )
    feed = Feed(items=[], new_channels={stat.url: stat}, cold=False)

    [pick] = suggestions(feed, Exclusions())
    assert pick.typical_views == 2000
    assert pick.typical_minutes == 15
    assert pick.reason == "Like Aurora over the fjord"
    # What it is about: the searches that found it, most first, cut short.
    assert pick.tags == ["night sky photography", "northern lights"]

    # AI categories come first, by how many of its picks are in each.
    categories = {
        "Astronomy": {"sky00000001", "sky00000002"},
        "Travel": {"sky00000003"},
        "Cooking": {"elsewhere01"},
    }
    [pick] = suggestions(feed, Exclusions(), categories)
    assert pick.tags == ["Astronomy", "Travel"]


def test_a_prefetched_page_does_not_count_as_shown(client, session, admin_user):
    """The home page loads Recommended+ ahead of time; only opening it counts."""
    from app.models import DiscoveryState, RecImpression

    _discovered(session, admin_user, "prefetch001", "Found early", "Chan")
    body = _feed(client, prefetch="true")
    assert [i["key"] for i in body["items"]] == ["prefetch001"]
    assert session.get(RecImpression, (admin_user.id, "prefetch001")) is None
    # Nor does it make the user active for the YouTube gatherer.
    state = session.get(DiscoveryState, admin_user.id)
    assert state is None or state.last_viewed_at is None
    _feed(client)
    row = session.get(RecImpression, (admin_user.id, "prefetch001"))
    assert row is not None and row.shown_count == 1


def _two_interests(session, add_video, set_watch, user):
    """Watches on two subjects, so the user has two categories."""
    for n in range(6):
        _watched(
            session,
            add_video,
            set_watch,
            user,
            _vec(0.01 * n),
            channel="Sky Lab",
            title=f"Telescope stars part {n}",
            days_ago=n + 1,
        )
    for n in range(6):
        _watched(
            session,
            add_video,
            set_watch,
            user,
            _vec(0.01 * n, axis=2),
            channel="Shore",
            title=f"Rock pools crabs part {n}",
            days_ago=n + 1,
        )


@pytest.fixture
def small_categories(monkeypatch):
    """A handful of matches is a category (the tests' libraries are tiny)."""
    from app.services.discovery import category_feed

    monkeypatch.setattr(category_feed, "MIN_CATEGORY_PICKS", 1)


def _category(body, word):
    [found] = [c for c in body["categories"] if word in c["name"].lower()]
    return found["id"]


def test_recommended_can_be_browsed_by_the_users_own_categories(
    client, session, add_video, set_watch, admin_user, ai_on, small_categories
):
    """The chips are the user's interests, and a category lists every video
    Horde knows that fits it: found on YouTube, listed and downloaded alike."""
    _two_interests(session, add_video, set_watch, admin_user)
    _discovered(session, admin_user, "skyfound001", "Stars", "Sky A", _vec(0.02))
    _discovered(session, admin_user, "skyfound002", "Aurora", "Sky B", _vec(0.05))
    _discovered(
        session, admin_user, "poolfound01", "Crabs", "Pools", _vec(0.03, axis=2)
    )
    _discovered(session, admin_user, "novector001", "Unknown", "Plain")
    downloaded = add_video(title="Milky Way", channel="Sky C", yt_id="milkyway001")
    _embed(session, downloaded, _vec(0.04))

    body = _feed(client)
    assert len(body["categories"]) == 2
    sky, pools = _category(body, "telescope"), _category(body, "pools")

    listed = _feed(client, category=sky)
    assert {i["key"] for i in listed["items"] if i["key"] != "poolfound01"} == {
        "skyfound001",
        "skyfound002",
        "milkyway001",
    }
    assert listed["more"] in ("none", "exhausted", "loading")
    assert [i["reason"]["kind"] for i in listed["items"]][0] == "category"
    assert "poolfound01" in [i["key"] for i in _feed(client, category=pools)["items"]]
    assert "novector001" not in [i["key"] for i in listed["items"]]
    # A category that is gone (or someone else's) is an empty page, not an error.
    gone = client.get("/api/discover/feed", params={"category": 999999})
    assert gone.status_code == 200
    assert gone.json()["items"] == []

    # The ids stay when the same interests are grouped again.
    from app.services.discovery import category_store

    category_store.sync(
        session,
        admin_user.id,
        sum(
            category_store.groups_for(
                session,
                client.app.state.ctx.discovery,
                admin_user.id,
                datetime.now(UTC),
                use_llm=False,
            )[:2],
            [],
        ),
        datetime.now(UTC),
    )
    assert {c["id"] for c in _feed(client)["categories"]} == {sky, pools}


def test_a_category_goes_past_the_feed_and_pages_in_one_order(
    client,
    session,
    add_video,
    set_watch,
    admin_user,
    ai_on,
    small_categories,
    monkeypatch,
):
    from app.services.discovery import feed as feed_module

    _two_interests(session, add_video, set_watch, admin_user)
    _catalog(
        session,
        "Observatory",
        [(f"obs{n:08d}", f"Night sky {n}", n, _vec(0.002 * n)) for n in range(40)],
    )
    # The feed itself keeps only a few picks; the category is not cut to them.
    monkeypatch.setattr(feed_module, "FEED_MAX", 5)
    body = _feed(client)
    assert len(body["items"]) <= 5
    sky = _category(body, "telescope")
    keys: list[str] = []
    cursor = None
    loose_at = []
    for _ in range(10):
        params = {"category": sky, "limit": 12}
        if cursor:
            params["cursor"] = cursor
        page = _feed(client, **params)
        if page["loose_from"] is not None:
            loose_at.append(len(keys) + page["loose_from"])
        keys += [i["key"] for i in page["items"]]
        cursor = page["next_cursor"]
        if not cursor or not page["items"]:
            break
    assert len(keys) == len(set(keys)) >= 40
    assert len(loose_at) <= 1  # one divider at most


def test_opening_a_category_never_asks_youtube(
    client,
    session,
    add_video,
    set_watch,
    admin_user,
    ai_on,
    small_categories,
    monkeypatch,
):
    from app.services.discovery import gather

    def boom(*_a, **_k):
        raise AssertionError("YouTube was asked during a request")

    monkeypatch.setattr(gather, "search_youtube_for_discovery", boom)
    monkeypatch.setattr(gather, "youtube_up_next", boom)
    _two_interests(session, add_video, set_watch, admin_user)
    _discovered(session, admin_user, "skyfound001", "Stars", "Sky A", _vec(0.02))
    body = _feed(client)
    assert _feed(client, category=_category(body, "telescope"))["items"]


def test_a_category_suggests_its_own_new_channels(
    client, session, add_video, set_watch, admin_user, ai_on, small_categories
):
    _two_interests(session, add_video, set_watch, admin_user)
    for n in range(3):
        _discovered(
            session, admin_user, f"skyfound{n:03d}", f"Stars {n}", "Sky A", _vec(0.02)
        )
        _discovered(
            session,
            admin_user,
            f"poolfnd{n:04d}",
            f"Crabs {n}",
            "Pools",
            _vec(0.03, axis=2),
        )
    body = _feed(client)
    sky = _category(body, "telescope")
    names = [
        c["name"]
        for c in client.get("/api/discover/channels", params={"category": sky}).json()[
            "items"
        ]
    ]
    assert names == ["Sky A"]


def test_the_cached_catalog_follows_the_catalog(client, session, admin_user):
    """The catalog's candidates are kept between feeds; a channel indexed
    further, a video updated or skipped since must show in the next ranking."""
    from app.models import ChannelCatalogSkip

    def keys(seed):  # A new seed is a new ranking.
        return {i["key"] for i in _feed(client, seed=seed)["items"]}

    _catalog(session, "Cached", [("cachedvid01", "First upload", 2, None)])
    assert keys(1) == {"cachedvid01"}

    catalog = session.exec(select(ChannelCatalog)).one()
    session.add(
        ChannelCatalogVideo(
            catalog_id=catalog.id,
            yt_id="cachedvid02",
            url=_yt("cachedvid02"),
            title="Second upload",
            duration=600.0,
            position=1,
        )
    )
    session.commit()
    assert keys(2) == {"cachedvid01", "cachedvid02"}

    first = session.exec(
        select(ChannelCatalogVideo).where(ChannelCatalogVideo.yt_id == "cachedvid01")
    ).one()
    first.live_status = "is_live"  # Now on the Live row instead.
    first.indexed_at = datetime.now(UTC)
    session.add(first)
    session.commit()
    assert keys(3) == {"cachedvid02"}

    session.add(ChannelCatalogSkip(catalog_id=catalog.id, yt_id="cachedvid02"))
    session.commit()
    assert keys(4) == set()


# --- ranked ahead in the background ----------------------------------------------


def _count_rankings(monkeypatch) -> list[int]:
    """The user ids ``build_feed`` ranks for from here on."""
    from app.services.discovery import feed

    ranked: list[int] = []
    real = feed.build_feed

    def counted(session, runtime, user_id, *args, **kwargs):
        ranked.append(user_id)
        return real(session, runtime, user_id, *args, **kwargs)

    monkeypatch.setattr(feed, "build_feed", counted)
    return ranked


def _warmer():
    """A warmer on the app's runtime with a clock the test moves."""
    from app import context
    from app.services.discovery import warm

    clock = [1000.0]
    return warm.Warmer(context.current().discovery, lambda: clock[0]), clock


def test_an_active_users_feed_is_ranked_before_they_ask(
    client, session, admin_user, monkeypatch
):
    """Opening Recommended reads a ranking made in the background: the request
    ranks nothing, also after a restart emptied what was kept."""
    from app import context

    _discovered(session, admin_user, "found000001", "Found", "Chan")
    _feed(client)  # They use Recommended.
    context.current().discovery.forget_feeds(admin_user.id)  # As after a restart.
    ranked = _count_rankings(monkeypatch)

    warmer, _clock = _warmer()
    warmer.run_once()
    assert ranked == [admin_user.id]
    assert [i["key"] for i in _feed(client)["items"]] == ["found000001"]
    client.get("/api/discover/channels")
    assert ranked == [admin_user.id]  # Read, not ranked again.
    warmer.run_once()
    assert ranked == [admin_user.id]  # And it is still current.


def test_a_feed_is_ranked_again_once_the_watching_stops(
    client, session, admin_user, monkeypatch
):
    """A watch puts the kept ranking out of date. A stream reports its place
    every 30 seconds while it plays: the new ranking waits for that to stop."""
    from app.services.discovery import warm

    for n in range(3):
        _discovered(session, admin_user, f"found{n:06d}", f"Found {n}", f"Chan {n}")
    _feed(client)
    ranked = _count_rankings(monkeypatch)
    warmer, clock = _warmer()
    warmer.run_once()
    assert ranked == []  # The request's own ranking is current.

    for report in range(1, 6):
        client.post(
            "/api/discover/history",
            json={"url": _yt("found000000"), "position_sec": 30 * report},
        )
        for _pass in range(3):
            clock[0] += warm.PASS_SEC
            warmer.run_once()
    assert ranked == []  # Still playing.
    clock[0] += warm.QUIET_SEC
    warmer.run_once()
    assert ranked == [admin_user.id]
    keys = [i["key"] for i in _items(client)]
    assert sorted(keys) == ["found000001", "found000002"]
    assert ranked == [admin_user.id]


def test_a_slow_run_of_changes_is_not_ranked_one_by_one(
    client, session, admin_user, add_video, monkeypatch
):
    """A bulk download adds a video a minute; each one puts every feed out of
    date, and the background does not rank for each."""
    from app.services.discovery import warm

    _feed(client)
    ranked = _count_rankings(monkeypatch)
    warmer, clock = _warmer()
    warmer.run_once()
    for n in range(4):
        add_video(title=f"Downloaded {n}", yt_id=f"dl{n:09d}")
        for _pass in range(6):
            clock[0] += warm.PASS_SEC
            warmer.run_once()
    assert len(ranked) < 4
    clock[0] += warm.MIN_GAP_SEC
    warmer.run_once()
    assert ranked[-1] == admin_user.id
    warmer.run_once()
    count = len(ranked)
    _feed(client)
    assert len(ranked) == count  # The last one is current.


def test_a_visit_being_paged_keeps_its_ranking(
    client, session, admin_user, monkeypatch
):
    """The next page's offset counts on the visit's ranking: the background
    leaves it alone while the person pages, and replaces it afterwards."""
    from app.services.discovery import warm

    for n in range(6):
        _discovered(session, admin_user, f"found{n:06d}", f"Found {n}", f"Chan {n}")
    order = [i["key"] for i in _items(client)]
    first = _feed(client, limit=2)
    second = _feed(client, cursor=first["next_cursor"], limit=2)
    assert [i["key"] for i in second["items"]] == order[2:4]
    # Watched in the mini player (it was on the first page) while scrolling.
    client.post(
        "/api/discover/history", json={"url": _yt(order[0]), "position_sec": 60}
    )
    ranked = _count_rankings(monkeypatch)
    warmer, clock = _warmer()
    warmer.run_once()
    clock[0] += warm.QUIET_SEC
    warmer.run_once()
    assert ranked == []
    third = _feed(client, cursor=second["next_cursor"], limit=2)
    assert [i["key"] for i in third["items"]] == order[4:6]

    # They stopped paging a while ago.
    monkeypatch.setattr(warm, "PAGING_HOLD_SEC", 0.0)
    warmer.run_once()
    assert ranked == [admin_user.id]
    assert order[0] not in [i["key"] for i in _items(client)]


def test_the_background_takes_a_ranking_a_request_made_meanwhile(
    session, init_db, admin_user, tmp_dirs, monkeypatch
):
    """A pass that waited for a request's ranking uses it."""
    import threading

    from app.models import DiscoveryState
    from app.services.discovery import feed, warm

    session.add(DiscoveryState(user_id=admin_user.id, last_viewed_at=datetime.now(UTC)))
    session.commit()
    runtime = tmp_dirs["ctx"].discovery
    ranked = _count_rankings(monkeypatch)
    warmer = warm.Warmer(runtime)
    lock = runtime.ranking(admin_user.id)
    lock.acquire()  # A request is ranking.
    try:
        waiting = threading.Thread(target=warmer.run_once)
        waiting.start()
        deadline = time.monotonic() + 10
        while not warmer._tracked and time.monotonic() < deadline:
            time.sleep(0.01)
        state = feed.feed_state(session, admin_user.id, feed.today_seed())
        feed.rank(session, runtime, admin_user.id, state)
    finally:
        lock.release()
    waiting.join(timeout=10)
    assert not waiting.is_alive()
    assert ranked == [admin_user.id]  # The request's, not a second one.


def test_one_persons_failure_does_not_cost_the_others_their_ranking(
    session, admin_user, member_user, tmp_dirs, monkeypatch
):
    from app.models import DiscoveryState
    from app.services.discovery import feed, warm

    now = datetime.now(UTC)
    session.add(DiscoveryState(user_id=member_user.id, last_viewed_at=now))
    session.add(
        DiscoveryState(user_id=admin_user.id, last_viewed_at=now - timedelta(minutes=5))
    )
    session.commit()
    ranked: list[int] = []
    real = feed.build_feed

    def failing(session, runtime, user_id, *args, **kwargs):
        if user_id == member_user.id:  # The latest visitor: ranked first.
            raise RuntimeError("no ranking for you")
        ranked.append(user_id)
        return real(session, runtime, user_id, *args, **kwargs)

    monkeypatch.setattr(feed, "build_feed", failing)
    warm.Warmer(tmp_dirs["ctx"].discovery).run_once()
    assert ranked == [admin_user.id]


def test_only_people_who_use_recommended_are_ranked_ahead(
    session, admin_user, member_user, tmp_dirs, monkeypatch
):
    from app.models import DiscoveryState
    from app.services.discovery import gather, warm

    now = datetime.now(UTC)
    session.add(DiscoveryState(user_id=admin_user.id, last_viewed_at=now))
    session.add(
        DiscoveryState(
            user_id=member_user.id,
            last_viewed_at=now - gather.ACTIVE_FOR - timedelta(hours=1),
        )
    )
    session.commit()
    ranked = _count_rankings(monkeypatch)
    warm.Warmer(tmp_dirs["ctx"].discovery).run_once()
    assert ranked == [admin_user.id]


def test_a_kept_ranking_is_renewed_before_it_lapses(
    client, session, admin_user, monkeypatch
):
    """A ranking is kept for a while only; the background makes the next one
    shortly before, so a request never finds none."""
    from types import SimpleNamespace

    from app.services.discovery import runtime as runtime_mod
    from app.services.discovery import warm

    _discovered(session, admin_user, "found000001", "Found", "Chan")
    _feed(client)
    kept_since = [runtime_mod.time.monotonic()]
    monkeypatch.setattr(
        runtime_mod, "time", SimpleNamespace(monotonic=lambda: kept_since[0])
    )
    ranked = _count_rankings(monkeypatch)
    warmer, _clock = _warmer()
    kept_since[0] += runtime_mod.FEED_CACHE_TTL_SEC - warm.RENEW_EARLY_SEC - 1
    warmer.run_once()
    assert ranked == []
    kept_since[0] += 2  # Still kept for requests, but not for long.
    warmer.run_once()
    assert ranked == [admin_user.id]
    _feed(client)
    assert ranked == [admin_user.id]

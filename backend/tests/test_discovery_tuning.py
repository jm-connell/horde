"""Recommended+ settings: presets, own values, and what each changes in the feed."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from tests.test_discovery import (
    _catalog,
    _discovered,
    _embed,
    _history,
    _items,
    _vec,
    _watched,
    _yt,
)
from tests.test_discovery import ai_on as _ai_on
from tests.test_discovery import youtube as _youtube

# Fixtures shared with test_discovery, under the names the tests take.
ai_on = _ai_on
youtube = _youtube


def _custom(client, **changes):
    """Save own values: Balanced with ``changes``; returns the response body."""
    values = client.get("/api/discover/tuning").json()["defaults"]
    for key, value in changes.items():
        if isinstance(value, dict):
            values[key] = {**values[key], **value}
        else:
            values[key] = value
    resp = client.put(
        "/api/discover/tuning", json={"active": "custom", "custom": values}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_settings_start_on_balanced_and_list_the_presets(client):
    body = client.get("/api/discover/tuning").json()
    assert body["active"] == "balanced"
    assert body["custom"] is None
    assert body["values"] == body["defaults"]
    ids = [p["id"] for p in body["presets"]]
    assert ids[0] == "balanced"
    assert {"catch_up", "familiar", "explorer", "nostalgia"} <= set(ids)
    # Balanced keeps rewatches a small share.
    shares = body["defaults"]["shares"]
    assert 0 < shares["rewatch"] <= 5
    assert shares["rewatch"] < min(v for k, v in shares.items() if k != "rewatch")


def test_settings_are_validated(client):
    defaults = client.get("/api/discover/tuning").json()["defaults"]
    bad = {**defaults, "freshness": 101}
    assert (
        client.put(
            "/api/discover/tuning", json={"active": "custom", "custom": bad}
        ).status_code
        == 422
    )
    unknown = {**defaults, "made_up": 1}
    assert (
        client.put(
            "/api/discover/tuning", json={"active": "custom", "custom": unknown}
        ).status_code
        == 422
    )
    lengths = {**defaults, "min_minutes": 20, "max_minutes": 10}
    assert (
        client.put(
            "/api/discover/tuning", json={"active": "custom", "custom": lengths}
        ).status_code
        == 422
    )
    resp = client.put("/api/discover/tuning", json={"active": "nope"})
    assert resp.status_code == 400 and resp.json()["code"] == "unknown_preset"
    resp = client.put("/api/discover/tuning", json={"active": "custom"})
    assert resp.status_code == 400 and resp.json()["code"] == "missing_values"


def test_own_values_are_kept_while_a_preset_is_picked(client):
    _custom(client, freshness=90)
    body = client.put("/api/discover/tuning", json={"active": "explorer"}).json()
    assert body["active"] == "explorer"
    assert body["custom"]["freshness"] == 90
    explorer = next(p for p in body["presets"] if p["id"] == "explorer")
    assert body["values"] == explorer["values"]
    # Back to their own values without sending them again.
    body = client.put("/api/discover/tuning", json={"active": "custom"}).json()
    assert body["active"] == "custom" and body["values"]["freshness"] == 90


def test_settings_are_per_user(client, member_client):
    _custom(client, freshness=10)
    assert member_client.get("/api/discover/tuning").json()["active"] == "balanced"
    resp = member_client.put("/api/discover/tuning", json={"active": "catch_up"})
    assert resp.status_code == 200, resp.text
    assert client.get("/api/discover/tuning").json()["values"]["freshness"] == 10


def test_a_zero_share_turns_a_kind_of_pick_off(client, session, admin_user):
    _discovered(session, admin_user, "newchannel1", "Never seen", "Stranger")
    keys = [i["key"] for i in _items(client)]
    assert "newchannel1" in keys
    # The cached ranking is not reused once the settings change.
    _custom(client, shares={"new": 0})
    assert "newchannel1" not in [i["key"] for i in _items(client)]


def test_filters_leave_out_live_replays_and_lengths(client, session, admin_user):
    """Shorts are left out when Horde collects videos; a ``hide_shorts`` saved
    by an older version no longer hides anything (the panel has no switch)."""
    _discovered(session, admin_user, "shortvideo1", "A short", "One", duration=45.0)
    _discovered(
        session, admin_user, "livereplay1", "A replay", "Two", live_status="was_live"
    )
    _discovered(session, admin_user, "longvideo01", "Long", "Three", duration=7200.0)
    _discovered(session, admin_user, "normalvid01", "Normal", "Four", duration=600.0)
    assert {"shortvideo1", "livereplay1", "longvideo01", "normalvid01"} <= {
        i["key"] for i in _items(client)
    }
    _custom(client, hide_shorts=True, hide_past_live=True, max_minutes=60)
    keys = {i["key"] for i in _items(client)}
    assert keys & {"livereplay1", "longvideo01"} == set()
    assert {"normalvid01", "shortvideo1"} <= keys
    _custom(client, min_minutes=30)
    assert {i["key"] for i in _items(client)} >= {"longvideo01"}
    assert "normalvid01" not in {i["key"] for i in _items(client)}


def test_sources_can_be_switched_off(client, session, admin_user):
    _discovered(session, admin_user, "foundonyt01", "Found", "Somebody")
    _catalog(session, "Indexed", [("catalogvid1", "Indexed upload", 3, None)])
    keys = {i["key"] for i in _items(client)}
    assert {"foundonyt01", "catalogvid1"} <= keys
    _custom(client, use_youtube=False)
    keys = {i["key"] for i in _items(client)}
    assert "foundonyt01" not in keys and "catalogvid1" in keys
    _custom(client, use_catalogs=False)
    keys = {i["key"] for i in _items(client)}
    assert "catalogvid1" not in keys and "foundonyt01" in keys


def test_old_favorites_come_back_as_rewatches(
    client, session, admin_user, add_video, set_watch
):
    old = add_video(title="Old favorite", channel="Fav", yt_id="oldfavorite")
    set_watch(admin_user, old, 0, datetime.now(UTC) - timedelta(days=200))
    recent = add_video(title="Seen lately", channel="Fav", yt_id="seenlately1")
    set_watch(admin_user, recent, 0, datetime.now(UTC) - timedelta(days=5))
    half = add_video(
        title="Left early", channel="Fav", yt_id="lefthalfway", duration_sec=600
    )
    set_watch(admin_user, half, 100, datetime.now(UTC) - timedelta(days=200))
    client.post(
        "/api/discover/history",
        json={
            "url": _yt("streamedfav"),
            "title": "Streamed favorite",
            "channel": "Fav",
            "position_sec": 600,
            "duration_sec": 600,
        },
    )
    from app.models import UserStreamState

    row = session.get(UserStreamState, (admin_user.id, "streamedfav"))
    assert row is not None
    row.last_watched_at = datetime.now(UTC) - timedelta(days=300)
    session.add(row)
    session.commit()

    by_key = {i["key"]: i for i in _items(client)}
    assert by_key["oldfavorite"]["reason"]["kind"] == "rewatch"
    assert by_key["oldfavorite"]["why"]["bucket"] == "rewatch"
    assert by_key["oldfavorite"]["reason"]["text"].startswith("You watched this")
    stream = by_key["streamedfav"]
    assert stream["reason"]["kind"] == "rewatch" and stream["stream"] is not None
    assert stream["stream"]["url"] == _yt("streamedfav")
    # Not finished, or watched lately: not a rewatch.
    assert "lefthalfway" not in by_key and "seenlately1" not in by_key

    _custom(client, rewatch_after_days=365)
    keys = {i["key"] for i in _items(client)}
    assert "oldfavorite" not in keys and "streamedfav" not in keys
    _custom(client, shares={"rewatch": 0})
    assert "oldfavorite" not in {i["key"] for i in _items(client)}


def test_abandoned_watches_can_stop_counting_as_taste(
    client, session, admin_user, add_video, set_watch
):
    # The only channel watched lately, opened and left at 10%.
    watched = add_video(
        title="Opened", channel="Lab", yt_id="labopened01", duration_sec=1000
    )
    set_watch(admin_user, watched, 100, datetime.now(UTC) - timedelta(days=1))
    _catalog(session, "Lab", [("labupload01", "Lab upload", 2, None)])
    by_key = {i["key"]: i for i in _items(client)}
    assert by_key["labupload01"]["reason"]["kind"] == "subscription"
    _custom(client, min_watched_pct=50)
    by_key = {i["key"]: i for i in _items(client)}
    assert by_key["labupload01"]["reason"]["kind"] != "subscription"


def test_every_pick_says_why_and_the_mix_is_reported(
    client, session, add_video, set_watch, admin_user, ai_on
):
    for n in range(3):
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
    _discovered(session, admin_user, "closetolab1", "Close", "Stranger", _vec(0.03))
    # Relevance is scaled against the whole pool, so give it something far away.
    for n in range(3):
        _discovered(
            session, admin_user, f"faraway{n:04d}", "Far", f"Other {n}", _vec(1.4, 1)
        )
    body = client.get("/api/discover/feed", params={"limit": 60}).json()
    item = next(i for i in body["items"] if i["key"] == "closetolab1")
    why = item["why"]
    assert why["bucket"] == "new"
    assert why["found_by"] == "YouTube search: q"
    assert abs(sum(p["value"] for p in why["parts"]) - why["score"]) < 1e-3
    assert any(p["label"] == "Match to your taste" for p in why["parts"]), why
    buckets = {m["bucket"]: m for m in body["mix"]}
    assert set(buckets) == {"subscriptions", "similar", "new", "throwback", "rewatch"}
    assert abs(sum(m["target"] for m in body["mix"]) - 1) < 1e-6
    assert buckets["new"]["actual"] > 0
    # Later pages leave the mix out.
    cursor = client.get("/api/discover/feed", params={"limit": 1}).json()["next_cursor"]
    assert (
        client.get("/api/discover/feed", params={"cursor": cursor}).json()["mix"] == []
    )


def test_the_gatherer_skips_users_who_turned_youtube_off(
    client, session, add_video, set_watch, admin_user, youtube, tmp_dirs
):
    from app.models import DiscoveryState
    from app.services.discovery import gather

    calls, _answers = youtube
    _history(session, add_video, set_watch, admin_user)
    _custom(client, use_youtube=False)
    assert gather.gather_for(session, tmp_dirs["ctx"].discovery, admin_user.id) == 0
    assert calls == []
    # The run is still recorded, so the worker does not retry at once.
    state = session.get(DiscoveryState, admin_user.id)
    assert state is not None and state.last_run_at is not None


def test_unreadable_saved_settings_fall_back_to_balanced(client, session, admin_user):
    from app.models import UserSettings

    row = session.get(UserSettings, admin_user.id) or UserSettings(
        user_id=admin_user.id
    )
    row.rec_tuning_json = '{"active": 5'
    session.add(row)
    session.commit()
    assert client.get("/api/discover/tuning").json()["active"] == "balanced"
    assert client.get("/api/discover/feed").status_code == 200


def _old_stream(session, user, yt_id, *, days, duration=600.0, finished=True):
    from app.models import UserStreamState

    when = datetime.now(UTC) - timedelta(days=days)
    session.add(
        UserStreamState(
            user_id=user.id,
            yt_id=yt_id,
            url=_yt(yt_id),
            title=f"Stream {yt_id}",
            channel="Fav",
            duration_sec=duration,
            watched_sec=duration,
            finished_at=when if finished else None,
            last_watched_at=when,
        )
    )


def test_a_long_history_does_not_show_a_favorite_twice(client, session, admin_user):
    # More recent watches than the taste history reads: the old favorite is
    # outside it, but it is still watched, so it comes once, as a rewatch.
    for n in range(620):
        _old_stream(session, admin_user, f"recent{n:05d}", days=1, finished=False)
    _old_stream(session, admin_user, "catalogfav1", days=200)
    session.commit()
    _catalog(session, "Fav", [("catalogfav1", "An old favorite", 400, None)])
    keys = [i["key"] for i in _items(client)]
    assert keys.count("catalogfav1") == 1
    assert len(keys) == len(set(keys))


def test_streamed_favorites_keep_to_the_length_filters(client, session, admin_user):
    _old_stream(session, admin_user, "oldshort001", days=200, duration=40.0)
    _old_stream(session, admin_user, "oldlongone1", days=200, duration=900.0)
    session.commit()
    keys = {i["key"] for i in _items(client)}
    assert {"oldshort001", "oldlongone1"} <= keys
    _custom(client, min_minutes=1)
    keys = {i["key"] for i in _items(client)}
    assert "oldshort001" not in keys and "oldlongone1" in keys


def test_preferring_downloaded_videos_fills_the_top_with_them(
    client, session, add_video, set_watch, admin_user, ai_on
):
    """At 100%, downloaded videos lead the feed even when videos found on
    YouTube are closer matches (they used to wait at the end of the feed)."""
    old = datetime.now(UTC) - timedelta(days=300)
    # One downloaded video per channel: the channel spacing applies to them too.
    for c, channel in enumerate(("Lab", "Bench", "Shop", "Desk", "Yard", "Loft")):
        for n in range(2):
            _watched(
                session,
                add_video,
                set_watch,
                admin_user,
                _vec(0.02 * n + 0.01 * c),
                channel=channel,
                title=f"{channel} watched {n}",
                yt_id=f"watch{c}{n}xxxx",
            )
        video = add_video(
            channel=channel,
            title=f"{channel} downloaded",
            yt_id=f"dlvid{c}xxxxx",
            # Not a new upload: a "more like what you watch" pick.
            published_at=old,
            added_at=old,
        )
        # Related to what was watched, but less close than the found ones.
        _embed(session, video, _vec(0.55 + 0.03 * c))
    for c, channel in enumerate(("Far", "Away", "Else")):
        for n in range(3):
            _discovered(
                session,
                admin_user,
                f"found{c}{n}xxxx",
                f"{channel} found {n}",
                channel,
                _vec(0.03 + 0.01 * n + 0.01 * c),
            )

    def downloaded_on_top() -> int:
        return sum(1 for i in _items(client)[:6] if i["video"] is not None)

    assert downloaded_on_top() <= 2
    _custom(client, library_boost=100)
    assert downloaded_on_top() >= 5

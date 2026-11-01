"""History: one timeline of library, streamed and imported YouTube watches,
removing videos from it, and keeping watches out of recommendations."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlmodel import select

from app.models import (
    UserStreamState,
    UserVideoState,
    UserWatchTime,
    YoutubeWatchEvent,
)
from tests.test_discovery import _catalog, _items, _yt


def _ago(**kw) -> datetime:
    return datetime.now(UTC) - timedelta(**kw)


def _stream(session, user, yt_id, *, when, title="Streamed", channel="Chan"):
    session.add(
        UserStreamState(
            user_id=user.id,
            yt_id=yt_id,
            url=_yt(yt_id),
            title=title,
            channel=channel,
            duration_sec=600.0,
            watched_sec=300.0,
            last_watched_at=when,
        )
    )
    session.commit()


def _youtube(session, user, yt_id, *, when, title="On YouTube", channel="Tube"):
    session.add(
        YoutubeWatchEvent(
            user_id=user.id, yt_id=yt_id, watched_at=when, title=title, channel=channel
        )
    )
    session.commit()


def _history(client, **params):
    resp = client.get("/api/history/watches", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_history_is_one_timeline_of_every_kind_of_watch(
    client, session, admin_user, add_video, set_watch
):
    video = add_video(title="Downloaded", yt_id="librarywat1")
    set_watch(admin_user, video, 120, _ago(hours=1))
    _stream(session, admin_user, "streamwatch", when=_ago(hours=2))
    _youtube(session, admin_user, "youtubeview", when=_ago(hours=3))
    _youtube(session, admin_user, "youtubeview", when=_ago(days=40))
    # The same video watched on YouTube and then downloaded: one entry.
    _youtube(session, admin_user, "librarywat1", when=_ago(days=2))

    body = _history(client)
    assert body["total"] == 3
    keys = [i["key"] for i in body["items"]]
    assert keys == ["librarywat1", "streamwatch", "youtubeview"]
    lib, stream, tube = body["items"]
    assert lib["video"]["title"] == "Downloaded" and lib["stream"] is None
    assert lib["sources"] == ["library", "youtube"]
    assert lib["youtube_views"] == 1
    assert stream["sources"] == ["stream"] and stream["fraction"] == 0.5
    assert stream["stream"]["url"] == _yt("streamwatch")
    assert tube["sources"] == ["youtube"] and tube["youtube_views"] == 2
    assert tube["fraction"] is None and tube["stream"]["title"] == "On YouTube"


def test_history_pages(client, session, admin_user):
    for n in range(5):
        _stream(session, admin_user, f"pagedwatch{n}", when=_ago(hours=n + 1))
    first = _history(client, limit=2)
    assert [i["key"] for i in first["items"]] == ["pagedwatch0", "pagedwatch1"]
    second = _history(client, limit=2, cursor=first["next_cursor"])
    assert second["total"] is None
    third = _history(client, limit=2, cursor=second["next_cursor"])
    assert [i["key"] for i in third["items"]] == ["pagedwatch4"]
    assert third["next_cursor"] is None
    assert client.get("/api/history/watches?cursor=junk").status_code == 400


def test_removing_a_video_forgets_every_record_but_keeps_watch_time(
    client, session, admin_user, add_video, set_watch
):
    video = add_video(title="Downloaded", yt_id="forgetme001")
    set_watch(admin_user, video, 0, _ago(days=1))
    session.add(
        UserWatchTime(
            user_id=admin_user.id,
            video_id=video.id,
            hour_start=_ago(days=1).replace(minute=0, second=0, microsecond=0),
            seconds=600.0,
        )
    )
    session.commit()
    _stream(session, admin_user, "forgetme001", when=_ago(days=3))
    _youtube(session, admin_user, "forgetme001", when=_ago(days=5))
    _stream(session, admin_user, "keepthis001", when=_ago(days=1))
    client.post(
        "/api/history/watches/taste", json={"keys": ["forgetme001"], "use": False}
    )

    resp = client.post("/api/history/watches/remove", json={"keys": ["forgetme001"]})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"videos": 1, "library": 1, "streams": 1, "youtube_views": 1}
    assert [i["key"] for i in _history(client)["items"]] == ["keepthis001"]
    session.expire_all()
    assert session.get(UserVideoState, (admin_user.id, video.id)) is None
    assert session.exec(select(YoutubeWatchEvent)).all() == []
    # Watch time is history of time spent: it stays.
    assert len(session.exec(select(UserWatchTime)).all()) == 1
    # Unwatched again: it may be recommended.
    assert "forgetme001" in [i["key"] for i in _items(client)]


def test_removing_only_touches_your_own_history(
    client, member_client, session, admin_user, member_user
):
    _stream(session, admin_user, "sharedvideo", when=_ago(days=1))
    _stream(session, member_user, "sharedvideo", when=_ago(days=1))
    member_client.post("/api/history/watches/remove", json={"keys": ["sharedvideo"]})
    assert [i["key"] for i in _history(client)["items"]] == ["sharedvideo"]
    assert _history(member_client)["items"] == []


def test_a_watch_can_stop_shaping_recommendations(
    client, session, admin_user, add_video, set_watch
):
    # The only channel watched lately: its new upload is "New from Lab".
    watched = add_video(title="Lab video", channel="Lab", yt_id="labwatched1")
    set_watch(admin_user, watched, 0, _ago(days=1))
    _catalog(session, "Lab", [("labupload01", "Lab upload", 2, None)])
    by_key = {i["key"]: i for i in _items(client)}
    assert by_key["labupload01"]["reason"]["kind"] == "subscription"

    resp = client.post(
        "/api/history/watches/taste", json={"keys": ["labwatched1"], "use": False}
    )
    assert resp.status_code == 200 and resp.json()["excluded"] is True
    assert _history(client)["items"][0]["excluded"] is True
    by_key = {i["key"]: i for i in _items(client)}
    assert by_key["labupload01"]["reason"]["kind"] != "subscription"
    # Still watched: it does not come back as a recommendation.
    assert "labwatched1" not in by_key
    # Kept out of the Account page's hidden list (History lists it).
    assert client.get("/api/discover/feedback").json()["items"] == []

    client.post(
        "/api/history/watches/taste", json={"keys": ["labwatched1"], "use": True}
    )
    assert _history(client)["items"][0]["excluded"] is False
    by_key = {i["key"]: i for i in _items(client)}
    assert by_key["labupload01"]["reason"]["kind"] == "subscription"


def test_history_keys_are_validated(client):
    assert (
        client.post("/api/history/watches/remove", json={"keys": []}).status_code == 422
    )
    assert (
        client.post(
            "/api/history/watches/remove", json={"keys": ["x" * 65]}
        ).status_code
        == 422
    )


def test_recent_youtube_views_join_continue_watching(
    client, session, admin_user, add_video
):
    for n in range(7):
        _youtube(session, admin_user, f"recentview{n}", when=_ago(hours=n + 1))
    _youtube(session, admin_user, "oldview0001", when=_ago(days=30))
    add_video(title="Downloaded", yt_id="inlibrary01")
    _youtube(session, admin_user, "inlibrary01", when=_ago(minutes=5))
    body = client.get("/api/history/continue-youtube").json()
    keys = [i["id"] for i in body["items"]]
    # The five newest, not in the library, inside the Continue watching window.
    assert keys == [f"recentview{n}" for n in range(5)]
    assert body["items"][0]["url"] == _yt("recentview0")

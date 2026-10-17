"""Followed channels: the API, library seeding and follow-on-download."""

from __future__ import annotations

from typing import Any

import pytest
from sqlmodel import Session, select

from app.models import ChannelFollow, DownloadRequester, JobStatus
from app.services import follows
from app.services.url_safety import UrlFetchError

CHANNEL_PAGE = (
    '<html><head><meta property="og:title" content="Tom &amp; Jerry"></head></html>'
)


@pytest.fixture
def fetched(monkeypatch) -> list[str]:
    """Channel page lookups answered with a synthetic channel page; no network."""
    seen: list[str] = []

    def fake(url: str, *, timeout: float = 20.0) -> str:
        seen.append(url)
        return CHANNEL_PAGE

    monkeypatch.setattr("app.api.follows.fetch_live_page", fake)
    return seen


def _rows(engine, **where: Any) -> list[ChannelFollow]:
    with Session(engine) as s:
        stmt = select(ChannelFollow)
        for k, v in where.items():
            stmt = stmt.where(getattr(ChannelFollow, k) == v)
        return list(s.exec(stmt).all())


def test_follow_by_handle_normalizes_and_names_from_page(client, fetched):
    resp = client.put("/api/follows", json={"channel_url": "@TomJerry"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["channel_url"] == "https://youtube.com/@tomjerry"
    assert body["channel_name"] == "Tom & Jerry"
    assert body["source"] == "manual"
    assert fetched == ["https://youtube.com/@tomjerry"]

    listed = client.get("/api/follows").json()["items"]
    assert [i["channel_url"] for i in listed] == ["https://youtube.com/@tomjerry"]


def test_follow_by_full_url_with_tab_and_www(client, fetched):
    resp = client.put(
        "/api/follows",
        json={"channel_url": "https://www.youtube.com/@Some.Chan/videos/"},
    )
    assert resp.status_code == 200
    assert resp.json()["channel_url"] == "https://youtube.com/@some.chan"


def test_explicit_name_wins_over_the_page(client, fetched):
    resp = client.put(
        "/api/follows",
        json={"channel_url": "@named", "channel_name": "  My Name "},
    )
    assert resp.json()["channel_name"] == "My Name"


def test_name_hint_comes_from_the_library(client, fetched, add_video):
    add_video(channel="Library Name", channel_url="https://www.youtube.com/@libchan")
    resp = client.put("/api/follows", json={"channel_url": "@libchan"})
    assert resp.json()["channel_name"] == "Library Name"


def test_follow_survives_a_failed_lookup(client, monkeypatch):
    def boom(url: str, *, timeout: float = 20.0) -> str:
        raise UrlFetchError("Server answered 500")

    monkeypatch.setattr("app.api.follows.fetch_live_page", boom)
    resp = client.put("/api/follows", json={"channel_url": "@offline"})
    assert resp.status_code == 200
    assert resp.json()["channel_name"] is None


def test_follow_records_the_live_state_from_the_page(client, monkeypatch, app):
    from app.services.live.page import LiveBroadcast

    monkeypatch.setattr("app.api.follows.fetch_live_page", lambda *a, **k: "<html>")
    broadcast = LiveBroadcast("abcdefghijk", "t", "Live Chan", None, None, None)
    monkeypatch.setattr("app.api.follows.parse_live_page", lambda html: broadcast)
    resp = client.put("/api/follows", json={"channel_url": "@livechan"})
    assert resp.json()["channel_name"] == "Live Chan"
    state = app.state.ctx.live.directory.get("https://youtube.com/@livechan")
    assert state is not None and state.broadcast == broadcast


@pytest.mark.parametrize(
    "value",
    ["https://vimeo.com/@someone", "https://example.com/c/x", "http://localhost/x"],
)
def test_non_youtube_or_unsafe_urls_are_rejected(client, fetched, value):
    resp = client.put("/api/follows", json={"channel_url": value})
    assert resp.status_code == 400
    assert resp.json()["code"] in {"not_followable", "invalid_url"}
    assert client.get("/api/follows").json()["items"] == []
    assert fetched == []  # no page of another site is ever requested


def test_unsafe_url_is_never_fetched(client, fetched):
    resp = client.put("/api/follows", json={"channel_url": "http://localhost/x"})
    assert resp.status_code == 400
    assert fetched == []


def test_non_youtube_url_has_not_followable_code(client, fetched):
    resp = client.put("/api/follows", json={"channel_url": "https://vimeo.com/@x"})
    assert resp.json()["code"] == "not_followable"


def test_unfollow_and_refollow(client, fetched, init_db):
    url = "https://youtube.com/@tomjerry"
    client.put("/api/follows", json={"channel_url": "@tomjerry"})
    resp = client.delete(
        "/api/follows", params={"channel_url": "https://www.youtube.com/@TomJerry/"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"channel_url": url, "following": False}
    assert client.get("/api/follows").json()["items"] == []
    [row] = _rows(init_db["engine"], channel_url=url)
    assert row.followed is False  # tombstone
    again = client.put("/api/follows", json={"channel_url": "@tomjerry"})
    assert again.status_code == 200
    assert len(client.get("/api/follows").json()["items"]) == 1
    assert len(_rows(init_db["engine"], channel_url=url)) == 1


def test_unfollow_of_unknown_channel_is_ok(client):
    resp = client.delete(
        "/api/follows", params={"channel_url": "https://youtube.com/@no"}
    )
    assert resp.status_code == 200
    assert resp.json()["following"] is False


def test_list_is_sorted_by_name(client, fetched):
    client.put("/api/follows", json={"channel_url": "@bbb", "channel_name": "zeta"})
    client.put("/api/follows", json={"channel_url": "@aaa", "channel_name": "Beta"})
    client.put("/api/follows", json={"channel_url": "@ccc", "channel_name": "alpha"})
    names = [i["channel_name"] for i in client.get("/api/follows").json()["items"]]
    assert names == ["alpha", "Beta", "zeta"]


def test_get_never_seeds(client, member_client, add_video):
    add_video(channel="One", channel_url="https://www.youtube.com/@one")
    assert client.get("/api/follows").json()["items"] == []
    assert member_client.get("/api/follows").json()["items"] == []


def test_seed_administrators_follows_library_channels_once(
    session, admin_user, add_video, init_db
):
    add_video(channel="One", channel_url="https://www.youtube.com/@one")
    add_video(channel="Two", channel_url="https://www.youtube.com/@two/videos")
    add_video(channel="NoUrl", channel_url=None)
    add_video(channel="Other Site", channel_url="https://vimeo.com/other")
    assert follows.seed_administrators() == 2
    items = follows.list_follows(session, admin_user.id)
    assert [(i.channel_url, i.channel_name, i.source) for i in items] == [
        ("https://youtube.com/@one", "One", "library"),
        ("https://youtube.com/@two", "Two", "library"),
    ]
    # A second call changes nothing, and unfollowing everything (tombstones) keeps
    # the list from coming back even with a new library channel.
    assert follows.seed_administrators() == 0
    for item in items:
        follows.unfollow(session, admin_user.id, item.channel_url)
    add_video(channel="Three", channel_url="https://www.youtube.com/@three")
    assert follows.seed_administrators() == 0
    assert follows.list_follows(session, admin_user.id) == []


def test_seed_administrators_skips_members_and_disabled_admins(
    session, admin_user, member_user, add_video, init_db
):
    from app.services.auth import accounts

    add_video(channel="One", channel_url="https://www.youtube.com/@one")
    second = accounts.create_user(session, "admin2", "admin-password", is_admin=True)
    second.disabled = True
    session.add(second)
    session.commit()
    assert follows.seed_administrators() == 1
    assert len(follows.list_follows(session, admin_user.id)) == 1
    assert follows.list_follows(session, member_user.id) == []
    assert follows.list_follows(session, second.id) == []


def test_follows_are_per_user(client, member_client, fetched, init_db):
    client.put("/api/follows", json={"channel_url": "@adminonly"})
    member_client.put("/api/follows", json={"channel_url": "@memberonly"})
    admin_urls = {i["channel_url"] for i in client.get("/api/follows").json()["items"]}
    member_urls = {
        i["channel_url"] for i in member_client.get("/api/follows").json()["items"]
    }
    assert admin_urls == {"https://youtube.com/@adminonly"}
    assert member_urls == {"https://youtube.com/@memberonly"}
    # One user unfollowing does not touch the other's row.
    member_client.put("/api/follows", json={"channel_url": "@adminonly"})
    client.delete(
        "/api/follows", params={"channel_url": "https://youtube.com/@adminonly"}
    )
    assert "https://youtube.com/@adminonly" in {
        i["channel_url"] for i in member_client.get("/api/follows").json()["items"]
    }


def test_anonymous_cannot_use_follows(anon_client):
    assert anon_client.get("/api/follows").status_code == 401
    assert (
        anon_client.put("/api/follows", json={"channel_url": "@x"}).status_code == 401
    )


# --- follow_from_download ---------------------------------------------------


def _job(session, url: str = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"):
    from app.models import DownloadJob

    job = DownloadJob(url=url, status=JobStatus.completed)
    session.add(job)
    session.commit()
    session.refresh(job)
    assert job.id is not None
    return job


def test_follow_from_download_follows_for_the_requester(
    session, admin_user, add_video, init_db
):
    video = add_video(channel="Dl Chan", channel_url="https://www.youtube.com/@dlchan")
    job = _job(session)
    assert job.id is not None and video.id is not None
    follows.record_requester(session, job.id, admin_user.id)
    session.commit()
    follows.follow_from_download(job.id, video.id)
    [row] = _rows(init_db["engine"], user_id=admin_user.id)
    assert row.channel_url == "https://youtube.com/@dlchan"
    assert row.channel_name == "Dl Chan"
    assert row.source == "download"
    assert row.followed is True


def test_follow_from_download_respects_an_explicit_unfollow(
    session, admin_user, add_video, init_db
):
    video = add_video(channel="Dl Chan", channel_url="https://www.youtube.com/@dlchan")
    follows.unfollow(session, admin_user.id, "https://www.youtube.com/@dlchan")
    job = _job(session)
    assert job.id is not None and video.id is not None
    follows.record_requester(session, job.id, admin_user.id)
    session.commit()
    follows.follow_from_download(job.id, video.id)
    [row] = _rows(init_db["engine"], user_id=admin_user.id)
    assert row.followed is False


def test_follow_from_download_without_requester_does_nothing(
    session, add_video, init_db
):
    video = add_video(channel="Dl Chan", channel_url="https://www.youtube.com/@dlchan")
    job = _job(session)
    assert job.id is not None and video.id is not None
    follows.follow_from_download(job.id, video.id)
    follows.follow_from_download(job.id, None)
    assert _rows(init_db["engine"]) == []


def test_follow_from_download_ignores_videos_without_a_channel_url(
    session, admin_user, add_video, init_db
):
    video = add_video(channel="No Url", channel_url=None)
    other = add_video(channel="Vimeo", channel_url="https://vimeo.com/x")
    job = _job(session)
    assert job.id is not None and video.id is not None and other.id is not None
    follows.record_requester(session, job.id, admin_user.id)
    session.commit()
    follows.follow_from_download(job.id, video.id)
    follows.follow_from_download(job.id, other.id)
    assert _rows(init_db["engine"]) == []


def test_follow_from_download_never_raises(session, admin_user):
    follows.follow_from_download(999999, 999999)


def test_followers_of_different_users_do_not_block_each_other(
    session, admin_user, member_user, add_video, init_db
):
    video = add_video(channel="Dl Chan", channel_url="https://www.youtube.com/@dlchan")
    follows.unfollow(session, admin_user.id, "https://youtube.com/@dlchan")
    job = _job(session)
    assert job.id is not None and video.id is not None
    follows.record_requester(session, job.id, member_user.id)
    session.commit()
    follows.follow_from_download(job.id, video.id)
    [row] = _rows(init_db["engine"], user_id=member_user.id)
    assert row.followed is True


# --- POST /api/downloads records the requester --------------------------------


@pytest.fixture
def no_runs(monkeypatch):
    """Creating a job must not start yt-dlp or queue work."""
    from app.services import job_metadata
    from app.services.downloads import jobs

    monkeypatch.setattr(jobs, "enqueue_download", lambda job_id: None)
    monkeypatch.setattr(job_metadata, "request_job_metadata", lambda job_id: None)


def test_create_download_records_the_requester(client, admin_user, no_runs, init_db):
    resp = client.post("/api/downloads", json={"url": "https://youtu.be/dQw4w9WgXcQ"})
    assert resp.status_code == 200
    job_id = resp.json()["id"]
    with Session(init_db["engine"]) as s:
        row = s.get(DownloadRequester, job_id)
        assert row is not None and row.user_id == admin_user.id


def test_create_download_by_member_records_the_member(
    member_client, member_user, no_runs, init_db
):
    resp = member_client.post(
        "/api/downloads", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )
    assert resp.status_code == 200
    with Session(init_db["engine"]) as s:
        row = s.get(DownloadRequester, resp.json()["id"])
        assert row is not None and row.user_id == member_user.id


def test_bulk_download_records_the_requester(client, admin_user, no_runs, init_db):
    resp = client.post(
        "/api/downloads/bulk",
        json={
            "urls": [
                "https://youtu.be/dQw4w9WgXcQ",
                "https://youtu.be/abcdefghijk",
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    with Session(init_db["engine"]) as s:
        rows = list(s.exec(select(DownloadRequester)).all())
    assert len(rows) == 2
    assert {r.user_id for r in rows} == {admin_user.id}

"""Parental controls: a member limited to some channels sees nothing else."""

from __future__ import annotations

import pytest

from app.services import stream_preview

KIDS_URL = "https://www.youtube.com/@kidscraft"


@pytest.fixture
def library(add_video):
    """One video of an allowed channel, one of another."""
    kids = add_video(
        title="Paper boats",
        channel="Kids Craft",
        channel_url=KIDS_URL,
        yt_id="kidsvideo01",
    )
    other = add_video(
        title="Late night horror",
        channel="Night Frights",
        channel_url="https://www.youtube.com/@nightfrights",
        yt_id="otherviden1",
    )
    return kids, other


def _restrict(client, member_user, channels):
    resp = client.put(
        f"/api/users/{member_user.id}/allowed-channels", json={"channels": channels}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture
def restricted(client, member_user, library):
    _restrict(client, member_user, [{"url": KIDS_URL, "name": "Kids Craft"}])
    return library


def test_an_admin_sets_and_lifts_the_list(client, member_client, member_user):
    body = _restrict(client, member_user, [{"url": KIDS_URL, "name": "Kids Craft"}])
    assert body["allowed_channels"] == [{"url": KIDS_URL, "name": "Kids Craft"}]
    # The grants are kept (lifting the list restores them), but the member
    # holds only what stays inside the list.
    assert "download" in body["permissions"]
    me = member_client.get("/api/auth/state").json()["user"]
    assert me["allowed_channels"] == [{"url": KIDS_URL, "name": "Kids Craft"}]
    assert set(me["permissions"]) <= {"offline_download"}

    lifted = client.put(
        f"/api/users/{member_user.id}/allowed-channels", json={"channels": None}
    ).json()
    assert lifted["allowed_channels"] is None
    assert "download" in lifted["permissions"]


def test_an_admin_cannot_be_restricted(client, admin_user):
    resp = client.put(
        f"/api/users/{admin_user.id}/allowed-channels",
        json={"channels": [{"url": KIDS_URL}]},
    )
    assert resp.status_code == 400
    assert resp.json()["code"] == "admin_unrestricted"


def test_members_cannot_set_the_list(member_client, member_user):
    resp = member_client.put(
        f"/api/users/{member_user.id}/allowed-channels", json={"channels": None}
    )
    assert resp.status_code == 403


def test_the_library_shows_only_allowed_channels(member_client, restricted):
    kids, other = restricted
    titles = [v["title"] for v in member_client.get("/api/videos").json()["items"]]
    assert titles == ["Paper boats"]
    # Search too, and the channel list.
    found = member_client.get("/api/videos", params={"q": "night"}).json()["items"]
    assert found == []
    channels = [c["channel"] for c in member_client.get("/api/channels").json()]
    assert channels == ["Kids Craft"]

    assert member_client.get(f"/api/videos/{kids.id}").status_code == 200
    # Another channel's video is not there at all.
    for path in (
        f"/api/videos/{other.id}",
        f"/api/videos/{other.id}/stream",
        f"/api/videos/{other.id}/related",
        f"/api/videos/{other.id}/comments",
        f"/api/thumbnails/{other.id}",
    ):
        resp = member_client.get(path)
        assert resp.status_code == 404, path


def test_an_unrestricted_member_sees_everything(member_client, library):
    titles = {v["title"] for v in member_client.get("/api/videos").json()["items"]}
    assert titles == {"Paper boats", "Late night horror"}


def test_youtube_search_is_closed(member_client, restricted):
    for path, params in (
        ("/api/youtube/search", {"q": "anything"}),
        ("/api/channels/search", {"q": "anything"}),
        ("/api/follows/preview", {"q": "@someone"}),
    ):
        resp = member_client.get(path, params=params)
        assert resp.status_code == 403, path
    # A channel page outside the list is refused.
    resp = member_client.get(
        "/api/channels/feed", params={"url": "https://www.youtube.com/@nightfrights"}
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "channel_not_allowed"


def test_a_stream_plays_only_from_an_allowed_channel(
    member_client, restricted, monkeypatch
):
    channels = {
        "streamkids1": ("Kids Craft", KIDS_URL),
        "streamnight": ("Night Frights", "https://www.youtube.com/@nightfrights"),
    }

    def meta(url):
        yt = url.rsplit("=", 1)[-1]
        name, channel_url = channels[yt]
        return {
            "id": yt,
            "title": "A stream",
            "channel": name,
            "channel_url": channel_url,
        }

    monkeypatch.setattr(stream_preview, "extract_stream_preview_meta", meta)
    other = "https://www.youtube.com/watch?v=streamnight"
    resp = member_client.get("/api/preview/meta", params={"url": other})
    assert resp.status_code == 403
    assert resp.json()["code"] == "channel_not_allowed"
    # Nor can its parts be fetched directly.
    assert (
        member_client.get("/api/preview/subtitles", params={"url": other, "lang": "en"})
    ).status_code == 403
    assert member_client.get("/api/comments/youtube/streamnight").status_code == 403

    kids = "https://www.youtube.com/watch?v=streamkids1"
    assert (
        member_client.get("/api/preview/meta", params={"url": kids}).status_code == 200
    )
    # Its metadata named an allowed channel: its other requests pass the guard
    # (the subtitle route then fails on its own: there is no YouTube here).
    resp = member_client.get(
        "/api/preview/subtitles", params={"url": kids, "lang": "en"}
    )
    assert resp.status_code != 403


def test_downloads_reach_only_allowed_videos(member_client, restricted):
    resp = member_client.post(
        "/api/downloads",
        json={
            "url": "https://www.youtube.com/watch?v=otherviden1",
            "destination": "device",
        },
    )
    assert resp.status_code == 403
    assert member_client.get("/api/downloads").json() == []

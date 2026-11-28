"""Parental controls: a member limited to some channels sees nothing else."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.context import get_paths
from app.models import (
    ChannelAutodownload,
    ChannelCatalog,
    ChannelCatalogVideo,
    UserWatchTime,
)
from app.services import parental, stream_preview, ytdlp_extract

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

    def meta(url, **_kw):
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


def test_a_url_without_a_readable_youtube_id_is_refused(member_client, restricted):
    """Review finding: unusual YouTube forms and other sites passed the guard."""
    for url in (
        "https://www.youtube.com/watch_popup?v=otherviden1",
        "https://www.youtube-nocookie.com/embed/otherviden1",
        "https://vimeo.com/123456",
    ):
        for path in ("/api/preview/manifest", "/api/preview/stream"):
            resp = member_client.get(path, params={"url": url})
            assert resp.status_code == 403, (path, url)
    # An allowed channel's own URL (its live broadcast) still passes the guard.
    resp = member_client.get("/api/live/channel", params={"url": KIDS_URL})
    assert resp.status_code != 403


def test_bulk_device_downloads_are_checked_too(member_client, restricted):
    resp = member_client.post(
        "/api/downloads/bulk",
        json={
            "urls": ["https://www.youtube.com/watch?v=zzzzzzzzzzz"],
            "destination": "device",
        },
    )
    assert resp.status_code == 403
    assert member_client.get("/api/downloads").json() == []


def test_a_look_alike_channel_name_is_not_enough(
    member_client, restricted, monkeypatch
):
    monkeypatch.setattr(
        stream_preview,
        "extract_stream_preview_meta",
        lambda url, **_kw: {
            "id": "lookalike01",
            "title": "Not really",
            "channel": "kids craft",
            "channel_url": "https://www.youtube.com/@impostor",
        },
    )
    resp = member_client.get(
        "/api/preview/meta",
        params={"url": "https://www.youtube.com/watch?v=lookalike01"},
    )
    assert resp.status_code == 403


def test_a_look_alike_library_video_is_hidden(member_client, restricted, add_video):
    add_video(
        title="Impostor upload",
        channel="Kids Craft",
        channel_url="https://www.youtube.com/@impostor",
        yt_id="impostor001",
    )
    titles = [v["title"] for v in member_client.get("/api/videos").json()["items"]]
    assert titles == ["Paper boats"]


def test_the_import_queue_is_closed(member_client, restricted):
    assert member_client.get("/api/review").status_code == 403


def test_changing_the_list_forgets_checked_streams(
    client, member_client, member_user, restricted, monkeypatch
):
    monkeypatch.setattr(
        stream_preview,
        "extract_stream_preview_meta",
        lambda url, **_kw: {
            "id": "streamkids1",
            "title": "A stream",
            "channel": "Kids Craft",
            "channel_url": KIDS_URL,
        },
    )
    kids = "https://www.youtube.com/watch?v=streamkids1"
    assert (
        member_client.get("/api/preview/meta", params={"url": kids}).status_code == 200
    )
    _restrict(
        client,
        member_user,
        [{"url": "https://www.youtube.com/@other", "name": "Other"}],
    )
    resp = member_client.get(
        "/api/preview/subtitles", params={"url": kids, "lang": "en"}
    )
    assert resp.status_code == 403


def test_continue_watching_streams_shows_only_allowed_channels(
    member_client, member_user, client, library
):
    for yt_id, channel, channel_url in [
        ("kidsstrm001", "Kids Craft", KIDS_URL),
        ("otherstrm01", "Night Frights", "https://www.youtube.com/@nightfrights"),
    ]:
        resp = member_client.post(
            "/api/discover/history",
            json={
                "url": f"https://www.youtube.com/watch?v={yt_id}",
                "channel": channel,
                "channel_url": channel_url,
                "position_sec": 600,
                "duration_sec": 3600,
            },
        )
        assert resp.status_code == 200, resp.text
    _restrict(client, member_user, [{"url": KIDS_URL, "name": "Kids Craft"}])
    resp = member_client.get("/api/history/continue-streams")
    assert resp.status_code == 200, resp.text
    assert [i["id"] for i in resp.json()["items"]] == ["kidsstrm001"]


def test_an_allowed_channel_url_cannot_carry_another_video(
    member_client, restricted, monkeypatch
):
    """Review finding: ``@allowed?v=OTHER`` passed the guard as the allowed
    channel's own URL, and yt-dlp then played OTHER."""
    seen: list[str] = []

    def resolve(url):
        seen.append(url)
        return object()

    monkeypatch.setattr(stream_preview, "resolve_preview_manifest", resolve)
    monkeypatch.setattr(stream_preview, "build_dash_manifest", lambda s: "<MPD/>")
    for url in (
        f"{KIDS_URL}?v=otherviden1",
        f"{KIDS_URL}/live?v=otherviden1",
        f"{KIDS_URL}#v=otherviden1",
        f"{KIDS_URL}/videos",
        "https://www.youtube.com/channel/UCkidscraft0000000000000?v=otherviden1",
    ):
        for method, path in (
            ("GET", "/api/preview/manifest"),
            ("HEAD", "/api/preview/manifest"),
            ("GET", "/api/preview/stream"),
            ("GET", "/api/preview/subtitles"),
        ):
            resp = member_client.request(
                method, path, params={"url": url, "lang": "en"}
            )
            assert resp.status_code == 403, (method, path, url)
    assert seen == []


def test_the_live_check_takes_only_an_allowed_channel(member_client, restricted):
    resp = member_client.get(
        "/api/live/channel", params={"url": "https://www.youtube.com/@nightfrights"}
    )
    assert resp.status_code == 403
    for url in (KIDS_URL, f"{KIDS_URL}/live", f"{KIDS_URL}?v=otherviden1"):
        # The check reads only the channel's own /live page, whatever the query.
        resp = member_client.get("/api/live/channel", params={"url": url})
        assert resp.status_code == 200, (url, resp.text)


HOME = {"url": None, "name": "Home Videos"}
NIGHT_URL = "https://www.youtube.com/@nightfrights"


def test_a_name_counts_only_without_a_url():
    """Review finding: a name-only entry matched YouTube data that named it
    under any channel URL."""
    allowed = parental.parse(
        '[{"url": null, "name": "Home Videos"}, '
        '{"url": "https://www.youtube.com/@kidscraft", "name": "Kids Craft"}]'
    )
    assert allowed is not None
    assert allowed.allows(KIDS_URL, "Anything")
    assert allowed.allows(None, "home videos")
    assert allowed.allows(None, "Kids Craft")
    assert not allowed.allows(NIGHT_URL, "Home Videos")
    assert not allowed.allows(NIGHT_URL, "Kids Craft")
    # A library video was downloaded, so its channel is what it says: a
    # channel allowed by name only covers its videos with a URL too.
    assert allowed.allows_library(NIGHT_URL, "Home Videos")
    assert not allowed.allows_library(NIGHT_URL, "Kids Craft")


def test_a_channel_page_named_like_an_allowed_channel_is_refused(
    member_client, member_user, client, monkeypatch
):
    _restrict(client, member_user, [HOME])

    def fetch(*_args, **_kwargs):
        raise AssertionError("fetched a channel outside the list")

    monkeypatch.setattr(ytdlp_extract, "fetch_channel_feed", fetch)
    resp = member_client.get(
        "/api/channels/feed",
        params={"url": NIGHT_URL, "channel": "Home Videos", "tab": "streams"},
    )
    assert resp.status_code == 403


def test_a_catalog_named_like_an_allowed_channel_plays_nothing(
    member_client, member_user, client, session
):
    """Anyone who opens a channel page names its catalog; the name proves nothing."""
    catalog = ChannelCatalog(channel_url=NIGHT_URL, channel_name="Home Videos")
    session.add(catalog)
    session.commit()
    session.add(
        ChannelCatalogVideo(
            catalog_id=catalog.id,
            yt_id="nightvid001",
            url="https://www.youtube.com/watch?v=nightvid001",
        )
    )
    session.commit()
    _restrict(client, member_user, [HOME])
    resp = member_client.get(
        "/api/preview/subtitles",
        params={"url": "https://www.youtube.com/watch?v=nightvid001", "lang": "en"},
    )
    assert resp.status_code == 403


def test_a_stream_of_a_channel_named_like_an_allowed_one_is_refused(
    member_client, member_user, client, monkeypatch
):
    _restrict(client, member_user, [HOME])
    monkeypatch.setattr(
        stream_preview,
        "extract_stream_preview_meta",
        lambda url, **_kw: {
            "id": "impostor001",
            "title": "Not home videos",
            "channel": "Home Videos",
            "channel_url": NIGHT_URL,
        },
    )
    resp = member_client.get(
        "/api/preview/meta",
        params={"url": "https://www.youtube.com/watch?v=impostor001"},
    )
    assert resp.status_code == 403


def test_playlists_show_only_allowed_videos(client, member_client, restricted, session):
    """Review finding: a playlist's cover and counts came from every entry."""
    kids, other = restricted
    thumbs = get_paths().thumbnails
    thumbs.mkdir(parents=True, exist_ok=True)
    thumb = thumbs / "night.jpg"
    thumb.write_bytes(b"\xff\xd8\xffNIGHT")
    other.thumbnail_path = str(thumb)
    session.add(other)
    session.commit()
    resp = client.post("/api/playlists", json={"name": "Mixed", "visibility": "public"})
    assert resp.status_code == 200, resp.text
    mixed = resp.json()["id"]
    assert (
        client.post(
            f"/api/playlists/{mixed}/items/bulk", json={"video_ids": [other.id]}
        ).status_code
        == 204
    )
    assert client.get(f"/api/playlists/{mixed}/thumbnail").status_code == 200

    (listed,) = [
        p for p in member_client.get("/api/playlists").json() if p["id"] == mixed
    ]
    assert listed["item_count"] == 0
    assert listed["downloaded_count"] == 0
    assert listed["thumbnail_video_id"] is None
    detail = member_client.get(f"/api/playlists/{mixed}").json()
    assert (detail["videos"], detail["entries"]) == ([], [])
    assert member_client.get(f"/api/playlists/{mixed}/thumbnail").status_code == 404
    copies = member_client.get(f"/api/playlists/{mixed}/server-copies").json()
    assert copies["removable_video_ids"] == []

    # Nor can the member put another channel's video in a playlist of their own.
    own = member_client.post("/api/playlists", json={"name": "Mine"}).json()["id"]
    for path, body in (
        (f"/api/playlists/{own}/items/bulk", {"video_ids": [other.id]}),
        (f"/api/playlists/{own}/items", {"video_id": other.id}),
    ):
        resp = member_client.post(path, json=body)
        assert resp.status_code == 404, (path, resp.text)
    assert (
        member_client.post(
            f"/api/playlists/{own}/items", json={"video_id": kids.id}
        ).status_code
        == 200
    )
    assert member_client.get(f"/api/playlists/{own}").json()["videos"] != []


def test_a_streamed_playlist_entry_must_be_of_an_allowed_channel(
    member_client, restricted, monkeypatch
):
    monkeypatch.setattr(
        stream_preview,
        "extract_stream_preview_meta",
        lambda url, **_kw: {
            "id": "streamnight",
            "channel": "Night Frights",
            "channel_url": NIGHT_URL,
        },
    )
    own = member_client.post("/api/playlists", json={"name": "Mine"}).json()["id"]
    resp = member_client.post(
        f"/api/playlists/{own}/items",
        json={"url": "https://www.youtube.com/watch?v=streamnight"},
    )
    assert resp.status_code == 403
    assert member_client.get(f"/api/playlists/{own}").json()["entries"] == []


def test_lists_do_not_name_other_channels(
    client, member_client, member_user, add_video, set_watch, session
):
    """Review finding: tags, subscriptions, catalog status and the member's own
    history still named other channels and their videos."""
    add_video(
        title="Paper boats",
        channel="Kids Craft",
        channel_url=KIDS_URL,
        yt_id="kidsvideo01",
        tags=["origami"],
    )
    other = add_video(
        title="Late night horror",
        channel="Night Frights",
        channel_url=NIGHT_URL,
        yt_id="otherviden1",
        tags=["slasher"],
    )
    set_watch(member_user, other, 30.0)
    hour = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    session.add(
        UserWatchTime(
            user_id=member_user.id,
            video_id=other.id,
            channel="Night Frights",
            hour_start=hour,
            seconds=30.0,
        )
    )
    session.add(
        ChannelAutodownload(
            channel_url=NIGHT_URL, channel_name="Night Frights", enabled=True
        )
    )
    session.add(ChannelCatalog(channel_url=NIGHT_URL, channel_name="Night Frights"))
    session.commit()
    before = member_client.get("/api/history/stats", params={"range": "all"}).json()
    assert [c["name"] for c in before["channels"]] == ["Night Frights"]
    assert member_client.get("/api/history/watches").json()["items"] != []
    _restrict(client, member_user, [{"url": KIDS_URL, "name": "Kids Craft"}])

    assert member_client.get("/api/tags").json()["items"] == ["origami"]
    stats = member_client.get("/api/tags/stats", params={"channel": "Night Frights"})
    assert stats.json()["items"] == []
    subs = member_client.get("/api/channels/subscriptions").json()["items"]
    assert [s["channel_name"] for s in subs] == []
    status = member_client.get(
        "/api/channels/catalog/status", params={"channel_url": NIGHT_URL}
    ).json()
    assert (status["catalogs"], status["channel_catalog"]) == ([], None)
    watches = member_client.get("/api/history/watches").json()
    assert watches["items"] == []
    history = member_client.get("/api/history/stats", params={"range": "all"}).json()
    assert [c["name"] for c in history["channels"]] == []
    assert [t["tag"] for t in history["tags"]] == []


def test_ai_stays_withheld_from_a_restricted_member(member_client, restricted):
    """The help chat (``services/ai/help_data``) and Ask read the whole library
    unfiltered: they are safe only while ``use_ai`` is never held under a list.
    Changing ``KEPT_PERMISSIONS`` must filter them first."""
    assert frozenset({"offline_download"}) == parental.KEPT_PERMISSIONS
    assert member_client.get("/api/ai/help/catalog").status_code == 403

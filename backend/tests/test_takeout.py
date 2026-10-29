"""Google Takeout import: parsing, per-account history, follows, playlists and its readers."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import Session, select

from app.models import (
    ChannelCatalog,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    ChannelFollow,
    Playlist,
    PlaylistItem,
    PlaylistVisibility,
    YoutubeWatchEvent,
)
from app.services import follows
from app.services.ai import recommend
from app.services.takeout import history
from app.services.takeout.parse import read_export

ROOT = "Takeout/YouTube and YouTube Music"


def _view(
    yt_id: str,
    when: datetime,
    *,
    title: str = "A video",
    channel: str = "Chan",
    channel_url: str = "https://www.youtube.com/channel/UCchan",
    **extra,
) -> dict:
    item = {
        "header": "YouTube",
        "title": f"Watched {title}",
        "titleUrl": f"https://www.youtube.com/watch?v={yt_id}",
        "subtitles": [{"name": channel, "url": channel_url}],
        "time": when.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "products": ["YouTube"],
    }
    item.update(extra)
    return item


def _zip(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        for name, body in files.items():
            archive.writestr(name, body)
    return buf.getvalue()


def _export(
    views: list[dict] | None = None,
    *,
    subscriptions: list[tuple[str, str, str]] | None = None,
    playlists: dict[str, list[str]] | None = None,
) -> bytes:
    files: dict[str, str | bytes] = {}
    if views is not None:
        files[f"{ROOT}/history/watch-history.json"] = json.dumps(views)
    if subscriptions is not None:
        rows = ["Channel Id,Channel Url,Channel Title"]
        rows += [f"{cid},{url},{title}" for cid, url, title in subscriptions]
        files[f"{ROOT}/subscriptions/subscriptions.csv"] = "\n".join(rows)
    if playlists is not None:
        index = [
            "Playlist ID,Add new videos to top,Playlist Title (Original),"
            "Playlist Title (Original Language),Playlist Create Timestamp,"
            "Playlist Update Timestamp,Playlist Video Order,Playlist Visibility"
        ]
        for i, (title, ids) in enumerate(playlists.items()):
            index.append(f"PL{i:010d},False,{title},,,,Manual,Private")
            body = ["Video ID,Playlist Video Creation Timestamp"]
            body += [f"{vid},2024-01-01T00:00:00+00:00" for vid in ids]
            files[f"{ROOT}/playlists/{title}-videos.csv"] = "\n".join(body)
        files[f"{ROOT}/playlists/playlists.csv"] = "\n".join(index)
    return _zip(files)


def _upload(client, *payloads: bytes):
    return client.post(
        "/api/takeout/import",
        files=[
            ("files", (f"takeout-{i}.zip", body, "application/zip"))
            for i, body in enumerate(payloads)
        ],
    )


NOW = datetime.now(UTC).replace(microsecond=0)


# --- parsing -------------------------------------------------------------------


def test_history_keeps_videos_and_drops_music_ads_and_removed_ones():
    views = [
        _view("aaaaaaaaaa1", NOW, title="Real one"),
        _view("aaaaaaaaaa2", NOW, header="YouTube Music"),
        _view("aaaaaaaaaa3", NOW, details=[{"name": "From Google Ads"}]),
        {
            "header": "YouTube",
            "title": "Watched a video that has been removed",
            "time": "2024-01-01T00:00:00Z",
        },
        _view("aaaaaaaaaa4", NOW, title="https://www.youtube.com/watch?v=aaaaaaaaaa4"),
    ]
    data = read_export([("t.zip", io.BytesIO(_export(views)))])

    assert data.found_history
    assert [(v.yt_id, v.title) for v in data.views] == [
        ("aaaaaaaaaa1", "Real one"),
        ("aaaaaaaaaa4", None),  # a title YouTube no longer knows
    ]
    assert data.views[0].channel == "Chan"
    assert data.views[0].channel_url == "https://youtube.com/channel/UCchan"
    assert data.views[0].watched_at == NOW


def test_html_history_is_read_when_json_was_not_chosen():
    html = """<html><body><div class="mdl-grid">
    <div class="outer-cell mdl-cell"><div class="mdl-grid">
      <div class="header-cell"><p class="mdl-typography--title">YouTube<br></p></div>
      <div class="content-cell">Watched\xa0<a href="https://www.youtube.com/watch?v=bbbbbbbbbb1">Kiln build</a><br>
        <a href="https://www.youtube.com/channel/UCpots">Pots</a><br>Mar 1, 2024, 1:02:03 PM EST<br></div>
    </div></div>
    <div class="outer-cell mdl-cell"><div class="mdl-grid">
      <div class="header-cell"><p class="mdl-typography--title">YouTube Music<br></p></div>
      <div class="content-cell">Watched\xa0<a href="https://music.youtube.com/watch?v=bbbbbbbbbb2">Song</a><br>Mar 1, 2024, 1:02:03 PM EST<br></div>
    </div></div>
    </div></body></html>"""
    data = read_export([("watch-history.html", io.BytesIO(html.encode()))])

    assert len(data.views) == 1
    view = data.views[0]
    assert (view.yt_id, view.title, view.channel) == (
        "bbbbbbbbbb1",
        "Kiln build",
        "Pots",
    )
    assert view.watched_at == datetime(2024, 3, 1, 18, 2, 3, tzinfo=UTC)


def test_older_playlist_layout_and_subscriptions_are_read():
    old_playlist = (
        "Playlist Id,Channel Id,Time Created,Time Updated,Title,Description,Visibility\n"
        "PLold,UCme,2020-01-01,2020-01-02,Old favourites,,Private\n"
        "\n"
        "Video Id,Time Added\n"
        "cccccccccc1,2020-01-01 00:00:00 UTC\n"
        "cccccccccc2,2020-01-01 00:00:00 UTC\n"
        "cccccccccc1,2020-01-01 00:00:00 UTC\n"
    )
    archive = _zip(
        {
            f"{ROOT}/playlists/Old favourites.csv": old_playlist,
            f"{ROOT}/subscriptions/subscriptions.csv": (
                "Channel Id,Channel Url,Channel Title\n"
                "UCa,http://www.youtube.com/channel/UCa,Alpha\n"
            ),
            # Other exports with a video id column are not playlists.
            f"{ROOT}/comments/comments.csv": "Comment ID,Channel ID,Created,Price,Video ID\n",
        }
    )
    data = read_export([("t.zip", io.BytesIO(archive))])

    assert [(p.title, p.playlist_id, p.video_ids) for p in data.playlists] == [
        ("Old favourites", "PLold", ["cccccccccc1", "cccccccccc2"])
    ]
    assert [(s.channel_url, s.channel_name) for s in data.subscriptions] == [
        ("https://youtube.com/channel/UCa", "Alpha")
    ]


def test_an_upload_without_youtube_data_is_refused(client):
    resp = _upload(client, _zip({"Takeout/Drive/notes.txt": "hello"}))
    assert resp.status_code == 400
    assert resp.json()["code"] == "takeout_empty"

    resp = client.post(
        "/api/takeout/import",
        files=[("files", ("broken.zip", b"PK\x03\x04 not really", "application/zip"))],
    )
    assert resp.status_code == 400
    assert resp.json()["code"] == "takeout_unreadable"


# --- history: re-imports and accounts ---------------------------------------------


def test_reimporting_an_overlapping_export_adds_only_new_views(client):
    old = [_view(f"dddddddddd{i}", NOW - timedelta(days=10 + i)) for i in range(3)]
    first = _upload(client, _export(old))
    assert first.status_code == 200, first.text
    body = first.json()
    assert (body["views_in_file"], body["new_views"]) == (3, 3)

    # Six months on: the new export holds the old views and two new ones,
    # one of them a rewatch of an old video.
    newer = old + [
        _view("dddddddddd9", NOW - timedelta(days=1)),
        _view("dddddddddd0", NOW),
    ]
    again = _upload(client, _export(newer)).json()
    assert (again["views_in_file"], again["new_views"]) == (5, 2)
    assert again["history"]["total_views"] == 5
    assert again["history"]["distinct_videos"] == 4

    assert _upload(client, _export(newer)).json()["new_views"] == 0


def test_each_account_has_its_own_history(client, member_client):
    _upload(client, _export([_view("eeeeeeeeee1", NOW), _view("eeeeeeeeee2", NOW)]))
    member = _upload(member_client, _export([_view("eeeeeeeeee1", NOW)])).json()

    # The same view in another account is that account's own, not a duplicate.
    assert member["new_views"] == 1
    assert member["history"]["total_views"] == 1
    assert client.get("/api/takeout/history").json()["total_views"] == 2

    assert member_client.delete("/api/takeout/history").json() == {"removed_views": 1}
    assert member_client.get("/api/takeout/history").json()["total_views"] == 0
    assert client.get("/api/takeout/history").json()["total_views"] == 2


def test_deleting_an_account_deletes_its_history(
    client, member_client, member_user, init_db
):
    _upload(member_client, _export([_view("eeeeeeeeee3", NOW)]))
    assert client.delete(f"/api/users/{member_user.id}").status_code in (200, 204)
    with Session(init_db["engine"]) as s:
        assert s.exec(select(YoutubeWatchEvent)).all() == []


# --- subscriptions and playlists ------------------------------------------------


def test_subscriptions_are_listed_with_their_state_and_followed_on_choice(
    client, session, admin_user
):
    follows.follow(session, admin_user.id, "https://www.youtube.com/channel/UCold")
    follows.unfollow(session, admin_user.id, "https://www.youtube.com/channel/UCgone")
    subs = [
        ("UCold", "http://www.youtube.com/channel/UCold", "Old friend"),
        ("UCgone", "http://www.youtube.com/channel/UCgone", "Dropped"),
        ("UCnew", "http://www.youtube.com/channel/UCnew", "Brand new"),
    ]
    listed = _upload(client, _export(subscriptions=subs)).json()["subscriptions"]
    assert {s["channel_name"]: s["status"] for s in listed} == {
        "Old friend": "following",
        "Dropped": "unfollowed",
        "Brand new": "new",
    }

    chosen = [s for s in listed if s["channel_name"] in ("Brand new", "Dropped")]
    result = client.post("/api/takeout/apply", json={"subscriptions": chosen}).json()
    assert result["followed"] == 2
    followed = {
        r.channel_url
        for r in session.exec(
            select(ChannelFollow).where(
                ChannelFollow.user_id == admin_user.id,
                ChannelFollow.followed == True,  # noqa: E712 - SQL column comparison, not a Python truth test
            )
        ).all()
    }
    assert followed == {
        "https://youtube.com/channel/UCold",
        "https://youtube.com/channel/UCgone",
        "https://youtube.com/channel/UCnew",
    }


def test_playlists_become_private_and_reimporting_adds_only_missing_videos(
    client, session, add_video, admin_user
):
    have = add_video(title="In library", yt_id="ffffffffff1")
    views = [_view("ffffffffff2", NOW, title="Seen on YouTube", channel="Pots")]
    exported = _upload(
        client,
        _export(
            views, playlists={"Pottery": ["ffffffffff1", "ffffffffff2", "ffffffffff3"]}
        ),
    ).json()["playlists"]
    assert [
        (p["title"], p["existing_playlist_id"], p["new_videos"]) for p in exported
    ] == [("Pottery", None, 3)]

    result = client.post("/api/takeout/apply", json={"playlists": exported}).json()
    assert result == {
        "followed": 0,
        "playlists_created": 1,
        "playlists_updated": 0,
        "videos_added": 3,
    }
    playlist = session.exec(select(Playlist).where(Playlist.name == "Pottery")).one()
    assert playlist.owner_user_id == admin_user.id
    assert playlist.visibility == PlaylistVisibility.private
    items = session.exec(
        select(PlaylistItem)
        .where(PlaylistItem.playlist_id == playlist.id)
        .order_by(PlaylistItem.position)
    ).all()
    assert [(i.video_id, i.youtube_id, i.title) for i in items] == [
        (have.id, "ffffffffff1", "In library"),
        (None, "ffffffffff2", "Seen on YouTube"),  # the title from the history
        (None, "ffffffffff3", None),
    ]

    # The playlist grew on YouTube: only the new video is added.
    again = _upload(
        client,
        _export(
            playlists={
                "Pottery": ["ffffffffff1", "ffffffffff2", "ffffffffff3", "ffffffffff4"]
            }
        ),
    ).json()["playlists"]
    assert (again[0]["existing_playlist_id"], again[0]["new_videos"]) == (
        playlist.id,
        1,
    )
    result = client.post("/api/takeout/apply", json={"playlists": again}).json()
    assert (result["playlists_created"], result["playlists_updated"]) == (0, 1)
    assert result["videos_added"] == 1
    assert (
        len(session.exec(select(Playlist).where(Playlist.name == "Pottery")).all()) == 1
    )


def test_apply_rejects_malformed_video_ids(client):
    resp = client.post(
        "/api/takeout/apply",
        json={"playlists": [{"title": "X", "video_ids": ["not an id"]}]},
    )
    assert resp.status_code == 422


# --- readers: channel pages, Download page --------------------------------------------


def _catalog(session, url: str, name: str, ids: list[str]) -> ChannelCatalog:
    catalog = ChannelCatalog(
        channel_url=url, channel_name=name, status=ChannelCatalogStatus.ready
    )
    session.add(catalog)
    session.commit()
    recent = datetime.now(UTC).strftime("%Y%m%d")
    for pos, yt_id in enumerate(ids):
        session.add(
            ChannelCatalogVideo(
                catalog_id=catalog.id,
                yt_id=yt_id,
                url=f"https://www.youtube.com/watch?v={yt_id}",
                title=f"Upload {yt_id}",
                duration=600.0,
                position=pos,
                published_at=recent,
            )
        )
    session.commit()
    return catalog


def test_channel_pages_mark_what_this_user_watched_on_youtube(
    client, member_client, session, monkeypatch
):
    from app.services import channel_catalog

    monkeypatch.setattr(channel_catalog, "maybe_enqueue_for_feed", lambda *a, **k: None)
    monkeypatch.setattr(
        channel_catalog, "schedule_feed_head_sync", lambda *a, **k: None
    )
    url = "https://www.youtube.com/@pots"
    _catalog(session, url, "Pots", ["gggggggggg1", "gggggggggg2"])
    _upload(client, _export([_view("gggggggggg2", NOW)]))

    def marks(c) -> dict[str, bool]:
        page = c.get("/api/channels/feed", params={"url": url, "channel": "Pots"})
        assert page.status_code == 200, page.text
        return {e["id"]: e["youtube_watched"] for e in page.json()["entries"]}

    assert marks(client) == {"gggggggggg1": False, "gggggggggg2": True}
    assert marks(member_client) == {"gggggggggg1": False, "gggggggggg2": False}


def test_rewatched_lists_repeat_views_not_in_the_library(client, add_video):
    add_video(title="Have it", yt_id="hhhhhhhhhh1")
    views = (
        [_view("hhhhhhhhhh1", NOW - timedelta(days=d)) for d in range(3)]
        + [
            _view("hhhhhhhhhh2", NOW - timedelta(days=d), title="Twice")
            for d in range(2)
        ]
        + [
            _view("hhhhhhhhhh3", NOW - timedelta(days=d), title="Thrice")
            for d in range(3)
        ]
        + [_view("hhhhhhhhhh4", NOW, title="Once")]
    )
    _upload(client, _export(views))

    first = client.get("/api/takeout/rewatched", params={"limit": 1}).json()
    assert [(i["entry"]["title"], i["views"]) for i in first["items"]] == [
        ("Thrice", 3)
    ]
    assert first["items"][0]["entry"]["youtube_watched"] is True
    rest = client.get(
        "/api/takeout/rewatched", params={"limit": 5, "cursor": first["next_cursor"]}
    ).json()
    assert [(i["entry"]["title"], i["views"]) for i in rest["items"]] == [("Twice", 2)]
    assert rest["next_cursor"] is None


# --- recommendations ----------------------------------------------------------------


def _for_you(client, **params) -> list[tuple[str, str, str | None]]:
    body = client.get(
        "/api/ai/recommendations",
        params={"limit": 50, **{k: str(v).lower() for k, v in params.items()}},
    ).json()
    items = [i for s in body["sections"] for i in s["items"]]
    return [
        ("video", i["video"]["title"], i.get("reason"))
        if i["video"]
        else ("stream", i["stream"]["title"], i.get("reason"))
        for i in items
    ]


def test_for_you_treats_youtube_views_as_watched_and_follows_recent_taste(
    client, add_video
):
    add_video(title="Seen on YouTube", channel="Loved", yt_id="iiiiiiiiii1")
    add_video(title="More from Loved", channel="Loved")
    add_video(title="From Faded", channel="Faded")
    add_video(title="Unrelated", channel="Nobody")
    views = [
        _view(
            "iiiiiiiiii1",
            NOW,
            channel="Loved",
            channel_url="https://www.youtube.com/@loved",
        ),
        # A channel watched as much, but long ago, pulls far less.
        *[
            _view(
                f"jjjjjjjjj{i:02d}",
                NOW - timedelta(days=120 + i),
                channel="Faded",
                channel_url="https://www.youtube.com/@faded",
            )
            for i in range(3)
        ],
    ]
    _upload(client, _export(views))

    titles = [t for _kind, t, _r in _for_you(client)]
    assert titles == ["More from Loved", "From Faded", "Unrelated", "Seen on YouTube"]


def test_for_you_suggests_uploads_of_channels_watched_on_youtube(client, session):
    url = "https://www.youtube.com/@pots"
    _catalog(session, url, "Pots", ["kkkkkkkkkk1", "kkkkkkkkkk2"])
    _upload(
        client, _export([_view("kkkkkkkkkk2", NOW, channel="Pots", channel_url=url)])
    )

    assert _for_you(client) == []
    # Not followed, but watched on YouTube: its unwatched upload is suggested.
    assert _for_you(client, include_streams=True) == [
        ("stream", "Upload kkkkkkkkkk1", None)
    ]


def test_for_you_brings_back_an_old_channel_now_and_then(client, add_video):
    # Thirty channels watched lately, each with a video waiting, and one channel
    # watched a lot over a year ago: on taste alone it would come last.
    views = []
    for i in range(30):
        add_video(title=f"Recent {i:02d}", channel=f"Now {i:02d}")
        views.append(
            _view(
                f"lllllllll{i:02d}",
                NOW,
                channel=f"Now {i:02d}",
                channel_url=f"https://www.youtube.com/@now{i:02d}",
            )
        )
    add_video(title="Old favourite", channel="Back then")
    views += [
        _view(
            f"mmmmmmmmm{i:02d}",
            NOW - timedelta(days=400 + i),
            channel="Back then",
            channel_url="https://www.youtube.com/@backthen",
        )
        for i in range(recommend.THROWBACK_MIN_OLD_VIEWS)
    ]
    _upload(client, _export(views))

    items = _for_you(client)
    slot = recommend.THROWBACK_EVERY - 1
    assert items[slot] == ("video", "Old favourite", "throwback")
    assert [r for _k, _t, r in items].count("throwback") == 1


def test_for_you_with_ai_is_seeded_by_youtube_views(
    client, session, add_video, monkeypatch
):
    from app.models import VideoEmbedding
    from app.services.ai import embeddings

    monkeypatch.setattr(recommend, "get_embed_provider", lambda: object())

    def embedded(title: str, vec: list[float], **fields):
        video = add_video(title=title, channel=title, **fields)
        session.add(
            VideoEmbedding(
                video_id=video.id,
                chunk_index=-1,
                model="m",
                dim=4,
                vector=embeddings.pack_vector(vec),
                content_hash="h",
            )
        )
        session.commit()
        return video

    # Added first, so without the seed the newer unrelated video would lead.
    embedded("Close to it", [0.9, 0.43, 0.0, 0.0])
    embedded("Watched on YouTube", [1.0, 0.0, 0.0, 0.0], yt_id="pppppppppp1")
    embedded("Unrelated", [0.0, 0.0, 0.0, 1.0])
    _upload(client, _export([_view("pppppppppp1", NOW)]))

    titles = [t for _k, t, _r in _for_you(client)]
    assert titles[0] == "Close to it"
    assert titles[-1] == "Watched on YouTube"


def test_profile_weighs_recent_views_far_above_old_ones(session, admin_user):
    history.store_views(
        session,
        admin_user.id,
        read_export(
            [
                (
                    "t.zip",
                    io.BytesIO(
                        _export(
                            [
                                _view("nnnnnnnnnn1", NOW, channel="New"),
                                _view(
                                    "nnnnnnnnnn2",
                                    NOW - timedelta(days=90),
                                    channel="Old",
                                    channel_url="https://www.youtube.com/@old",
                                ),
                            ]
                        )
                    ),
                )
            ]
        ).views,
    )
    found = history.profile(session, admin_user.id, NOW)
    by_name = {c.name: c.recent for c in found.channels.values()}
    assert by_name["New"] == pytest.approx(1.0)
    assert by_name["Old"] == pytest.approx(0.125)  # three half-lives


# --- History stats ----------------------------------------------------------------


def test_stats_count_youtube_views_only_when_asked_and_never_as_time(client):
    today = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
    views = [
        _view("oooooooooo1", today, channel="Pots"),
        _view("oooooooooo1", today - timedelta(days=1), channel="Pots"),
        _view("oooooooooo2", today - timedelta(days=1), channel="Kilns"),
    ]
    _upload(client, _export(views))

    plain = client.get("/api/history/stats", params={"range": "7d", "tz": "UTC"}).json()
    assert plain["includes_youtube"] is False
    assert plain["totals"]["videos_started"] == 0
    assert plain["totals"]["active_days"] == 0

    stats = client.get(
        "/api/history/stats",
        params={"range": "7d", "tz": "UTC", "include_youtube": "true"},
    ).json()
    totals = stats["totals"]
    assert totals["watch_seconds"] == 0
    assert totals["youtube_views"] == 3
    assert totals["videos_started"] == 2
    assert totals["active_days"] == 2
    assert totals["current_streak_days"] == 2
    assert [d["youtube_views"] for d in stats["days"]][-2:] == [2, 1]
    assert [
        (c["name"], c["videos"], c["youtube_views"]) for c in stats["channels"]
    ] == [
        ("Kilns", 1, 1),
        ("Pots", 1, 2),
    ]
    assert stats["youtube_hours"][today.weekday()][12] == 1
    assert stats["hours"] is None


def test_the_import_route_takes_large_uploads():
    from app.security import DEFAULT_BODY_LIMIT, body_limit_for
    from app.services import uploads

    assert body_limit_for("POST", "/api/takeout/import") > DEFAULT_BODY_LIMIT
    assert body_limit_for("POST", "/api/takeout/import") >= uploads.TAKEOUT_MAX_BYTES

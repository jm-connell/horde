"""HTTP regression: user playlists (no YouTube import)."""


def test_playlist_crud_and_items(client, add_video):
    v1 = add_video(title="First")
    v2 = add_video(title="Second")
    v3 = add_video(title="Third")

    empty = client.get("/api/playlists")
    assert empty.status_code == 200
    assert empty.json() == []

    created = client.post("/api/playlists", json={"name": "  Mix  ", "description": "d"})
    assert created.status_code == 200
    playlist = created.json()
    assert playlist["name"] == "Mix"
    assert playlist["item_count"] == 0
    pid = playlist["id"]

    blank = client.post("/api/playlists", json={"name": "   "})
    assert blank.status_code == 400

    listed = client.get("/api/playlists").json()
    assert len(listed) == 1

    added = client.post(f"/api/playlists/{pid}/items", json={"video_id": v1.id})
    assert added.status_code == 200
    assert [v["id"] for v in added.json()["videos"]] == [v1.id]

    # Duplicate add is idempotent.
    again = client.post(f"/api/playlists/{pid}/items", json={"video_id": v1.id})
    assert again.status_code == 200
    assert len(again.json()["videos"]) == 1

    bulk = client.post(
        f"/api/playlists/{pid}/items/bulk", json={"video_ids": [v2.id, v3.id, 99999]}
    )
    assert bulk.status_code == 204
    detail = client.get(f"/api/playlists/{pid}").json()
    assert [v["id"] for v in detail["videos"]] == [v1.id, v2.id, v3.id]
    assert detail["item_count"] == 3

    reordered = client.patch(
        f"/api/playlists/{pid}/reorder",
        json={"video_ids": [v3.id, v1.id, v2.id]},
    )
    assert reordered.status_code == 200
    assert [v["id"] for v in reordered.json()["videos"]] == [v3.id, v1.id, v2.id]

    removed = client.delete(f"/api/playlists/{pid}/items/{v1.id}")
    assert removed.status_code == 204
    leftover = client.get(f"/api/playlists/{pid}").json()
    assert [v["id"] for v in leftover["videos"]] == [v3.id, v2.id]

    renamed = client.patch(
        f"/api/playlists/{pid}", json={"name": "Renamed", "description": "new"}
    )
    assert renamed.json()["name"] == "Renamed"

    deleted = client.delete(f"/api/playlists/{pid}")
    assert deleted.status_code == 204
    assert client.get(f"/api/playlists/{pid}").status_code == 404
    assert client.get("/api/playlists").json() == []


def test_import_subscribe_and_duplicate(client, monkeypatch):
    from app.services import downloader

    monkeypatch.setattr(
        downloader,
        "extract_playlist",
        lambda url: (
            "Build Log",
            ["https://www.youtube.com/watch?v=aaaaaaaaaa1"],
        ),
    )
    monkeypatch.setattr(downloader, "start_playlist_import", lambda *a, **k: None)

    created = client.post(
        "/api/playlists/import",
        json={
            "url": "https://www.youtube.com/playlist?list=PLtestsub",
            "quality_preset": "1080p",
            "subscribe": True,
        },
    )
    assert created.status_code == 200
    body = created.json()
    assert body["subscribed"] is True
    assert body["quality_preset"] == "1080p"
    assert body["source_type"] == "youtube"
    assert body["source_url"]
    assert "list=PLtestsub" in body["source_url"]

    again = client.post(
        "/api/playlists/import",
        json={
            "url": "https://www.youtube.com/playlist?list=PLtestsub",
            "subscribe": True,
        },
    )
    assert again.status_code == 409


def test_import_one_shot_is_not_subscribed(client, monkeypatch):
    from app.services import downloader

    monkeypatch.setattr(downloader, "start_playlist_import", lambda *a, **k: None)
    created = client.post(
        "/api/playlists/import",
        json={
            "url": "https://www.youtube.com/playlist?list=PLoneshot",
            "name": "One shot",
            "entries": ["https://www.youtube.com/watch?v=aaaaaaaaaa1"],
        },
    )
    assert created.status_code == 200
    assert created.json()["subscribed"] is False


def test_sync_requires_subscription(client):
    created = client.post("/api/playlists", json={"name": "Local"})
    pid = created.json()["id"]
    resp = client.post(f"/api/playlists/{pid}/sync")
    assert resp.status_code == 400


def test_patch_subscribe_youtube_playlist(client, monkeypatch):
    from app.api import playlists as playlists_api
    from app.services import downloader

    monkeypatch.setattr(downloader, "start_playlist_import", lambda *a, **k: None)
    monkeypatch.setattr(playlists_api, "start_playlist_sync", lambda *a, **k: None)
    created = client.post(
        "/api/playlists/import",
        json={
            "url": "https://www.youtube.com/playlist?list=PLupgrade",
            "name": "Upgrade me",
            "entries": ["https://www.youtube.com/watch?v=aaaaaaaaaa1"],
        },
    )
    pid = created.json()["id"]
    assert created.json()["subscribed"] is False

    local = client.post("/api/playlists", json={"name": "No url"})
    bad = client.patch(
        f"/api/playlists/{local.json()['id']}", json={"subscribed": True}
    )
    assert bad.status_code == 400

    patched = client.patch(f"/api/playlists/{pid}", json={"subscribed": True})
    assert patched.status_code == 200
    assert patched.json()["subscribed"] is True

    stopped = client.patch(f"/api/playlists/{pid}", json={"subscribed": False})
    assert stopped.json()["subscribed"] is False


def test_sync_attaches_existing_library_video(session, add_video, monkeypatch):
    from sqlmodel import select

    from app.models import Playlist, PlaylistItem, PlaylistSource
    from app.services import downloader
    from app.services.playlist_sync import sync_subscribed_playlist

    video = add_video(title="Part 1", yt_id="abcdefghijk")
    playlist = Playlist(
        name="PC Build",
        source_type=PlaylistSource.youtube,
        source_url="https://www.youtube.com/playlist?list=PLbuild",
        subscribed=True,
        quality_preset="best",
    )
    session.add(playlist)
    session.commit()
    session.refresh(playlist)
    pid = playlist.id

    monkeypatch.setattr(
        "app.services.playlist_sync.extract_playlist_entries",
        lambda url: {
            "title": "PC Build",
            "entries": [
                {
                    "id": "abcdefghijk",
                    "url": "https://www.youtube.com/watch?v=abcdefghijk",
                    "title": "Part 1",
                }
            ],
        },
    )

    created_jobs: list[int] = []
    original_enqueue = downloader.enqueue_download

    def _track_enqueue(job_id: int) -> None:
        created_jobs.append(job_id)
        original_enqueue(job_id)

    monkeypatch.setattr(downloader, "enqueue_download", _track_enqueue)

    sync_subscribed_playlist(pid)
    session.expire_all()

    items = session.exec(
        select(PlaylistItem).where(PlaylistItem.playlist_id == pid)
    ).all()
    assert [item.video_id for item in items] == [video.id]
    assert created_jobs == []
    refreshed = session.get(Playlist, pid)
    assert refreshed is not None
    assert refreshed.last_synced_at is not None
    assert refreshed.sync_error is None


def test_playlist_404s(client):
    assert client.get("/api/playlists/1").status_code == 404
    assert client.post("/api/playlists/1/items", json={"video_id": 1}).status_code == 404
    assert client.patch("/api/playlists/1", json={"name": "x"}).status_code == 404
    assert client.delete("/api/playlists/1").status_code == 404
    assert client.get("/api/playlists/1/thumbnail").status_code == 404


def _jpeg_bytes(color: tuple[int, int, int] = (20, 80, 80)) -> bytes:
    from io import BytesIO

    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", (64, 36), color).save(buf, "JPEG")
    return buf.getvalue()


def _attach_thumb(session, video, color=(20, 80, 80)):
    from app.services.thumbnails import write_full_bytes

    path = write_full_bytes(video.id, _jpeg_bytes(color))
    video.thumbnail_path = path
    session.add(video)
    session.commit()
    session.refresh(video)
    return video


def test_playlist_list_order_and_reorder(client):
    first = client.post("/api/playlists", json={"name": "First"}).json()
    second = client.post("/api/playlists", json={"name": "Second"}).json()
    listed = client.get("/api/playlists").json()
    assert [p["name"] for p in listed] == ["Second", "First"]
    assert listed[0]["id"] == second["id"]
    assert listed[0]["position"] == 0

    reordered = client.patch(
        "/api/playlists/reorder",
        json={"playlist_ids": [first["id"], second["id"]]},
    )
    assert reordered.status_code == 200
    assert [p["name"] for p in reordered.json()] == ["First", "Second"]
    assert [p["name"] for p in client.get("/api/playlists").json()] == [
        "First",
        "Second",
    ]


def test_playlist_cover_default_pick_and_upload(client, add_video, session):
    v1 = _attach_thumb(session, add_video(title="One"), (10, 20, 30))
    v2 = _attach_thumb(session, add_video(title="Two"), (200, 10, 10))
    pid = client.post("/api/playlists", json={"name": "Covers"}).json()["id"]
    client.post(f"/api/playlists/{pid}/items/bulk", json={"video_ids": [v1.id, v2.id]})

    listed = client.get("/api/playlists").json()[0]
    assert listed["has_thumbnail"] is True
    assert listed["has_custom_cover"] is False
    assert listed["cover_video_id"] is None
    assert listed["thumbnail_video_id"] == v1.id

    default = client.get(f"/api/playlists/{pid}/thumbnail")
    assert default.status_code == 200

    picked = client.patch(f"/api/playlists/{pid}", json={"cover_video_id": v2.id})
    assert picked.status_code == 200
    body = picked.json()
    assert body["cover_video_id"] == v2.id
    assert body["thumbnail_video_id"] == v2.id
    assert body["has_custom_cover"] is False

    outside = add_video(title="Other")
    bad = client.patch(f"/api/playlists/{pid}", json={"cover_video_id": outside.id})
    assert bad.status_code == 400

    uploaded = client.post(
        f"/api/playlists/{pid}/thumbnail",
        files={"file": ("cover.jpg", _jpeg_bytes((0, 255, 0)), "image/jpeg")},
    )
    assert uploaded.status_code == 200
    cover = uploaded.json()
    assert cover["has_custom_cover"] is True
    assert cover["has_thumbnail"] is True
    custom = client.get(f"/api/playlists/{pid}/thumbnail")
    assert custom.status_code == 200
    assert custom.content != default.content

    reset = client.patch(f"/api/playlists/{pid}", json={"cover_video_id": None})
    assert reset.json()["has_custom_cover"] is False
    assert reset.json()["cover_video_id"] is None
    assert reset.json()["thumbnail_video_id"] == v1.id


def test_add_item_requires_video_or_url(client):
    pid = client.post("/api/playlists", json={"name": "Mix"}).json()["id"]
    blank = client.post(f"/api/playlists/{pid}/items", json={})
    assert blank.status_code == 400


def test_add_item_url_uses_existing_library_video(client, add_video):
    video = add_video(title="Already local", yt_id="dQw4w9WgXcQ")
    pid = client.post("/api/playlists", json={"name": "Mix"}).json()["id"]

    added = client.post(
        f"/api/playlists/{pid}/items",
        json={"url": "https://youtu.be/dQw4w9WgXcQ"},
    )
    assert added.status_code == 200
    assert [v["id"] for v in added.json()["videos"]] == [video.id]


def test_add_item_url_queues_download(client, monkeypatch):
    from app.services import downloader

    monkeypatch.setattr(
        downloader,
        "extract_preview",
        lambda url: {
            "id": "bbbbbbbbbb1",
            "title": "New clip",
            "channel": "Chan",
            "is_playlist": False,
        },
    )
    pid = client.post("/api/playlists", json={"name": "Mix"}).json()["id"]
    queued = client.post(
        f"/api/playlists/{pid}/items",
        json={"url": "https://www.youtube.com/watch?v=bbbbbbbbbb1"},
    )
    assert queued.status_code == 200
    assert queued.json()["videos"] == []

    jobs = client.get("/api/downloads").json()
    assert len(jobs) == 1
    assert jobs[0]["playlist_id"] == pid
    assert "bbbbbbbbbb1" in jobs[0]["url"]


def test_attach_completed_download_to_playlist(session, add_video):
    from app.models import DownloadJob, JobStatus, Playlist, PlaylistItem
    from app.services.downloader import _attach_download_to_playlist
    from sqlmodel import select

    video = add_video(title="Fresh")
    playlist = Playlist(name="Mix")
    session.add(playlist)
    session.commit()
    session.refresh(playlist)
    job = DownloadJob(
        url="https://www.youtube.com/watch?v=cccccccccc1",
        status=JobStatus.completed,
        playlist_id=playlist.id,
        video_id=video.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    _attach_download_to_playlist(job.id, video.id)
    session.expire_all()
    items = list(
        session.exec(
            select(PlaylistItem).where(PlaylistItem.playlist_id == playlist.id)
        ).all()
    )
    assert [item.video_id for item in items] == [video.id]

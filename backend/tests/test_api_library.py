"""HTTP regression: library, review, watch progress, streaming, channels."""


def test_list_videos_hides_review_queue(client, add_video):
    ready = add_video(title="In library", channel="Alpha")
    add_video(
        title="Needs review",
        channel=None,
        needs_review=True,
        file_path="imports/drop.mp4",
    )
    body = client.get("/api/videos").json()
    ids = {row["id"] for row in body}
    assert ready.id in ids
    assert all(not row["needs_review"] for row in body)


def test_filter_and_sort_videos(client, add_video):
    add_video(title="Zebra", channel="Alpha", tags=["fun"])
    add_video(title="Aardvark", channel="Beta", tags=["fun"])
    add_video(title="Other", channel="Alpha", tags=["meh"])

    by_channel = client.get("/api/videos", params={"channel": "Alpha"}).json()
    assert {row["title"] for row in by_channel} == {"Zebra", "Other"}

    by_tag = client.get("/api/videos", params={"tag": "fun"}).json()
    assert {row["title"] for row in by_tag} == {"Zebra", "Aardvark"}

    sorted_asc = client.get(
        "/api/videos", params={"sort": "title", "order": "asc"}
    ).json()
    assert [row["title"] for row in sorted_asc] == ["Aardvark", "Other", "Zebra"]


def test_get_patch_delete_video(client, add_video):
    video = add_video(title="Original", channel="Alpha", notes=None)
    got = client.get(f"/api/videos/{video.id}")
    assert got.status_code == 200
    assert got.json()["title"] == "Original"

    patched = client.patch(
        f"/api/videos/{video.id}",
        json={"title": "Renamed", "notes": "keep this", "tags": ["x"]},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["title"] == "Renamed"
    assert body["notes"] == "keep this"
    assert body["tags"] == ["x"]
    assert body["title_is_custom"] is True

    missing = client.get("/api/videos/99999")
    assert missing.status_code == 404

    deleted = client.delete(f"/api/videos/{video.id}")
    assert deleted.status_code == 204
    assert client.get(f"/api/videos/{video.id}").status_code == 404


def test_watch_progress_and_continue_watching(client, add_video):
    video = add_video(title="Long watch", duration_sec=200.0, last_position_sec=0.0)
    # Positions under 5s are ignored (except exact 0).
    ignored = client.patch(
        f"/api/videos/{video.id}/progress", json={"position_sec": 2}
    )
    assert ignored.status_code == 204
    assert client.get(f"/api/videos/{video.id}").json()["last_position_sec"] == 0.0

    saved = client.patch(
        f"/api/videos/{video.id}/progress", json={"position_sec": 40}
    )
    assert saved.status_code == 204
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["last_position_sec"] == 40.0
    assert body["last_watched_at"] is not None

    row = client.get("/api/videos", params={"continue_watching": True}).json()
    assert [item["id"] for item in row] == [video.id]

    # Near-complete (>=90%) clears progress so it leaves continue-watching.
    done = client.patch(
        f"/api/videos/{video.id}/progress", json={"position_sec": 190}
    )
    assert done.status_code == 204
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["last_position_sec"] == 0.0
    assert client.get("/api/videos", params={"continue_watching": True}).json() == []


def test_tags_and_storage_stats(client, add_video):
    add_video(title="A", tags=["alpha", "shared"], file_size=100)
    add_video(title="B", tags=["shared"], file_size=50)
    tags = client.get("/api/tags").json()
    assert tags == ["alpha", "shared"]
    stats = client.get("/api/tags/stats").json()
    by_tag = {row["tag"]: row["count"] for row in stats}
    assert by_tag["shared"] == 2
    assert by_tag["alpha"] == 1
    storage = client.get("/api/stats/storage").json()
    assert storage["video_count"] == 2
    assert storage["video_bytes"] == 150


def test_channels_list_and_rename(client, add_video):
    add_video(title="One", channel="OldName")
    add_video(title="Two", channel="OldName")
    listed = client.get("/api/channels").json()
    assert any(row["channel"] == "OldName" and row["count"] == 2 for row in listed)

    renamed = client.patch(
        "/api/channels", json={"old_name": "OldName", "new_name": "NewName"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["updated"] == 2
    listed = client.get("/api/channels").json()
    names = {row["channel"] for row in listed}
    assert "NewName" in names
    assert "OldName" not in names


def test_review_queue_approve_and_skip(client, add_video, init_db):
    pending = add_video(
        title="Dropped file",
        channel=None,
        needs_review=True,
        file_path="imports/dropped.mp4",
        write_file=True,
    )
    queue = client.get("/api/review").json()
    assert [row["id"] for row in queue] == [pending.id]

    skipped = add_video(
        title="Skip me",
        channel=None,
        needs_review=True,
        file_path="imports/skip.mp4",
        write_file=True,
    )
    skip = client.post(f"/api/review/{skipped.id}/skip")
    assert skip.status_code == 200
    assert skip.json()["needs_review"] is False
    assert skipped.id not in {row["id"] for row in client.get("/api/review").json()}

    approved = client.patch(
        f"/api/videos/{pending.id}",
        json={"title": "Placed", "channel": "Imports"},
    )
    assert approved.status_code == 200
    body = approved.json()
    assert body["needs_review"] is False
    assert body["channel"] == "Imports"
    assert client.get("/api/review").json() == []
    # Manual import is renamed onto Channel/Title.ext
    assert body["file_path"].endswith("Placed.mp4")
    assert (init_db["downloads"] / body["file_path"]).exists()


def test_bulk_delete_and_notes(client, add_video):
    a = add_video(title="A")
    b = add_video(title="B")
    c = add_video(title="C")
    notes = client.patch(
        "/api/videos/bulk-notes",
        json={"video_ids": [a.id, b.id], "notes": "batch"},
    )
    assert notes.status_code == 204
    assert client.get(f"/api/videos/{a.id}").json()["notes"] == "batch"
    assert client.get(f"/api/videos/{c.id}").json()["notes"] is None

    deleted = client.post(
        "/api/videos/bulk-delete", json={"video_ids": [a.id, b.id]}
    )
    assert deleted.status_code == 204
    assert client.get(f"/api/videos/{a.id}").status_code == 404
    assert client.get(f"/api/videos/{c.id}").status_code == 200


def test_stream_range_and_missing_file(client, add_video):
    payload = b"ABCDEFGHIJ" * 20  # 200 bytes
    video = add_video(title="Stream me", write_file=True, file_bytes=payload)
    full = client.get(f"/api/videos/{video.id}/stream")
    assert full.status_code == 200
    assert full.content == payload
    assert full.headers.get("accept-ranges") == "bytes"

    iphone = client.get(
        f"/api/videos/{video.id}/stream",
        headers={
            "User-Agent": (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
                "Mobile/15E148 Safari/604.1"
            )
        },
    )
    assert iphone.status_code == 200
    assert iphone.headers.get("accept-ranges") == "bytes"

    ranged = client.get(
        f"/api/videos/{video.id}/stream", headers={"Range": "bytes=10-19"}
    )
    assert ranged.status_code == 206
    assert ranged.content == payload[10:20]
    assert ranged.headers["Content-Range"] == "bytes 10-19/200"
    assert ranged.headers["Accept-Ranges"] == "bytes"

    missing = add_video(title="Ghost", file_path="Alpha/2024/Ghost [bbbbbbbbbb1].mp4")
    assert client.get(f"/api/videos/{missing.id}/stream").status_code == 404


def test_stream_iphone_runs_safari_remux(client, add_video, monkeypatch):
    called = {"n": 0}

    def fake_ensure(path):
        called["n"] += 1
        return path

    monkeypatch.setattr("app.api.videos.ensure_safari_mp4", fake_ensure)
    video = add_video(title="Phone", write_file=True, file_bytes=b"P" * 80)
    desktop = client.get(f"/api/videos/{video.id}/stream")
    assert desktop.status_code == 200
    assert called["n"] == 0

    phone = client.get(
        f"/api/videos/{video.id}/stream",
        headers={
            "User-Agent": (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
                "Mobile/15E148 Safari/604.1"
            )
        },
    )
    assert phone.status_code == 200
    assert called["n"] == 1


def test_health_and_system_activity(client, add_video):
    add_video(title="Lib")
    add_video(
        title="Review",
        needs_review=True,
        channel=None,
        file_path="imports/r.mp4",
    )
    health = client.get("/api/health")
    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "ok"
    assert body["library_video_count"] == 2
    assert body["review_pending_count"] == 1
    assert "downloads" in body
    assert "workers" in body

    activity = client.get("/api/system/activity")
    assert activity.status_code == 200
    snap = activity.json()
    assert "running" in snap
    assert "recent" in snap
    assert "queued" in snap

    stats = client.get("/api/system/stats")
    assert stats.status_code == 200
    assert "cpu_percent" in stats.json() or "ram_percent" in stats.json()


def test_review_upload_rejects_non_video(client):
    resp = client.post(
        "/api/review/upload",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert resp.status_code == 400


def test_duplicate_groups_by_youtube_id(client, add_video):
    add_video(title="Copy A", yt_id="dQw4w9WgXcQ", channel="Alpha")
    add_video(
        title="Copy B",
        yt_id="dQw4w9WgXcQ",
        channel="Alpha",
        file_path="Alpha/2023/Copy B [dQw4w9WgXcQ].mp4",
    )
    add_video(title="Unique", yt_id="xxxxxxxxxxx", channel="Beta")
    groups = client.get("/api/review/groups").json()
    yt_groups = [g for g in groups if g["match_type"] == "youtube_id"]
    assert len(yt_groups) == 1
    assert {v["title"] for v in yt_groups[0]["videos"]} == {"Copy A", "Copy B"}

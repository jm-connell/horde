"""HTTP regression: library, review, watch progress, streaming, channels."""

from datetime import UTC


def test_list_videos_hides_review_queue(client, add_video):
    ready = add_video(title="In library", channel="Alpha")
    add_video(
        title="Needs review",
        channel=None,
        needs_review=True,
        file_path="imports/drop.mp4",
    )
    body = client.get("/api/videos").json()["items"]
    ids = {row["id"] for row in body}
    assert ready.id in ids
    assert all(not row["needs_review"] for row in body)


def test_filter_and_sort_videos(client, add_video):
    add_video(title="Zebra", channel="Alpha", tags=["fun"])
    add_video(title="Aardvark", channel="Beta", tags=["fun"])
    add_video(title="Other", channel="Alpha", tags=["meh"])

    by_channel = client.get("/api/videos", params={"channel": "Alpha"}).json()["items"]
    assert {row["title"] for row in by_channel} == {"Zebra", "Other"}

    by_tag = client.get("/api/videos", params={"tag": "fun"}).json()["items"]
    assert {row["title"] for row in by_tag} == {"Zebra", "Aardvark"}

    sorted_asc = client.get(
        "/api/videos", params={"sort": "title", "order": "asc"}
    ).json()["items"]
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
    ignored = client.patch(f"/api/videos/{video.id}/progress", json={"position_sec": 2})
    assert ignored.status_code == 204
    assert client.get(f"/api/videos/{video.id}").json()["last_position_sec"] == 0.0

    saved = client.patch(f"/api/videos/{video.id}/progress", json={"position_sec": 40})
    assert saved.status_code == 204
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["last_position_sec"] == 40.0
    assert body["last_watched_at"] is not None

    row = client.get("/api/videos", params={"continue_watching": True}).json()["items"]
    assert [item["id"] for item in row] == [video.id]

    # Near-complete (>=90%) clears progress so it leaves continue-watching.
    done = client.patch(f"/api/videos/{video.id}/progress", json={"position_sec": 190})
    assert done.status_code == 204
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["last_position_sec"] == 0.0
    assert (
        client.get("/api/videos", params={"continue_watching": True}).json()["items"]
        == []
    )


def test_tags_and_storage_stats(client, add_video):
    add_video(title="A", tags=["alpha", "shared"], file_size=100)
    add_video(title="B", tags=["shared"], file_size=50)
    tags = client.get("/api/tags").json()["items"]
    assert tags == ["alpha", "shared"]
    stats = client.get("/api/tags/stats").json()["items"]
    by_tag = {row["tag"]: row["count"] for row in stats}
    assert by_tag["shared"] == 2
    assert by_tag["alpha"] == 1
    storage = client.get("/api/stats/storage").json()
    assert storage["video_count"] == 2
    assert storage["video_bytes"] == 150


def test_list_videos_are_compact(client, add_video):
    video = add_video(
        title="Chapter-rich",
        description="Intro\n0:00 Start\n1:00 Middle\n2:30 End\n",
        source_description="Source blurb",
        notes="private note",
        thumbnail_path="thumbs/missing.jpg",
    )

    row = next(
        r for r in client.get("/api/videos").json()["items"] if r["id"] == video.id
    )
    assert row["description"] is None
    assert row["source_description"] is None
    assert row["notes"] is None
    assert row["chapters"] == []
    assert row["subtitles"] == []
    # Compact list must not stat the filesystem — a set path is enough.
    assert row["has_thumbnail"] is True
    assert row["has_sprites"] is False

    detail = client.get(f"/api/videos/{video.id}").json()
    assert detail["description"] == video.description
    assert [c["title"] for c in detail["chapters"]] == ["Start", "Middle", "End"]
    assert detail["chapters_source"] == "description"


def test_continue_watching_get_is_read_only(
    client, add_video, session, admin_user, set_watch
):
    from datetime import datetime, timedelta

    from app.models import UserVideoState

    stale_cutoff = datetime.now(UTC) - timedelta(days=30)
    video = add_video(title="Stale progress", duration_sec=200.0)
    set_watch(admin_user, video, 40.0, stale_cutoff)

    client.get("/api/videos", params={"continue_watching": True})

    # Expiry now runs on a background tick, not this GET — position is untouched.
    session.expire_all()
    row = session.get(UserVideoState, (admin_user.id, video.id))
    assert row.position_sec == 40.0


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
    queue = client.get("/api/review").json()["items"]
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
    assert skipped.id not in {
        row["id"] for row in client.get("/api/review").json()["items"]
    }

    approved = client.patch(
        f"/api/videos/{pending.id}",
        json={"title": "Placed", "channel": "Imports"},
    )
    assert approved.status_code == 200
    body = approved.json()
    assert body["needs_review"] is False
    assert body["channel"] == "Imports"
    assert client.get("/api/review").json()["items"] == []
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

    deleted = client.post("/api/videos/bulk-delete", json={"video_ids": [a.id, b.id]})
    assert deleted.status_code == 204
    assert client.get(f"/api/videos/{a.id}").status_code == 404
    assert client.get(f"/api/videos/{c.id}").status_code == 200


def test_bulk_delete_removes_files(client, add_video, init_db):
    a = add_video(title="Gone A", write_file=True)
    b = add_video(title="Gone B", write_file=True)
    path_a = init_db["downloads"] / a.file_path
    path_b = init_db["downloads"] / b.file_path
    assert path_a.exists()
    assert path_b.exists()

    deleted = client.post(
        "/api/videos/bulk-delete",
        json={"video_ids": [a.id, b.id], "delete_files": True},
    )
    assert deleted.status_code == 204
    assert not path_a.exists()
    assert not path_b.exists()
    assert client.get(f"/api/videos/{a.id}").status_code == 404
    assert client.get(f"/api/videos/{b.id}").status_code == 404


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


_IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
    "Mobile/15E148 Safari/604.1"
)


def test_stream_get_never_rewrites_the_original(client, add_video, init_db):
    """A GET only serves what exists; even WebKit does not trigger a remux."""
    video = add_video(
        title="Phone",
        file_path="Alpha/2024/Phone [pppppppppp1].mkv",
        write_file=True,
        file_bytes=b"P" * 80,
    )
    path = init_db["downloads"] / video.file_path

    phone = client.get(
        f"/api/videos/{video.id}/stream", headers={"User-Agent": _IPHONE_UA}
    )

    assert phone.status_code == 200
    assert phone.content == b"P" * 80
    assert path.read_bytes() == b"P" * 80
    after = client.get(f"/api/videos/{video.id}").json()
    assert after["file_path"] == video.file_path


def test_safari_prep_is_an_explicit_post_that_queues_the_remux(
    client, add_video, init_db, monkeypatch
):
    import time

    from app.services import compat_rendition

    video = add_video(
        title="Phone",
        file_path="Alpha/2024/Phone [pppppppppp2].mkv",
        write_file=True,
        file_bytes=b"P" * 80,
    )
    original = init_db["downloads"] / video.file_path
    remuxed = original.with_suffix(".mp4")

    def fake_needs(path):
        return path.suffix != ".mp4"

    def fake_ensure(path, *, on_replace=None, **_kwargs):
        remuxed.write_bytes(b"R" * 40)
        if on_replace is not None:
            on_replace(remuxed)  # the row must point at the new file first
        path.unlink()
        return remuxed

    monkeypatch.setattr(compat_rendition, "needs_safari_prep", fake_needs)
    monkeypatch.setattr(compat_rendition, "ensure_safari_mp4", fake_ensure)

    state = client.get(f"/api/videos/{video.id}/compat/safari").json()
    assert state["status"] == "none"

    queued = client.post(f"/api/videos/{video.id}/compat/safari")
    assert queued.status_code == 200
    assert queued.json()["kind"] == "safari"

    deadline = time.time() + 10
    while time.time() < deadline:
        state = client.get(f"/api/videos/{video.id}/compat/safari").json()
        if state["status"] == "ready":
            break
        time.sleep(0.05)
    assert state["status"] == "ready"

    updated = client.get(f"/api/videos/{video.id}").json()
    assert updated["file_path"].endswith(".mp4")
    assert updated["file_size"] == 40
    streamed = client.get(
        f"/api/videos/{video.id}/stream", headers={"User-Agent": _IPHONE_UA}
    )
    assert streamed.content == b"R" * 40
    # Idempotent once ready: nothing is queued again.
    again = client.post(f"/api/videos/{video.id}/compat/safari").json()
    assert again["status"] == "ready"


def test_safari_prep_reports_a_failed_remux(client, add_video, init_db, monkeypatch):
    import time

    from app.services import compat_rendition

    video = add_video(
        title="Broken",
        file_path="Alpha/2024/Broken [pppppppppp3].mkv",
        write_file=True,
    )
    monkeypatch.setattr(compat_rendition, "needs_safari_prep", lambda path: True)
    monkeypatch.setattr(
        compat_rendition, "ensure_safari_mp4", lambda path, **_kwargs: path
    )

    client.post(f"/api/videos/{video.id}/compat/safari")
    deadline = time.time() + 10
    state = {}
    while time.time() < deadline:
        state = client.get(f"/api/videos/{video.id}/compat/safari").json()
        if state["status"] == "error":
            break
        time.sleep(0.05)
    assert state["status"] == "error"
    assert "Safari" in state["error"]


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
    body = stats.json()
    assert "cpu_percent" in body or "ram_percent" in body
    assert "encode" in body


def test_health_last_extract_failure_names_video(client, monkeypatch):
    from app.services.ytdlp_common import classify_ytdlp_error, record_extract_failure

    monkeypatch.setattr("app.services.ytdlp_common.cookie_configured", lambda: False)
    kind, message = classify_ytdlp_error(
        "Login required / age-restricted",
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title="Secret Video",
        channel="Some Channel",
    )
    record_extract_failure(
        kind,
        message,
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title="Secret Video",
        channel="Some Channel",
    )
    body = client.get("/api/health").json()
    last = body["youtube"]["last_extract_failure"]
    assert last["kind"] == "cookies"
    assert last["target"] == '"Secret Video" · Some Channel'
    assert "anonymously" in last["message"]
    assert "Secret Video" in last["message"]


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
    groups = client.get("/api/review/groups").json()["items"]
    yt_groups = [g for g in groups if g["match_type"] == "youtube_id"]
    assert len(yt_groups) == 1
    assert {v["title"] for v in yt_groups[0]["videos"]} == {"Copy A", "Copy B"}


def test_stream_range_forms(client, add_video):
    payload = bytes(range(200))
    video = add_video(title="Ranges", write_file=True, file_bytes=payload)
    url = f"/api/videos/{video.id}/stream"

    def get(value: str):
        return client.get(url, headers={"Range": value})

    suffix = get("bytes=-50")
    assert suffix.status_code == 206
    assert suffix.content == payload[-50:]
    assert suffix.headers["Content-Range"] == "bytes 150-199/200"
    assert suffix.headers["Content-Length"] == "50"

    open_ended = get("bytes=190-")
    assert open_ended.status_code == 206
    assert open_ended.content == payload[190:]
    assert open_ended.headers["Content-Range"] == "bytes 190-199/200"

    bounded = get("bytes=10-19")
    assert bounded.content == payload[10:20]

    clamped = get("bytes=190-5000")
    assert clamped.content == payload[190:]

    oversized_suffix = get("bytes=-5000")
    assert oversized_suffix.status_code == 206
    assert oversized_suffix.content == payload
    assert oversized_suffix.headers["Content-Range"] == "bytes 0-199/200"

    for bad in ("bytes=-", "bytes=-0", "bytes=200-", "bytes=50-10", "bytes=a-b"):
        assert get(bad).status_code == 416, bad


def test_duplicate_groups_page(client, add_video):
    for n in range(3):
        for copy in ("A", "B"):
            add_video(title=f"Pair {n} copy {copy}", yt_id=f"dupdupdup{n:02d}")
    first = client.get("/api/review/groups", params={"limit": 2}).json()
    assert len(first["items"]) == 2
    assert first["next_cursor"]
    rest = client.get(
        "/api/review/groups", params={"limit": 2, "cursor": first["next_cursor"]}
    ).json()
    assert len(rest["items"]) == 1
    assert rest["next_cursor"] is None
    seen = {tuple(sorted(v["id"] for v in g["videos"])) for g in first["items"]}
    assert not seen & {
        tuple(sorted(v["id"] for v in g["videos"])) for g in rest["items"]
    }
    assert client.get("/api/review/groups", params={"cursor": "x"}).status_code == 400


def test_tags_and_tag_stats_page_without_losing_any(client, add_video):
    names = [f"tag{n:03d}" for n in range(25)]
    for n, name in enumerate(names):
        # tag000 is on 25 videos, tag001 on 24, ... so the counts rank them.
        for _ in range(25 - n):
            add_video(tags=[name])
    seen: list[str] = []
    cursor = None
    while True:
        params = {"limit": 10, **({"cursor": cursor} if cursor else {})}
        body = client.get("/api/tags", params=params).json()
        seen += body["items"]
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert seen == names

    ranked: list[str] = []
    cursor = None
    while True:
        params = {"limit": 10, **({"cursor": cursor} if cursor else {})}
        body = client.get("/api/tags/stats", params=params).json()
        ranked += [row["tag"] for row in body["items"]]
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert ranked == names
    assert client.get("/api/tags", params={"cursor": "zz"}).status_code == 400

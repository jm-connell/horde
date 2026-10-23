"""The trash: deleted videos wait for HORDE_TRASH_DAYS and can be restored."""

from __future__ import annotations

import errno
import json
import os
import shutil
import sqlite3
import time
from datetime import timedelta
from pathlib import Path

import pytest
from sqlmodel import Session, select

from app import config
from app.models import (
    ChannelAutodownload,
    ChannelCatalogVideo,
    Playlist,
    PlaylistItem,
    TrashEntry,
    UserVideoState,
    Video,
    VideoAiChatMessage,
    VideoAiMeta,
    VideoEmbedding,
    utcnow,
)
from app.services import channel_autodownload as ad
from app.services import scanner, temp_sweep, trash
from app.services.auth import accounts
from app.services.downloads.queue import DownloadQueue
from app.services.library_usage import library_usage
from app.services.paths import TRASH_DIR_NAME

ENTRY_HEADER = "x-horde-trash-entry"
ENTRIES_HEADER = "x-horde-trash-entries"
VECTOR = bytes(range(256)) * 3  # binary, so base64 round-trips are exercised


@pytest.fixture(autouse=True)
def trash_on(monkeypatch):
    monkeypatch.setattr(config, "TRASH_DAYS", 7)


def _search_ids(client, query: str) -> list[int]:
    resp = client.get("/api/videos", params={"q": query})
    assert resp.status_code == 200
    return [v["id"] for v in resp.json()["items"]]


def _build(init_db, add_video, member_user, admin_user, *, yt_id="trashvid001"):
    """A video with media, derived files and a row in every table a restore must refill."""
    downloads, data, engine = init_db["downloads"], init_db["data"], init_db["engine"]
    video = add_video(
        write_file=True,
        file_bytes=b"M" * 1000,
        yt_id=yt_id,
        title="Zebrafish tutorial",
        tags=["cats", "dogs"],
        description="a quirkywordhere in the description",
    )
    other = add_video(write_file=True, yt_id="keeper00001", title="Unrelated clip")
    thumbs, sprites = data / "thumbnails", data / "sprites"
    thumbs.mkdir(exist_ok=True)
    sprites.mkdir(exist_ok=True)
    files = {
        "thumb_full": thumbs / f"{video.id}.jpg",
        "thumb_list": thumbs / f"{video.id}_sm.jpg",
        "sprite": sprites / f"{video.id}.jpg",
        "sprite_meta": sprites / f"{video.id}.json",
        "compat": downloads / "compat" / "side.mp4",
        "sub": downloads / "subs" / "en.vtt",
    }
    for key, path in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(key.encode())
    with Session(engine) as session:
        row = session.get(Video, video.id)
        row.thumbnail_path = str(files["thumb_full"])
        row.compat_path = "compat/side.mp4"
        row.subtitles = json.dumps([{"lang": "en", "path": "subs/en.vtt"}])
        playlist = Playlist(name="Mine", cover_video_id=video.id)
        session.add_all([row, playlist])
        session.commit()
        session.add_all(
            [
                PlaylistItem(playlist_id=playlist.id, video_id=other.id, position=0),
                PlaylistItem(playlist_id=playlist.id, video_id=video.id, position=1),
                VideoEmbedding(video_id=video.id, chunk_index=-1, vector=VECTOR, dim=3),
                VideoEmbedding(video_id=video.id, chunk_index=0, vector=b"\x00\xff"),
                VideoAiMeta(video_id=video.id, summary="A summary", ai_tags='["ml"]'),
                VideoAiChatMessage(
                    video_id=video.id, user_id=admin_user.id, content="hello"
                ),
                VideoAiChatMessage(
                    video_id=video.id, user_id=member_user.id, content="hi there"
                ),
                UserVideoState(
                    user_id=admin_user.id, video_id=video.id, position_sec=12.5
                ),
                UserVideoState(
                    user_id=member_user.id, video_id=video.id, position_sec=99.0
                ),
            ]
        )
        session.commit()
        playlist_id = playlist.id
    return video.id, other.id, playlist_id, files


def _media(init_db) -> str:
    return "Alpha/2024/Zebrafish tutorial [trashvid001].mp4"


def _folder(init_db, entry_id: int) -> str:
    """The folder name of a trash entry (a token, not the id)."""
    with Session(init_db["engine"]) as session:
        return session.get(TrashEntry, entry_id).folder


def _state(engine, video_id):
    with Session(engine) as session:
        return {
            "videos": session.exec(select(Video).where(Video.id == video_id)).all(),
            "entries": session.exec(select(TrashEntry)).all(),
        }


def test_delete_goes_to_trash_and_restore_brings_everything_back(
    client, init_db, add_video, member_user, admin_user
):
    engine, downloads, data = init_db["engine"], init_db["downloads"], init_db["data"]
    video_id, other_id, playlist_id, files = _build(
        init_db, add_video, member_user, admin_user
    )
    media = downloads / _media(init_db)
    assert _search_ids(client, "quirkywordhere") == [video_id]

    resp = client.delete(f"/api/videos/{video_id}?delete_file=true")
    assert resp.status_code == 204
    entry_id = int(resp.headers[ENTRY_HEADER])

    # Gone from the library, search, tags and playlists.
    assert client.get(f"/api/videos/{video_id}").status_code == 404
    assert _search_ids(client, "quirkywordhere") == []
    assert "cats" not in {
        t["tag"] for t in client.get("/api/tags/stats").json()["items"]
    }
    with Session(engine) as session:
        items = session.exec(select(PlaylistItem)).all()
        assert [i.video_id for i in items] == [other_id]
        assert session.exec(select(UserVideoState)).all() == []
        assert session.get(Playlist, playlist_id).cover_video_id is None
    # The files moved, not copied.
    assert not media.exists()
    assert not any(p.exists() for p in files.values())
    folder = _folder(init_db, entry_id)
    trashed = downloads / TRASH_DIR_NAME / folder / _media(init_db)
    assert trashed.read_bytes() == b"M" * 1000
    assert (data / "trash" / folder / "thumbnails" / f"{video_id}.jpg").exists()

    summary = client.get("/api/trash/summary").json()
    assert summary["count"] == 1
    assert summary["retention_days"] == 7
    assert summary["total_bytes"] >= 1000

    listing = client.get("/api/trash").json()
    assert listing["next_cursor"] is None
    (item,) = listing["items"]
    assert item["id"] == entry_id
    assert item["video_id"] == video_id
    assert item["title"] == "Zebrafish tutorial"
    assert item["trashed_by"] == "admin"
    assert item["size_bytes"] == summary["total_bytes"]
    trashed_at = item["trashed_at"]
    assert item["expires_at"] > trashed_at
    assert client.get(item["thumbnail_url"]).status_code == 200

    restored = client.post(f"/api/trash/{entry_id}/restore")
    assert restored.status_code == 200
    assert restored.json() == {"video_id": video_id, "title": "Zebrafish tutorial"}

    # Everything is back, under the same id.
    video = client.get(f"/api/videos/{video_id}").json()
    assert video["tags"] == ["cats", "dogs"]
    assert media.read_bytes() == b"M" * 1000
    assert all(p.exists() for p in files.values())
    assert _search_ids(client, "quirkywordhere") == [video_id]
    assert _search_ids(client, "Zebrafish") == [video_id]
    tags = {t["tag"]: t["count"] for t in client.get("/api/tags/stats").json()["items"]}
    assert tags["cats"] == 1
    with Session(engine) as session:
        assert {
            (i.video_id, i.position) for i in session.exec(select(PlaylistItem)).all()
        } == {(other_id, 0), (video_id, 1)}
        assert session.get(Playlist, playlist_id).cover_video_id == video_id
        states = {
            s.user_id: s.position_sec for s in session.exec(select(UserVideoState))
        }
        assert states == {admin_user.id: 12.5, member_user.id: 99.0}
        assert {
            m.user_id: m.content for m in session.exec(select(VideoAiChatMessage))
        } == {admin_user.id: "hello", member_user.id: "hi there"}
        assert session.get(VideoAiMeta, video_id).summary == "A summary"
        vectors = {
            e.chunk_index: e.vector for e in session.exec(select(VideoEmbedding))
        }
        assert vectors == {-1: VECTOR, 0: b"\x00\xff"}
        assert session.exec(select(TrashEntry)).all() == []
    assert not (downloads / TRASH_DIR_NAME / folder).exists()
    assert not (data / "trash" / folder).exists()
    assert client.get("/api/trash/summary").json()["count"] == 0


def test_delete_forever_erases_the_files(
    client, init_db, add_video, member_user, admin_user
):
    video_id, _, _, _ = _build(init_db, add_video, member_user, admin_user)
    downloads, data = init_db["downloads"], init_db["data"]
    first = client.delete(f"/api/videos/{video_id}?delete_file=true")
    entry_id = int(first.headers[ENTRY_HEADER])
    folder = _folder(init_db, entry_id)
    assert (downloads / TRASH_DIR_NAME / folder).exists()

    assert client.delete(f"/api/trash/{entry_id}").status_code == 204

    assert not (downloads / TRASH_DIR_NAME / folder).exists()
    assert not (data / "trash" / folder).exists()
    assert client.get("/api/trash/summary").json()["count"] == 0
    assert client.delete(f"/api/trash/{entry_id}").status_code == 404
    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 404
    assert client.get(f"/api/trash/{entry_id}/thumbnail").status_code == 404


def test_deleted_again_after_a_restore_gets_a_new_entry(
    client, init_db, add_video, member_user, admin_user
):
    video_id, _, _, _ = _build(init_db, add_video, member_user, admin_user)
    first = int(
        client.delete(f"/api/videos/{video_id}?delete_file=true").headers[ENTRY_HEADER]
    )
    assert client.post(f"/api/trash/{first}/restore").status_code == 200
    second = int(
        client.delete(f"/api/videos/{video_id}?delete_file=true").headers[ENTRY_HEADER]
    )
    assert second > first


def test_bulk_delete_then_empty_trash(client, init_db, add_video):
    downloads = init_db["downloads"]
    a = add_video(write_file=True)
    b = add_video(write_file=True)
    c = add_video(write_file=True)
    body = {"video_ids": [a.id, b.id, 9999], "delete_files": True}
    resp = client.post("/api/videos/bulk-delete", json=body)
    assert resp.status_code == 204
    entry_ids = [int(i) for i in resp.headers[ENTRIES_HEADER].split(",")]
    assert len(entry_ids) == 2
    assert not (downloads / a.file_path).exists()
    assert (downloads / c.file_path).exists()
    listing = client.get("/api/trash").json()["items"]
    assert [i["id"] for i in listing] == sorted(entry_ids, reverse=True)  # newest first

    emptied = client.post("/api/trash/empty")
    assert emptied.status_code == 200
    assert emptied.json()["deleted"] == 2
    assert emptied.json()["freed_bytes"] > 0
    assert client.get("/api/trash/summary").json()["count"] == 0
    assert list((downloads / TRASH_DIR_NAME).iterdir()) == []
    assert client.post("/api/trash/empty").json() == {"deleted": 0, "freed_bytes": 0}


def test_trash_list_pages_with_a_cursor(client, add_video):
    ids = [add_video(write_file=True).id for _ in range(3)]
    client.post(
        "/api/videos/bulk-delete", json={"video_ids": ids, "delete_files": True}
    )
    first = client.get("/api/trash", params={"limit": 2}).json()
    assert len(first["items"]) == 2
    assert first["next_cursor"]
    second = client.get(
        "/api/trash", params={"limit": 2, "cursor": first["next_cursor"]}
    ).json()
    assert len(second["items"]) == 1
    assert second["next_cursor"] is None
    seen = [i["video_id"] for i in first["items"] + second["items"]]
    assert sorted(seen) == sorted(ids)
    assert client.get("/api/trash", params={"cursor": "junk"}).status_code == 400


def test_keeping_the_file_is_not_a_trash_move(client, init_db, add_video):
    video = add_video(write_file=True)
    resp = client.delete(f"/api/videos/{video.id}")
    assert resp.status_code == 204
    assert ENTRY_HEADER not in resp.headers
    assert (init_db["downloads"] / video.file_path).exists()
    assert client.get("/api/trash/summary").json()["count"] == 0


def test_trash_days_zero_deletes_immediately(client, init_db, add_video, monkeypatch):
    monkeypatch.setattr(config, "TRASH_DAYS", 0)
    video = add_video(write_file=True)
    other = add_video(write_file=True)
    single = client.delete(f"/api/videos/{video.id}?delete_file=true")
    assert single.status_code == 204
    assert ENTRY_HEADER not in single.headers
    bulk = client.post(
        "/api/videos/bulk-delete", json={"video_ids": [other.id], "delete_files": True}
    )
    assert bulk.status_code == 204
    assert ENTRIES_HEADER not in bulk.headers
    assert not (init_db["downloads"] / video.file_path).exists()
    assert not (init_db["downloads"] / other.file_path).exists()
    assert client.get("/api/trash/summary").json() == {
        "count": 0,
        "total_bytes": 0,
        "retention_days": 0,
    }


def test_purge_removes_expired_entries_only(client, init_db, add_video):
    old = add_video(write_file=True)
    new = add_video(write_file=True)
    old_id = int(
        client.delete(f"/api/videos/{old.id}?delete_file=true").headers[ENTRY_HEADER]
    )
    new_id = int(
        client.delete(f"/api/videos/{new.id}?delete_file=true").headers[ENTRY_HEADER]
    )
    old_folder, new_folder = _folder(init_db, old_id), _folder(init_db, new_id)
    with Session(init_db["engine"]) as session:
        entry = session.get(TrashEntry, old_id)
        entry.trashed_at = utcnow() - timedelta(days=7, minutes=1)
        session.add(entry)
        session.commit()

    assert trash.purge_expired() == 1

    ids = [i["id"] for i in client.get("/api/trash").json()["items"]]
    assert ids == [new_id]
    downloads = init_db["downloads"] / TRASH_DIR_NAME
    assert not (downloads / old_folder).exists()
    assert (downloads / new_folder).exists()
    # Later still: the other one goes too.
    assert trash.purge_expired(utcnow() + timedelta(days=8)) == 1
    assert client.get("/api/trash/summary").json()["count"] == 0


def test_purge_drops_an_entry_whose_files_went_missing(client, init_db, add_video):
    video = add_video(write_file=True)
    entry_id = int(
        client.delete(f"/api/videos/{video.id}?delete_file=true").headers[ENTRY_HEADER]
    )
    shutil.rmtree(init_db["downloads"] / TRASH_DIR_NAME / _folder(init_db, entry_id))
    assert trash.purge_expired() == 1
    assert client.get("/api/trash/summary").json()["count"] == 0


def test_the_sweep_never_erases_a_folder_nobody_owns(init_db):
    root = init_db["downloads"] / TRASH_DIR_NAME
    stale = root / "41"
    fresh = root / "42"
    for folder in (stale, fresh):
        folder.mkdir(parents=True)
        (folder / "x.mp4").write_bytes(b"x")
    old = time.time() - 3 * 86400
    os.utime(stale, (old, old))
    trash.purge_expired()
    # No manifest, no video: it is not ours to delete.
    assert (stale / "x.mp4").exists()
    assert (fresh / "x.mp4").exists()


def test_restore_refuses_when_the_path_is_taken(
    client, init_db, add_video, member_user, admin_user
):
    video_id, _, _, _ = _build(init_db, add_video, member_user, admin_user)
    entry_id = int(
        client.delete(f"/api/videos/{video_id}?delete_file=true").headers[ENTRY_HEADER]
    )
    taken = init_db["downloads"] / _media(init_db)
    taken.parent.mkdir(parents=True, exist_ok=True)
    taken.write_bytes(b"someone else")

    resp = client.post(f"/api/trash/{entry_id}/restore")

    assert resp.status_code == 409
    assert resp.json()["code"] == "trash_conflict"
    assert taken.read_bytes() == b"someone else"
    assert client.get("/api/trash/summary").json()["count"] == 1
    assert client.get(f"/api/videos/{video_id}").status_code == 404


def test_restore_refuses_when_downloaded_again(
    client, init_db, add_video, member_user, admin_user
):
    video_id, _, _, _ = _build(init_db, add_video, member_user, admin_user)
    entry_id = int(
        client.delete(f"/api/videos/{video_id}?delete_file=true").headers[ENTRY_HEADER]
    )
    again = add_video(
        write_file=True,
        yt_id="trashvid001",
        file_path="Other/again [trashvid001].mp4",
    )

    resp = client.post(f"/api/trash/{entry_id}/restore")

    assert resp.status_code == 409
    assert resp.json()["code"] == "trash_conflict"
    assert client.get(f"/api/videos/{again.id}").status_code == 200
    # The user can still erase the trashed copy.
    assert client.delete(f"/api/trash/{entry_id}").status_code == 204


def test_restore_skips_playlists_and_users_that_are_gone(
    client, init_db, add_video, member_user, admin_user
):
    video_id, other_id, playlist_id, _ = _build(
        init_db, add_video, member_user, admin_user
    )
    entry_id = int(
        client.delete(f"/api/videos/{video_id}?delete_file=true").headers[ENTRY_HEADER]
    )
    with Session(init_db["engine"]) as session:
        playlist = session.get(Playlist, playlist_id)
        session.delete(playlist)
        accounts.delete_user(session, member_user.id)

    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 200

    with Session(init_db["engine"]) as session:
        assert session.exec(select(PlaylistItem)).all() == []
        assert [s.user_id for s in session.exec(select(UserVideoState))] == [
            admin_user.id
        ]
        assert [m.user_id for m in session.exec(select(VideoAiChatMessage))] == [
            admin_user.id
        ]


def test_deleting_the_account_keeps_the_entry(
    client, init_db, add_video, member_user, admin_user
):
    video = add_video(write_file=True)
    # Deleted by the member, who then leaves.
    with Session(init_db["engine"]) as session:
        row = session.get(Video, video.id)
        trash.trash_video(session, row, member_user.id)
    with Session(init_db["engine"]) as session:
        accounts.delete_user(session, member_user.id)
    (item,) = client.get("/api/trash").json()["items"]
    assert item["trashed_by"] is None


def test_a_failed_move_leaves_the_video_untouched(
    client, init_db, add_video, member_user, admin_user, monkeypatch
):
    video_id, _, _, files = _build(init_db, add_video, member_user, admin_user)
    media = init_db["downloads"] / _media(init_db)
    real_move = trash._move
    calls = {"n": 0}

    def flaky(src, dst, **kw):
        calls["n"] += 1
        if calls["n"] == 3:
            raise OSError("disk went away")
        real_move(src, dst, **kw)

    monkeypatch.setattr(trash, "_move", flaky)

    resp = client.delete(f"/api/videos/{video_id}?delete_file=true")

    assert resp.status_code == 500
    assert resp.json()["code"] == "trash_failed"
    assert client.get(f"/api/videos/{video_id}").status_code == 200
    assert media.read_bytes() == b"M" * 1000
    assert all(p.exists() for p in files.values())
    assert client.get("/api/trash/summary").json()["count"] == 0
    assert _trash_folders(init_db) == []
    assert _search_ids(client, "quirkywordhere") == [video_id]


def test_a_failed_commit_puts_the_files_back(init_db, add_video, monkeypatch):
    video = add_video(write_file=True)
    media = init_db["downloads"] / video.file_path
    with Session(init_db["engine"]) as session:
        row = session.get(Video, video.id)

        def failing_commit():
            raise RuntimeError("database is locked")

        monkeypatch.setattr(session, "commit", failing_commit)
        with pytest.raises(trash.TrashError):
            trash.trash_video(session, row, None)
    assert media.exists()
    with Session(init_db["engine"]) as session:
        assert session.get(Video, video.id) is not None
        assert session.exec(select(TrashEntry)).all() == []


def test_a_failed_restore_puts_the_files_back_in_the_trash(
    client, init_db, add_video, member_user, admin_user, monkeypatch
):
    video_id, _, _, _ = _build(init_db, add_video, member_user, admin_user)
    entry_id = int(
        client.delete(f"/api/videos/{video_id}?delete_file=true").headers[ENTRY_HEADER]
    )
    monkeypatch.setattr(
        trash,
        "_insert_rows",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 500

    monkeypatch.undo()
    assert not (init_db["downloads"] / _media(init_db)).exists()
    assert (
        init_db["downloads"]
        / TRASH_DIR_NAME
        / _folder(init_db, entry_id)
        / _media(init_db)
    ).exists()
    assert client.get("/api/trash/summary").json()["count"] == 1
    # And it can still be restored once the problem is gone.
    monkeypatch.setattr(config, "TRASH_DAYS", 7)
    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 200


def test_never_trashes_files_outside_the_library(client, init_db, add_video, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    precious = outside / "thumb.jpg"
    precious.write_bytes(b"precious")
    video = add_video(write_file=True, thumbnail_path=str(precious))
    assert client.delete(f"/api/videos/{video.id}?delete_file=true").status_code == 204
    assert precious.read_bytes() == b"precious"


def test_the_trash_still_counts_against_the_size_limit(client, init_db, add_video):
    video = add_video(write_file=True, file_bytes=b"x" * 5000, file_size=5000)
    with Session(init_db["engine"]) as session:
        before = library_usage(session)
    client.delete(f"/api/videos/{video.id}?delete_file=true")
    with Session(init_db["engine"]) as session:
        after = library_usage(session)
    assert after.video_bytes == 0
    assert after.trash_bytes >= 5000
    assert after.total_bytes == before.total_bytes  # the bytes moved, they did not go
    stats = client.get("/api/stats/storage").json()
    assert stats["trash_bytes"] == after.trash_bytes
    assert stats["total_bytes"] == after.total_bytes


def test_erasing_the_trash_wakes_held_downloads(client, add_video, monkeypatch):
    woken: list[bool] = []
    # On the class: the queue is a process-wide singleton, and patching the instance
    # would leave a stale attribute behind for later tests.
    monkeypatch.setattr(
        DownloadQueue,
        "library_changed",
        lambda self, *, room_made=False: woken.append(room_made),
    )
    video = add_video(write_file=True)
    entry_id = int(
        client.delete(f"/api/videos/{video.id}?delete_file=true").headers[ENTRY_HEADER]
    )
    assert woken == [False]  # moving to the trash frees nothing
    client.delete(f"/api/trash/{entry_id}")
    assert woken == [False, True]
    other = add_video(write_file=True)
    client.delete(f"/api/videos/{other.id}?delete_file=true")
    client.post("/api/trash/empty")
    assert woken[-1] is True


def test_the_scanner_ignores_the_trash(client, init_db, add_video):
    video = add_video(write_file=True)
    entry_id = int(
        client.delete(f"/api/videos/{video.id}?delete_file=true").headers[ENTRY_HEADER]
    )
    folder = _folder(init_db, entry_id)
    trashed = init_db["downloads"] / TRASH_DIR_NAME / folder / video.file_path
    assert trashed.is_file()
    assert scanner._is_media(trashed) is False
    with Session(init_db["engine"]) as session:
        assert scanner.ingest_media_file(session, trashed, require_stable=False) is None
    added, _ = scanner.scan_once(blocking=True)
    assert added == 0
    with Session(init_db["engine"]) as session:
        assert session.exec(select(Video)).all() == []
    assert scanner.cleanup_orphans() == 0


def test_the_temp_sweep_leaves_the_trash_alone(init_db):
    leftover = init_db["downloads"] / TRASH_DIR_NAME / "3" / "Chan" / "a [x].norm.5.mp4"
    leftover.parent.mkdir(parents=True)
    leftover.write_bytes(b"x")
    old = time.time() - 24 * 3600
    os.utime(leftover, (old, old))
    assert temp_sweep.sweep_temp_artifacts(max_age_hours=1) == []
    assert leftover.exists()


def test_restoring_does_not_let_the_watcher_import_the_file_twice(
    client, init_db, add_video, monkeypatch
):
    video = add_video(write_file=True)
    entry_id = int(
        client.delete(f"/api/videos/{video.id}?delete_file=true").headers[ENTRY_HEADER]
    )
    seen: list[bool] = []
    real_apply = trash._apply_moves

    def spy(moves, src_of, dst_of, done):
        real_apply(moves, src_of, dst_of, done)
        seen.append(scanner._is_active(video.file_path))

    monkeypatch.setattr(trash, "_apply_moves", spy)
    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 200
    assert seen == [True]
    assert scanner._is_active(video.file_path) is False


def test_autodownload_does_not_fetch_a_trashed_video(
    client, init_db, add_video, session
):
    video = add_video(write_file=True, yt_id="trashedvid1")
    client.delete(f"/api/videos/{video.id}?delete_file=true")
    assert trash.trashed_youtube_ids(session) == {"trashedvid1"}

    rows = [
        ChannelCatalogVideo(
            catalog_id=1,
            yt_id=yt,
            url=f"https://www.youtube.com/watch?v={yt}",
            title=yt,
            duration=600,
            live_status="not_live",
            position=i,
        )
        for i, yt in enumerate(["trashedvid1", "newvideo001"])
    ]
    policy = ChannelAutodownload(channel_url="https://www.youtube.com/@x", enabled=True)
    eligible = ad._eligible_rows(session, policy, rows, queued_ids=set())
    assert [r.yt_id for r in eligible] == ["newvideo001"]
    assert ad.enqueue_catalog_row(session, rows[0], policy) is None


def test_factory_reset_with_media_empties_the_trash(client, init_db, add_video):
    video = add_video(write_file=True)
    client.delete(f"/api/videos/{video.id}?delete_file=true")
    thumbs = init_db["data"] / "trash" / "1" / "thumbnails"
    thumbs.mkdir(parents=True)
    (thumbs / "x.jpg").write_bytes(b"x")

    resp = client.post(
        "/api/setup/reset", json={"erase_media": True, "confirm": "ERASE MEDIA"}
    )

    assert resp.status_code == 200
    with Session(init_db["engine"]) as session:
        assert session.exec(select(TrashEntry)).all() == []
    assert not (init_db["downloads"] / TRASH_DIR_NAME).exists()
    assert not (init_db["data"] / "trash").exists() or not any(
        (init_db["data"] / "trash").iterdir()
    )


def test_member_needs_the_delete_right(
    member_client, client, init_db, add_video, member_user
):
    video = add_video(write_file=True)
    entry_id = int(
        client.delete(f"/api/videos/{video.id}?delete_file=true").headers[ENTRY_HEADER]
    )
    for method, path in [
        ("get", "/api/trash"),
        ("get", "/api/trash/summary"),
        ("post", "/api/trash/empty"),
        ("get", f"/api/trash/{entry_id}/thumbnail"),
        ("post", f"/api/trash/{entry_id}/restore"),
        ("delete", f"/api/trash/{entry_id}"),
    ]:
        resp = getattr(member_client, method)(path)
        assert resp.status_code == 403, (method, path)
    # Nothing happened.
    assert client.get("/api/trash/summary").json()["count"] == 1

    with Session(init_db["engine"]) as session:
        accounts.update_user(session, member_user.id, granted=["delete_videos"])
    assert member_client.get("/api/trash/summary").json()["count"] == 1
    assert member_client.post(f"/api/trash/{entry_id}/restore").status_code == 200


def test_the_purge_worker_runs_the_sweep(init_db, add_video, monkeypatch):
    video = add_video(write_file=True)
    with Session(init_db["engine"]) as session:
        entry = trash.trash_video(session, session.get(Video, video.id), None)
        entry.trashed_at = utcnow() - timedelta(days=30)
        session.add(entry)
        session.commit()
    monkeypatch.setattr(trash, "STARTUP_DELAY_SEC", 0.0)
    worker = trash.create_worker()
    worker.start()
    try:
        for _ in range(100):
            with Session(init_db["engine"]) as session:
                if not session.exec(select(TrashEntry)).all():
                    break
            time.sleep(0.05)
        else:
            pytest.fail("the worker did not purge the expired entry")
    finally:
        assert worker.stop(timeout=5)


def test_a_damaged_file_list_is_refused_not_followed(client, init_db, add_video):
    video = add_video(write_file=True)
    entry_id = int(
        client.delete(f"/api/videos/{video.id}?delete_file=true").headers[ENTRY_HEADER]
    )
    with Session(init_db["engine"]) as session:
        entry = session.get(TrashEntry, entry_id)
        entry.files_json = json.dumps(
            [{"root": "downloads", "path": "../../etc/evil", "size": 1}]
        )
        session.add(entry)
        session.commit()

    assert client.post(f"/api/trash/{entry_id}/restore").status_code == 500
    # Listing and purging cope with it instead of failing for everyone.
    assert client.get("/api/trash").status_code == 200
    assert trash.purge_expired() == 0
    assert client.delete(f"/api/trash/{entry_id}").status_code == 204


# --- Crash safety, outages and the write lock ---------------------------------


class Crash(BaseException):
    """Stands for the process dying: nothing in trash.py may catch it."""


def _trash_folders(init_db) -> list:
    root = init_db["downloads"] / TRASH_DIR_NAME
    return [p for p in root.iterdir() if p.is_dir()] if root.is_dir() else []


def _age_trash_folders(init_db, days: float = 2) -> None:
    old = time.time() - days * 86400
    for folder in _trash_folders(init_db):
        os.utime(folder, (old, old))


def _survives(init_db, live: Path) -> bool:
    """The file exists at its library path or somewhere in the trash."""
    if live.exists():
        return True
    root = init_db["downloads"] / TRASH_DIR_NAME
    return root.is_dir() and any(p.name == live.name for p in root.rglob("*"))


def test_a_crash_before_the_commit_does_not_lose_the_media(
    init_db, add_video, monkeypatch
):
    video = add_video(write_file=True, file_bytes=b"M" * 100)
    media = init_db["downloads"] / video.file_path
    with Session(init_db["engine"]) as session:
        row = session.get(Video, video.id)

        def crash():
            raise Crash

        monkeypatch.setattr(session, "commit", crash)
        with pytest.raises(Crash):
            trash.trash_video(session, row, None)
    monkeypatch.undo()
    monkeypatch.setattr(config, "TRASH_DAYS", 7)
    with Session(init_db["engine"]) as session:
        assert session.get(Video, video.id) is not None  # still in the library
        assert session.exec(select(TrashEntry)).all() == []
    assert not media.exists()  # the files are in the trash folder

    _age_trash_folders(init_db)
    trash.purge_expired()

    # The sweep put the files back for the video that still has a row.
    assert media.read_bytes() == b"M" * 100
    assert _trash_folders(init_db) == []


def test_a_crashed_trash_does_not_share_its_folder_with_the_next(
    client, init_db, add_video, monkeypatch
):
    crashed = add_video(write_file=True, file_bytes=b"A" * 100)
    other = add_video(write_file=True, file_bytes=b"B" * 100)
    with Session(init_db["engine"]) as session:
        row = session.get(Video, crashed.id)
        monkeypatch.setattr(session, "commit", lambda: (_ for _ in ()).throw(Crash()))
        with pytest.raises(Crash):
            trash.trash_video(session, row, None)
    monkeypatch.undo()
    monkeypatch.setattr(config, "TRASH_DAYS", 7)

    client.delete(f"/api/videos/{other.id}?delete_file=true")
    assert client.post("/api/trash/empty").json()["deleted"] == 1

    assert _survives(init_db, init_db["downloads"] / crashed.file_path)


def test_a_failed_undo_keeps_the_files_it_could_not_put_back(
    init_db, add_video, monkeypatch
):
    video = add_video(write_file=True, file_bytes=b"M" * 100)
    sub = init_db["downloads"] / "subs" / "x.vtt"
    sub.parent.mkdir(parents=True, exist_ok=True)
    sub.write_text("sub")
    with Session(init_db["engine"]) as session:
        row = session.get(Video, video.id)
        row.subtitles = '[{"lang":"en","path":"subs/x.vtt"}]'
        session.add(row)
        session.commit()
    real = trash._move
    calls = {"n": 0}

    def flaky(src, dst, **kw):
        calls["n"] += 1
        if calls["n"] >= 2:  # the second forward move, then every undo
            raise OSError("EIO")
        real(src, dst, **kw)

    monkeypatch.setattr(trash, "_move", flaky)
    with Session(init_db["engine"]) as session, pytest.raises(trash.TrashError):
        trash.trash_video(session, session.get(Video, video.id), None)

    assert _survives(init_db, init_db["downloads"] / video.file_path)
    assert _survives(init_db, sub)


def test_files_are_moved_without_holding_the_database_write_lock(
    init_db, add_video, monkeypatch
):
    video = add_video(write_file=True)
    real = trash._move
    outcomes: list[str] = []

    def spy(src, dst, **kw):
        probe = sqlite3.connect(init_db["db_path"], timeout=0)
        try:
            probe.execute("BEGIN IMMEDIATE")
            outcomes.append("free")
            probe.rollback()
        except sqlite3.OperationalError as exc:
            outcomes.append(str(exc))
        finally:
            probe.close()
        real(src, dst, **kw)

    monkeypatch.setattr(trash, "_move", spy)
    with Session(init_db["engine"]) as session:
        trash.trash_video(session, session.get(Video, video.id), None)
    assert outcomes and set(outcomes) == {"free"}


def test_a_media_folder_on_another_filesystem_is_refused_not_copied(
    client, init_db, add_video, monkeypatch
):
    video = add_video(write_file=True, file_bytes=b"M" * 100)
    real = os.rename

    def cross_device(src, dst, *a, **kw):
        if str(init_db["downloads"]) in str(src):
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return real(src, dst, *a, **kw)

    monkeypatch.setattr(os, "rename", cross_device)

    resp = client.delete(f"/api/videos/{video.id}?delete_file=true")

    assert resp.status_code == 409
    assert resp.json()["code"] == "trash_cross_device"
    assert (init_db["downloads"] / video.file_path).read_bytes() == b"M" * 100
    assert client.get(f"/api/videos/{video.id}").status_code == 200
    assert client.get("/api/trash/summary").json()["count"] == 0
    assert _trash_folders(init_db) == []


def test_deleting_twice_does_not_make_an_empty_second_entry(init_db, add_video):
    video = add_video(write_file=False)  # no files: the moves cannot fail
    with Session(init_db["engine"]) as first, Session(init_db["engine"]) as second:
        stale = second.get(Video, video.id)  # both requests loaded the row
        trash.trash_video(first, first.get(Video, video.id), None)
        with pytest.raises(trash.TrashError):
            trash.trash_video(second, stale, None)
    with Session(init_db["engine"]) as session:
        assert len(session.exec(select(TrashEntry)).all()) == 1


def test_restoring_an_entry_that_is_already_gone_changes_nothing(
    client, init_db, add_video, monkeypatch
):
    video = add_video(write_file=True, file_bytes=b"M" * 100)
    entry_id = int(
        client.delete(f"/api/videos/{video.id}?delete_file=true").headers[ENTRY_HEADER]
    )
    real = trash._check_restorable

    def other_request_restored_it_first(session, entry, moves):
        real(session, entry, moves)
        with Session(init_db["engine"]) as other:
            other.delete(other.get(TrashEntry, entry_id))
            other.commit()

    monkeypatch.setattr(trash, "_check_restorable", other_request_restored_it_first)

    resp = client.post(f"/api/trash/{entry_id}/restore")

    assert resp.status_code == 404
    with Session(init_db["engine"]) as session:
        assert session.get(Video, video.id) is None

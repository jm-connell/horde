"""delete_video_cascade: dependents, derived files, containment, commit ordering."""

from __future__ import annotations

import json

import pytest
from sqlmodel import Session, select

from app.models import (
    AiJob,
    AiJobKind,
    DownloadJob,
    JobStatus,
    OpenRouterUsage,
    Playlist,
    PlaylistItem,
    Video,
    VideoAiChatMessage,
    VideoAiMeta,
    VideoEmbedding,
)
from app.services.video_delete import delete_video_cascade


def _populate(init_db, add_video, *, write_file=True):
    """A video with a row in every dependent table and every derived file."""
    downloads, data, engine = init_db["downloads"], init_db["data"], init_db["engine"]
    video = add_video(write_file=write_file, yt_id="delvid00001")
    other = add_video(write_file=True, yt_id="keepvid0001")
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
    for path in files.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    with Session(engine) as session:
        row = session.get(Video, video.id)
        row.thumbnail_path = str(files["thumb_full"])
        row.compat_path = "compat/side.mp4"
        row.subtitles = json.dumps([{"lang": "en", "path": "subs/en.vtt"}])
        playlist = Playlist(name="p", cover_video_id=video.id)
        session.add_all([row, playlist])
        session.commit()
        session.add_all(
            [
                PlaylistItem(playlist_id=playlist.id, video_id=video.id),
                PlaylistItem(playlist_id=playlist.id, video_id=other.id, position=1),
                VideoEmbedding(video_id=video.id, vector=b"x"),
                VideoAiMeta(video_id=video.id),
                VideoAiChatMessage(video_id=video.id, content="hi"),
                AiJob(kind=AiJobKind.embed_video, video_id=video.id),
                OpenRouterUsage(cost=0.1, video_id=video.id),
                DownloadJob(url="u", status=JobStatus.completed, video_id=video.id),
            ]
        )
        session.commit()
        playlist_id = playlist.id
    return video.id, other.id, playlist_id, files


def _counts(engine, video_id):
    with Session(engine) as session:
        return {
            model.__name__: len(
                session.exec(
                    select(model).where(model.video_id == video_id)  # type: ignore[attr-defined]
                ).all()
            )
            for model in (
                PlaylistItem,
                VideoEmbedding,
                VideoAiMeta,
                VideoAiChatMessage,
                AiJob,
                OpenRouterUsage,
                DownloadJob,
            )
        }


def test_delete_endpoint_removes_dependents_and_derived_files(
    client, init_db, add_video
):
    video_id, other_id, playlist_id, files = _populate(init_db, add_video)
    media = init_db["downloads"] / "Alpha" / "2024" / "Video 1 [delvid00001].mp4"
    assert media.exists()

    assert client.delete(f"/api/videos/{video_id}").status_code == 204

    assert client.get(f"/api/videos/{video_id}").status_code == 404
    assert media.exists(), "media is kept unless delete_file is set"
    assert not any(path.exists() for path in files.values())
    counts = _counts(init_db["engine"], video_id)
    assert counts["DownloadJob"] == 0  # video_id nulled on the job row
    assert not any(v for k, v in counts.items() if k != "OpenRouterUsage"), counts
    with Session(init_db["engine"]) as session:
        assert session.exec(select(DownloadJob)).one().video_id is None
        assert session.exec(select(OpenRouterUsage)).one().video_id is None
        assert session.get(Playlist, playlist_id).cover_video_id is None
        # The other video's membership is untouched.
        assert len(session.exec(select(PlaylistItem)).all()) == 1


def test_delete_with_file_flag_removes_media(client, init_db, add_video):
    video_id, _, _, _ = _populate(init_db, add_video)
    media = init_db["downloads"] / "Alpha" / "2024" / "Video 1 [delvid00001].mp4"
    assert client.delete(f"/api/videos/{video_id}?delete_file=true").status_code == 204
    assert not media.exists()


def test_bulk_delete_is_one_commit_then_files(client, init_db, add_video):
    first, other, _, files = _populate(init_db, add_video)
    kept = init_db["downloads"] / "Alpha" / "2024" / "Video 2 [keepvid0001].mp4"
    body = {"video_ids": [first, other, 4242], "delete_files": True}
    assert client.post("/api/videos/bulk-delete", json=body).status_code == 204
    assert not kept.exists()
    assert not any(path.exists() for path in files.values())
    with Session(init_db["engine"]) as session:
        assert session.exec(select(Video)).all() == []


def test_files_survive_a_failed_commit(init_db, add_video):
    video_id, _, _, files = _populate(init_db, add_video)
    with Session(init_db["engine"]) as session:
        video = session.get(Video, video_id)
        media = init_db["downloads"] / video.file_path

        def failing_commit():
            raise RuntimeError("disk full")

        session.commit = failing_commit  # type: ignore[method-assign]
        with pytest.raises(RuntimeError):
            delete_video_cascade(session, video, True)
        session.rollback()
    assert all(path.exists() for path in files.values())
    assert media.exists()
    with Session(init_db["engine"]) as session:
        assert session.get(Video, video_id) is not None


def test_never_deletes_outside_the_library(client, init_db, add_video, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    precious_thumb = outside / "thumb.jpg"
    precious_sub = outside / "sub.vtt"
    precious_media = outside / "media.mp4"
    for path in (precious_thumb, precious_sub, precious_media):
        path.write_bytes(b"precious")
    video = add_video(
        write_file=True,
        thumbnail_path=str(precious_thumb),
        subtitles=json.dumps(
            [
                {"lang": "en", "path": str(precious_sub)},
                {"lang": "de", "path": "../../outside/sub.vtt"},
            ]
        ),
        compat_path="../../outside/media.mp4",
        file_path="../../outside/media.mp4",
    )
    link = init_db["downloads"] / "escape.mp4"
    link.symlink_to(precious_media)

    assert client.delete(f"/api/videos/{video.id}?delete_file=true").status_code == 204

    for path in (precious_thumb, precious_sub, precious_media):
        assert path.read_bytes() == b"precious", path
    assert link.is_symlink()


def test_orphan_cleanup_uses_the_cascade(init_db, add_video):
    from app.services.scanner import cleanup_orphans

    ghost = add_video(needs_review=True)  # row exists, file does not
    with Session(init_db["engine"]) as session:
        session.add(VideoAiMeta(video_id=ghost.id))
        session.commit()
    assert cleanup_orphans() == 1
    with Session(init_db["engine"]) as session:
        assert session.exec(select(Video)).all() == []
        assert session.exec(select(VideoAiMeta)).all() == []

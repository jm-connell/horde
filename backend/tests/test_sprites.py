"""Seek-preview worker must not fail when the video row changes mid-ffmpeg."""

from __future__ import annotations

import shutil
import subprocess
import time

import pytest
from sqlmodel import Session

from app.models import Video
from app.services import activity, metadata
from app.services.sprites import enqueue_sprite_generation, sprites_in_progress


def _wait_sprite_worker(video_id: int, timeout: float = 3.0) -> None:
    deadline = time.time() + timeout
    while sprites_in_progress(video_id) and time.time() < deadline:
        time.sleep(0.01)
    assert not sprites_in_progress(video_id)


def _failed_sprite_tasks(video_id: int) -> list[dict]:
    return [
        t
        for t in activity.snapshot()["recent"]
        if t.get("kind") == "sprites"
        and t.get("video_id") == video_id
        and t.get("status") == "failed"
    ]


def test_sprite_generation_writes_path_after_concurrent_update(
    add_video, session, monkeypatch, init_db
):
    video = add_video(write_file=True)
    vid = video.id
    sprite_path = str(init_db["data"] / "sprites" / f"{vid}.jpg")

    def fake_generate(*_a, **_k) -> str:
        with Session(init_db["engine"]) as other:
            row = other.get(Video, vid)
            assert row is not None
            row.last_position_sec = 42.0
            other.add(row)
            other.commit()
        return sprite_path

    monkeypatch.setattr("app.services.sprites.generate_sprite_sheet", fake_generate)
    monkeypatch.setattr("app.services.sprites.sprites_exist", lambda *_a, **_k: False)

    # Earlier tests (scanner ingest) can leave a daemon sprite worker for the
    # same video id behind; let it drain so this enqueue is not a no-op.
    _wait_sprite_worker(vid)
    enqueue_sprite_generation(vid)
    _wait_sprite_worker(vid)

    session.expire_all()
    row = session.get(Video, vid)
    assert row is not None
    assert row.sprite_path == sprite_path
    assert row.last_position_sec == 42.0
    assert _failed_sprite_tasks(vid) == []


def test_sprite_generation_tolerates_deleted_video(
    add_video, session, monkeypatch, init_db
):
    video = add_video(write_file=True)
    vid = video.id
    sprite_path = str(init_db["data"] / "sprites" / f"{vid}.jpg")

    def fake_generate(*_a, **_k) -> str:
        with Session(init_db["engine"]) as other:
            row = other.get(Video, vid)
            assert row is not None
            other.delete(row)
            other.commit()
        return sprite_path

    monkeypatch.setattr("app.services.sprites.generate_sprite_sheet", fake_generate)
    monkeypatch.setattr("app.services.sprites.sprites_exist", lambda *_a, **_k: False)

    enqueue_sprite_generation(vid)
    _wait_sprite_worker(vid)

    session.expire_all()
    assert session.get(Video, vid) is None
    assert _failed_sprite_tasks(vid) == []


def test_sprite_sheet_is_revalidated_so_a_rebuilt_sheet_shows(client, add_video):
    """The sheet's URL never changes: without no-cache a browser keeps an old one."""
    from app.context import get_paths
    from app.services.metadata import sprite_image_path

    video = add_video()
    path = sprite_image_path(get_paths().sprites, video.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xd8sheet")

    resp = client.get(f"/api/videos/{video.id}/sprites")

    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-cache"


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_an_audio_only_file_gets_no_sprite_sheet_and_no_ffmpeg_runs(
    tmp_path, monkeypatch
):
    """Every frame grab would fail: an audio download must not run the
    per-frame fallback each time its watch page asks for sprites."""
    # A podcast MP3's cover art survives the Safari remux as a still "video".
    cover = tmp_path / "cover.jpg"
    ffmpeg = ["ffmpeg", "-loglevel", "error", "-y"]
    subprocess.run(
        [*ffmpeg, "-f", "lavfi", "-i", "color=red:s=64x64:d=1", "-frames:v", "1"]
        + [str(cover)],
        check=True,
        capture_output=True,
    )
    audio = tmp_path / "Song [song00001].mp4"
    subprocess.run(
        [*ffmpeg, "-f", "lavfi", "-i", "sine=d=30", "-i", str(cover)]
        + ["-map", "0", "-map", "1", "-c:a", "aac", "-c:v", "mjpeg"]
        + ["-disposition:v", "attached_pic", str(audio)],
        check=True,
        capture_output=True,
    )
    ran: list[str] = []
    for name in ("_sprite_via_ffmpeg_tile", "_sprite_via_frame_montage"):
        monkeypatch.setattr(
            metadata, name, lambda *_a, _n=name, **_k: ran.append(_n) or False
        )

    assert metadata.generate_sprite_sheet(audio, tmp_path / "sprites", 1) is None
    assert ran == []

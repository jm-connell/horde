"""Background ffmpeg (sprites, scanner thumbnails) runs below playback priority."""

import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services import ffmpeg_bin, metadata
from app.services.ffmpeg_progress import run_ffmpeg


def _record_run_ffmpeg(monkeypatch, target: str) -> list[dict]:
    calls: list[dict] = []

    def fake(cmd, **kwargs):
        calls.append({"cmd": cmd, **kwargs})
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    monkeypatch.setattr(target, fake)
    return calls


@pytest.mark.skipif(shutil.which("nice") is None, reason="needs nice")
def test_low_priority_wraps_after_the_progress_args():
    # The progress args go right after the ffmpeg binary, so nice must be
    # prefixed after them or they would be handed to nice instead.
    low = run_ffmpeg(["true"], low_priority=True).args
    assert low[:4] == ["nice", "-n", "15", "true"]
    assert low[4:7] == ["-nostats", "-progress", "pipe:1"]

    normal = run_ffmpeg(["true"]).args
    assert normal[0] == "true"
    assert "nice" not in normal


def test_below_playback_without_nice_runs_the_command_as_is(monkeypatch):
    monkeypatch.setattr(ffmpeg_bin.shutil, "which", lambda _name: None)
    assert ffmpeg_bin.below_playback(["ffmpeg", "-i", "x"]) == ["ffmpeg", "-i", "x"]


def test_below_playback_off_posix_runs_the_command_as_is(monkeypatch):
    # Patch the module's os, not os.name itself: Path() reads os.name.
    monkeypatch.setattr(ffmpeg_bin, "os", SimpleNamespace(name="nt"))
    assert ffmpeg_bin.below_playback(["ffmpeg", "-i", "x"]) == ["ffmpeg", "-i", "x"]


def test_sprite_and_background_thumbnail_ffmpeg_are_low_priority(monkeypatch, tmp_path):
    calls = _record_run_ffmpeg(monkeypatch, "app.services.metadata.run_ffmpeg")
    video = tmp_path / "v.mp4"

    metadata._sprite_via_ffmpeg_tile(
        video, tmp_path / "s.jpg", interval=5, columns=10, rows=1
    )
    metadata._sprite_via_frame_montage(
        video,
        tmp_path / "s2.jpg",
        tmp_path,
        1,
        interval=5,
        count=1,
        columns=10,
        rows=1,
    )
    metadata.grab_frame(video, tmp_path / "t.jpg", low_priority=True)

    assert len(calls) == 3
    assert all(c["low_priority"] is True for c in calls)


def test_thumbnail_candidates_stay_at_normal_priority(monkeypatch, tmp_path):
    # The admin is waiting on the thumbnail picker, so it must not be niced.
    calls = _record_run_ffmpeg(monkeypatch, "app.services.metadata.run_ffmpeg")
    metadata.generate_thumbnail_candidates(
        tmp_path / "v.mp4", tmp_path, 1, count=2, duration=10.0
    )
    assert calls
    assert all(c["low_priority"] is False for c in calls)


def test_scanner_thumbnail_is_low_priority(init_db, monkeypatch):
    from sqlmodel import Session

    from app.services import scanner

    path = Path(init_db["downloads"]) / "Library" / "clip.mp4"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\0" * 2048)
    grabs: list[dict] = []
    monkeypatch.setattr(
        scanner, "grab_frame", lambda *_a, **k: grabs.append(k) or False
    )
    monkeypatch.setattr(scanner, "probe_is_playable", lambda _p: True)
    monkeypatch.setattr(scanner, "probe_dimensions", lambda _p: (640, 360))
    monkeypatch.setattr(scanner, "probe_duration", lambda _p: 10.0)
    monkeypatch.setattr(scanner, "probe_frame_rate", lambda _p: 30.0)
    monkeypatch.setattr("app.services.media_info.probe_stream_info", lambda _p: None)
    monkeypatch.setattr(
        "app.services.sprites.enqueue_sprite_generation", lambda *a, **k: None
    )
    with Session(init_db["engine"]) as s:
        assert scanner.ingest_media_file(s, path, require_stable=False) is not None
    assert [g.get("low_priority") for g in grabs] == [True]


def test_download_postprocess_ffmpeg_is_not_low_priority(init_db, monkeypatch):
    from app.services.downloads import postprocess

    calls = _record_run_ffmpeg(
        monkeypatch, "app.services.downloads.postprocess.run_ffmpeg"
    )
    monkeypatch.setattr(postprocess, "ffmpeg_available", lambda: True)
    path = Path(init_db["downloads"]) / "clip.mp4"
    path.write_bytes(b"\0")

    postprocess.apply_loudnorm(path)

    assert len(calls) == 1
    assert not calls[0].get("low_priority")

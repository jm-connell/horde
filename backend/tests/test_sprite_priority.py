"""Sprite ffmpeg should yield CPU to an in-progress watch."""

from __future__ import annotations

from pathlib import Path

from app.services.ffmpeg_bin import below_playback
from app.services.metadata import _sprite_via_ffmpeg_tile


def test_below_playback_nices_on_posix(monkeypatch):
    monkeypatch.setattr("app.services.ffmpeg_bin.os.name", "posix")
    monkeypatch.setattr("app.services.ffmpeg_bin.shutil.which", lambda _name: "/usr/bin/nice")
    cmd = below_playback(["ffmpeg", "-i", "in.mp4"])
    assert cmd[:3] == ["nice", "-n", "15"]
    assert cmd[3:] == ["ffmpeg", "-i", "in.mp4"]


def test_below_playback_skips_when_nice_missing(monkeypatch):
    monkeypatch.setattr("app.services.ffmpeg_bin.os.name", "posix")
    monkeypatch.setattr("app.services.ffmpeg_bin.shutil.which", lambda _name: None)
    cmd = ["ffmpeg", "-i", "in.mp4"]
    assert below_playback(cmd) == cmd


def test_below_playback_noop_off_posix(monkeypatch):
    monkeypatch.setattr("app.services.ffmpeg_bin.os.name", "nt")
    cmd = ["ffmpeg", "-i", "in.mp4"]
    assert below_playback(cmd) == cmd


def test_sprite_tile_decode_stays_below_playback(monkeypatch, tmp_path: Path):
    captured: dict[str, list[str]] = {}

    def fake_run(cmd, **_kwargs):
        captured["cmd"] = list(cmd)
        Path(cmd[-1]).write_bytes(b"jpg")

        class Result:
            returncode = 0

        return Result()

    monkeypatch.setattr("app.services.metadata.subprocess.run", fake_run)
    image = tmp_path / "sheet.jpg"
    ok = _sprite_via_ffmpeg_tile(
        tmp_path / "video.mp4",
        image,
        interval=5,
        columns=10,
        rows=2,
    )
    assert ok
    cmd = captured["cmd"]
    assert cmd[0] == "nice" or cmd[0].endswith("/nice")
    assert cmd[1:3] == ["-n", "15"]
    threads = cmd.index("-threads")
    assert cmd[threads + 1] == "1"

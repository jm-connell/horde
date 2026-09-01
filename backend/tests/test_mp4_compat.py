"""AV1-preserving MP4 remux: AAC audio + faststart, never transcode video."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.services.mp4_compat import (
    CompatPlan,
    MediaProbe,
    apple_webkit_playback,
    codec_family,
    compat_plan,
    ensure_safari_mp4,
    ffmpeg_compat_cmd,
    is_aac_audio,
    mp4_moov_before_mdat,
    mp4_video_tag,
    probe_media,
)


def test_codec_family_and_aac():
    assert codec_family("av01.0.08M.08") == "av01"
    assert codec_family("av1") == "av1"
    assert codec_family("opus") == "opus"
    assert codec_family("mp4a.40.2") == "mp4a"
    assert codec_family(None) == ""
    assert is_aac_audio("aac")
    assert is_aac_audio("mp4a.40.2")
    assert not is_aac_audio("opus")
    assert not is_aac_audio("vorbis")


def test_mp4_video_tags_for_safari():
    assert mp4_video_tag("av1") == "av01"
    assert mp4_video_tag("av01.0.08M.08") == "av01"
    assert mp4_video_tag("hevc") == "hvc1"
    assert mp4_video_tag("h264") is None


def test_apple_webkit_playback_ua():
    iphone = (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
        "Mobile/15E148 Safari/604.1"
    )
    brave_ios = (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
        "Mobile/15E148 Safari/604.1"
    )
    desktop_chrome = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    )
    desktop_safari = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    )
    assert apple_webkit_playback(iphone)
    assert apple_webkit_playback(brave_ios)
    assert apple_webkit_playback(desktop_safari)
    assert not apple_webkit_playback(desktop_chrome)
    assert not apple_webkit_playback("")


def _make_atom(tag: bytes, payload: bytes) -> bytes:
    size = 8 + len(payload)
    return size.to_bytes(4, "big") + tag + payload


def test_moov_before_mdat(tmp_path: Path):
    ftyp = _make_atom(b"ftyp", b"isom")
    moov = _make_atom(b"moov", b"\x00" * 16)
    mdat = _make_atom(b"mdat", b"\x00" * 32)
    front = tmp_path / "faststart.mp4"
    front.write_bytes(ftyp + moov + mdat)
    assert mp4_moov_before_mdat(front) is True
    back = tmp_path / "slowstart.mp4"
    back.write_bytes(ftyp + mdat + moov)
    assert mp4_moov_before_mdat(back) is False


def test_compat_plan_av1_opus_needs_aac_and_faststart():
    probe = MediaProbe(
        video_codec="av1",
        audio_codec="opus",
        format_name="mov,mp4,m4a,3gp,3g2,mj2",
        moov_front=False,
    )
    plan = compat_plan(probe)
    assert plan == CompatPlan(transcode_audio=True, faststart=True)
    assert plan.needed


def test_compat_plan_already_aac_faststart_is_noop():
    probe = MediaProbe(
        video_codec="av1",
        audio_codec="aac",
        format_name="mov,mp4,m4a,3gp,3g2,mj2",
        moov_front=True,
    )
    plan = compat_plan(probe)
    assert not plan.needed
    assert plan.transcode_audio is False


def test_compat_plan_empty_probe_is_noop():
    probe = MediaProbe(
        video_codec=None,
        audio_codec=None,
        format_name="",
        moov_front=None,
    )
    assert not compat_plan(probe).needed


def test_compat_plan_webm_remuxes_to_mp4():
    probe = MediaProbe(
        video_codec="av1",
        audio_codec="opus",
        format_name="matroska,webm",
        moov_front=None,
    )
    plan = compat_plan(probe)
    assert plan.remux_to_mp4
    assert plan.transcode_audio
    assert plan.faststart


def test_ffmpeg_cmd_copies_video_never_libx264():
    src = Path("in.mp4")
    dest = Path("out.mp4")
    cmd = ffmpeg_compat_cmd(
        src,
        dest,
        transcode_audio=True,
        has_video=True,
        has_audio=True,
        video_codec="av1",
    )
    assert cmd[:4] == ["ffmpeg", "-y", "-i", "in.mp4"]
    assert "-c:v" in cmd and cmd[cmd.index("-c:v") + 1] == "copy"
    assert "libx264" not in cmd
    assert "libsvtav1" not in cmd
    assert "libaom-av1" not in cmd
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert cmd[cmd.index("-tag:v") + 1] == "av01"
    assert "+faststart" in cmd

    copy_audio = ffmpeg_compat_cmd(
        src, dest, transcode_audio=False, has_video=True, has_audio=True
    )
    assert copy_audio[copy_audio.index("-c:a") + 1] == "copy"
    assert copy_audio[copy_audio.index("-c:v") + 1] == "copy"


def _have_ffmpeg_tools() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


@pytest.mark.skipif(not _have_ffmpeg_tools(), reason="ffmpeg/ffprobe not installed")
def test_ensure_safari_mp4_keeps_av1_rewrites_opus(tmp_path: Path):
    src = tmp_path / "clip.mp4"
    # Tiny AV1 + Opus MP4 — the combo desktop Chrome plays and iPhone Safari rejects.
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=d=0.4:s=64x64:r=10",
            "-f",
            "lavfi",
            "-i",
            "sine=d=0.4",
            "-c:v",
            "libaom-av1",
            "-cpu-used",
            "8",
            "-crf",
            "50",
            "-b:v",
            "0",
            "-c:a",
            "libopus",
            "-strict",
            "unofficial",
            "-f",
            "mp4",
            str(src),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        pytest.skip(f"could not encode AV1+Opus test clip: {result.stderr[-400:]}")

    before = probe_media(src)
    assert before is not None
    assert codec_family(before.video_codec) in {"av1", "av01"}
    assert codec_family(before.audio_codec) == "opus"

    out = ensure_safari_mp4(src)
    assert out.exists()
    after = probe_media(out)
    assert after is not None
    assert codec_family(after.video_codec) in {"av1", "av01"}
    assert is_aac_audio(after.audio_codec)
    assert after.moov_front is True
    # Same archive, not an H.264 re-encode.
    assert out.stat().st_size > 0
    assert ensure_safari_mp4(out) == out

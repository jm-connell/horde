"""Compatibility transcode planner and ffmpeg command builder."""

from pathlib import Path

from app.services.encode_probe import EncoderChoice
from app.services.video_transcode import encode_target, ffmpeg_transcode_cmd


def test_encode_target_av1_never_encodes():
    assert encode_target("av1", "av1", 2160) is None
    assert encode_target("av1", "h264", 1080) is None


def test_encode_target_h264_skips_when_already_avc():
    assert encode_target("h264", "h264", 1080) is None
    assert encode_target("h264", "avc1", 720) is None
    assert encode_target("h264", "av1", 1080) == "h264"
    assert encode_target("h264", "av1", 2160) == "h264"


def test_encode_target_h265_skips_1080p_h264():
    assert encode_target("h265", "h264", 1080) is None
    assert encode_target("hevc", "hvc1", 2160) is None
    assert encode_target("h265", "av1", 1080) == "h264"
    assert encode_target("h265", "av1", 2160) == "h265"
    assert encode_target("h265", "vp9", 1440) == "h265"


def test_encode_target_audio_preset_skipped():
    assert encode_target("h264", "av1", 2160, preset="audio") is None


def test_ffmpeg_transcode_cmd_nvenc_hevc_no_libx264():
    cmd = ffmpeg_transcode_cmd(
        Path("in.mp4"),
        Path("out.mp4"),
        EncoderChoice(name="hevc_nvenc", kind="nvenc", hw=True),
        has_audio=True,
        transcode_audio=True,
    )
    joined = " ".join(cmd)
    assert "hevc_nvenc" in cmd
    assert "libx264" not in cmd
    assert "libx265" not in cmd
    assert "-tag:v" in cmd
    assert "hvc1" in cmd
    assert "-preset" in cmd
    assert "p6" in cmd
    assert "+faststart" in joined
    assert "aac" in cmd


def test_ffmpeg_transcode_cmd_software_h264():
    cmd = ffmpeg_transcode_cmd(
        Path("in.mp4"),
        Path("out.mp4"),
        EncoderChoice(name="libx264", kind="software", hw=False),
        has_audio=False,
        transcode_audio=False,
    )
    assert "libx264" in cmd
    assert "-an" in cmd
    assert "hvc1" not in cmd

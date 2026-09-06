"""ffmpeg encoder inventory parsing and picker (no live ffmpeg required)."""

from app.services.encode_probe import (
    encoder_usable,
    parse_ffmpeg_encoders,
    parse_ffmpeg_hwaccels,
    pick_encoder,
)


_ENCODERS_SAMPLE = """
Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC
 V....D libx265              libx265 H.265 / HEVC
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder
 V....D hevc_nvenc           NVIDIA NVENC H.265 encoder
 V..... hevc_vaapi           VAAPI
"""


def test_parse_ffmpeg_encoders():
    found = parse_ffmpeg_encoders(_ENCODERS_SAMPLE)
    assert "libx264" in found
    assert "libx265" in found
    assert "h264_nvenc" in found
    assert "hevc_nvenc" in found
    assert "hevc_vaapi" in found


def test_parse_hwaccels():
    text = "Hardware acceleration methods:\ncuda\nvaapi\n"
    assert "cuda" in parse_ffmpeg_hwaccels(text)
    assert "vaapi" in parse_ffmpeg_hwaccels(text)


def test_pick_encoder_prefers_nvenc_when_device_present():
    encoders = frozenset({"hevc_nvenc", "libx265", "libx264"})
    choice = pick_encoder("h265", encoders, nvidia=True, dri=False)
    assert choice is not None
    assert choice.name == "hevc_nvenc"
    assert choice.hw is True


def test_pick_encoder_skips_nvenc_without_device():
    encoders = frozenset({"hevc_nvenc", "libx265"})
    choice = pick_encoder("h265", encoders, nvidia=False, dri=False)
    assert choice is not None
    assert choice.name == "libx265"
    assert choice.hw is False


def test_encoder_usable_videotoolbox_only_on_darwin(monkeypatch):
    import app.services.encode_probe as probe

    monkeypatch.setattr(probe.sys, "platform", "linux")
    assert encoder_usable("hevc_videotoolbox", nvidia=False, dri=False) is False
    monkeypatch.setattr(probe.sys, "platform", "darwin")
    assert encoder_usable("hevc_videotoolbox", nvidia=False, dri=False) is True

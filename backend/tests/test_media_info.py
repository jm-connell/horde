"""ffprobe → codec family / RFC 6381 string / compat eligibility."""

from app.models import Video
from app.services.media_info import (
    codec_string_for,
    needs_compat,
    stream_info_from_ffprobe,
)


def _stream(**kw):
    base = {"codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "30/1"}
    return {**base, **kw}


def test_codec_string_av1_uses_reported_level():
    assert codec_string_for(_stream(codec_name="av1", profile="Main", level=8, pix_fmt="yuv420p")) == "av01.0.08M.08"


def test_codec_string_av1_estimates_level_and_depth():
    s = _stream(codec_name="av1", profile="Main", level=-99, pix_fmt="yuv420p10le", width=3840, height=2160, avg_frame_rate="60/1")
    assert codec_string_for(s) == "av01.0.13M.10"


def test_codec_string_h264_high():
    assert codec_string_for(_stream(codec_name="h264", profile="High", level=40, pix_fmt="yuv420p")) == "avc1.640028"


def test_codec_string_vp9_profile2():
    s = _stream(codec_name="vp9", profile="Profile 2", level=-99, pix_fmt="yuv420p10le", width=3840, height=2160)
    assert codec_string_for(s) == "vp09.02.50.10"


def test_codec_string_hevc_main10():
    s = _stream(codec_name="hevc", profile="Main 10", level=153, pix_fmt="yuv420p10le")
    assert codec_string_for(s) == "hvc1.2.4.L153.B0"


def test_stream_info_skips_cover_art_and_flags_hdr():
    data = {
        "streams": [
            {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}},
            _stream(codec_name="vp9", profile="Profile 2", pix_fmt="yuv420p10le", color_transfer="smpte2084"),
            {"codec_type": "audio", "codec_name": "opus"},
        ]
    }
    info = stream_info_from_ffprobe(data)
    assert info.vcodec == "vp9"
    assert info.acodec == "opus"
    assert info.bit_depth == 10
    assert info.is_hdr is True


def test_stream_info_audio_only():
    info = stream_info_from_ffprobe({"streams": [{"codec_type": "audio", "codec_name": "aac"}]})
    assert info.vcodec is None and info.acodec == "aac"


def _video(**kw):
    from app.models import utcnow

    return Video(title="t", file_path="x.mp4", media_probed_at=utcnow(), **kw)


def test_needs_compat_rules():
    assert needs_compat(_video(vcodec="av1", width_px=1920, height_px=1080))
    assert needs_compat(_video(vcodec="vp9", width_px=1280, height_px=720))
    assert not needs_compat(_video(vcodec="h264", bit_depth=8, width_px=1920, height_px=1080))
    assert needs_compat(_video(vcodec="h264", bit_depth=10, width_px=1920, height_px=1080))
    assert needs_compat(_video(vcodec="h264", bit_depth=8, width_px=3840, height_px=2160))
    # Vertical 1080×1920 H.264 is fine (short side 1080).
    assert not needs_compat(_video(vcodec="h264", bit_depth=8, width_px=1080, height_px=1920))
    # Probed audio-only never needs a video copy; unprobed is eligible.
    assert not needs_compat(_video(vcodec=None))
    assert needs_compat(Video(title="t", file_path="y.mp4"))

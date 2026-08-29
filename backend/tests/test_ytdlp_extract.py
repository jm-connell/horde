"""Preset size estimates from yt-dlp format metadata (no network)."""

from app.services.ytdlp_extract import (
    _estimate_preset_sizes,
    _format_parts_bytes,
)


def test_format_parts_bytes_sums_components_not_audio_only_approx():
    duration = 1200.0
    fmt = {
        "vcodec": "vp9",
        "acodec": "mp4a.40.2",
        "filesize_approx": 19_000_000,
        "tbr": 12128,
        "requested_formats": [
            {"vcodec": "vp9", "acodec": "none", "tbr": 12000},
            {"vcodec": "none", "acodec": "mp4a.40.2", "filesize": 19_000_000},
        ],
    }
    size = _format_parts_bytes(fmt, duration)
    assert size is not None
    # 12000 kbps * 1200s * 125 + 19 MB audio
    assert size == 12000 * 1200 * 125 + 19_000_000
    assert size > 1_000_000_000


def test_format_parts_bytes_omits_video_merge_when_video_unsized():
    fmt = {
        "requested_formats": [
            {"vcodec": "vp9", "acodec": "none"},
            {"vcodec": "none", "acodec": "mp4a.40.2", "filesize": 19_000_000},
        ],
        "filesize_approx": 19_000_000,
    }
    assert _format_parts_bytes(fmt, 1200.0) is None


def test_estimate_2160p_uses_dash_tbr_not_progressive_mux():
    duration = 1200
    info = {
        "duration": duration,
        "formats": [
            {
                "format_id": "401",
                "url": "https://example.com/v",
                "ext": "webm",
                "height": 2160,
                "width": 3840,
                "fps": 60,
                "vcodec": "vp9",
                "acodec": "none",
                "tbr": 12000,
                "vbr": 12000,
            },
            {
                "format_id": "140",
                "url": "https://example.com/a",
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "abr": 128,
                "tbr": 128,
                "filesize": 19_200_000,
            },
            {
                "format_id": "22",
                "url": "https://example.com/p",
                "ext": "mp4",
                "height": 720,
                "width": 1280,
                "fps": 30,
                "vcodec": "avc1.64001F",
                "acodec": "mp4a.40.2",
                "filesize": 300_000_000,
                "tbr": 2000,
            },
        ],
    }
    sizes = _estimate_preset_sizes(info, ["2160p", "720p"])
    assert "2160p" in sizes
    # DASH 4K from tbr, not the 300 MB progressive 720p mux.
    assert sizes["2160p"] > 1_000_000_000
    assert sizes["2160p"] != 300_000_000
    if "720p" in sizes:
        assert sizes["720p"] < sizes["2160p"]

"""Tests for download format / media helper functions (no yt-dlp)."""

from pathlib import Path

from app.services import downloader


def test_format_chain_height_capped_no_unbounded_best():
    chain = downloader._format_chain("1080p")
    assert chain
    assert all("bestvideo" in c or "best[" in c or "height" in c for c in chain)
    # Must not fall back to unrestricted best/best for capped presets.
    assert "best[ext=mp4]/best" not in chain
    assert not any(c == "best" for c in chain)


def test_format_chain_best_and_audio():
    best = downloader._format_chain("best")
    assert "best[ext=mp4]/best" in best
    audio = downloader._format_chain("audio")
    assert "bestaudio/best" in audio
    capped = downloader._format_chain("audio-128")
    assert capped[0].startswith("ba[abr<=128]")
    assert "bestaudio/best" in capped


def test_available_presets_audio_bitrate_tiers():
    info = {
        "formats": [
            {"vcodec": "avc1", "acodec": "none", "height": 1080},
            {"vcodec": "none", "acodec": "mp4a", "abr": 160},
            {"vcodec": "none", "acodec": "opus", "abr": 64},
        ]
    }
    presets = downloader._available_presets(info)
    assert "1080p" in presets
    assert "audio" in presets
    # Best is 160 → skip audio-160; keep lower caps.
    assert "audio-160" not in presets
    assert "audio-128" in presets
    assert "audio-64" in presets


def test_available_presets_audio_without_abr_metadata():
    info = {
        "formats": [
            {"vcodec": "none", "acodec": "mp4a"},
        ]
    }
    presets = downloader._available_presets(info)
    assert presets == ["audio", "audio-160", "audio-128", "audio-64"]


def test_is_intermediate_media():
    assert downloader._is_intermediate_media("video.f137.mp4")
    assert downloader._is_intermediate_media("video.part")
    assert downloader._is_intermediate_media("video.norm.mp4")
    assert downloader._is_intermediate_media("video.temp.mp4")
    assert not downloader._is_intermediate_media("video.mp4")


def test_video_stem():
    assert downloader._video_stem(Path("Title [id].f137.mp4")) == "Title [id]"
    assert downloader._video_stem(Path("Title [id].mp4")) == "Title [id]"


def test_is_recoverable_download_error():
    assert downloader._is_recoverable_download_error(
        Exception("Unable to rename file: ...")
    )
    assert downloader._is_recoverable_download_error(
        Exception("Postprocessing: Error merging formats")
    )
    assert not downloader._is_recoverable_download_error(
        Exception("HTTP Error 403")
    )


def test_strip_ansi():
    assert downloader._strip_ansi("\x1b[31mred\x1b[0m") == "red"


def test_has_audio_and_available_presets():
    info = {
        "formats": [
            {"vcodec": "avc1", "acodec": "none", "height": 1080},
            {"vcodec": "none", "acodec": "mp4a", "height": None},
            {"vcodec": "avc1", "acodec": "mp4a", "height": 720},
        ]
    }
    assert downloader._has_audio(info)
    presets = downloader._available_presets(info)
    assert "720p" in presets or "1080p" in presets or "best" in presets


def test_height_to_tier():
    assert downloader._height_to_tier(2160) >= downloader._height_to_tier(720)
    assert downloader._height_to_tier(480) > 0

"""Original-language audio picker shared by downloads and stream preview."""

from app.services.stream_preview import _pick_adaptive_formats
from app.services.ytdlp_formats import pick_original_audio_format


def _dubbed_info():
    return {
        "language": "en",
        "original_language": "en",
        "formats": [
            {
                "format_id": "140",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "ext": "m4a",
                "abr": 128,
                "language": "en",
                "format_note": "original",
                "url": "https://cdn.example/en.m4a",
            },
            {
                "format_id": "249",
                "vcodec": "none",
                "acodec": "opus",
                "ext": "webm",
                "abr": 64,
                "language": "en",
                "url": "https://cdn.example/en.opus",
            },
            {
                "format_id": "140-pt",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "ext": "m4a",
                "abr": 192,
                "language": "pt",
                "format_note": "dubbed",
                "url": "https://cdn.example/pt.m4a",
            },
            {
                "format_id": "394",
                "vcodec": "av01",
                "acodec": "none",
                "ext": "mp4",
                "height": 1080,
                "url": "https://cdn.example/video.mp4",
            },
        ],
    }


def test_pick_original_audio_prefers_english_over_fatter_dub():
    picked = pick_original_audio_format(_dubbed_info())
    assert picked is not None
    assert picked["format_id"] == "140"


def test_stream_preview_and_download_picker_match():
    info = _dubbed_info()
    download = pick_original_audio_format(info)
    preview = pick_original_audio_format(info, require_mp4=True)
    _, audios = _pick_adaptive_formats(info)
    assert download["format_id"] == "140"
    assert preview["format_id"] == "140"
    assert audios[0]["format_id"] == "140"

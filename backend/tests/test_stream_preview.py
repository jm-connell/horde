"""Tests for in-app stream preview helpers (no YouTube)."""

from app.services import stream_preview


def test_resolve_preview_stream_force_bypasses_cache(monkeypatch):
    calls = {"n": 0}

    def fake_extract(url, *, force=False):
        calls["n"] += 1
        return {
            "formats": [
                {
                    "url": f"https://cdn.example/{calls['n']}.mp4",
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                    "height": 720,
                    "ext": "mp4",
                    "tbr": 1000,
                    "http_headers": {"User-Agent": "test"},
                }
            ]
        }

    monkeypatch.setattr(stream_preview, "_extract_preview_info", fake_extract)
    stream_preview._preview_stream_cache.clear()
    url = "https://youtu.be/preview-cache-test"
    first = stream_preview.resolve_preview_stream(url)
    second = stream_preview.resolve_preview_stream(url)
    assert first["direct_url"] == second["direct_url"]
    assert calls["n"] == 1
    third = stream_preview.resolve_preview_stream(url, force=True)
    assert calls["n"] == 2
    assert third["direct_url"] != first["direct_url"]

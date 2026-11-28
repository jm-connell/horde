"""The extra yt-dlp lookup that finds a live broadcast's 1440p and 2160p formats."""

from __future__ import annotations

from typing import Any

from app.services.live import extract
from app.services.ytdlp_common import js_runtimes_option

URL = "https://www.youtube.com/watch?v=abcdefghijk"


def test_js_runtime_setting_uses_yt_dlps_syntax():
    assert js_runtimes_option("deno:/opt/deno/deno") == {
        "deno": {"path": "/opt/deno/deno"}
    }
    assert js_runtimes_option("node") == {"node": {}}
    assert js_runtimes_option(" ") is None


def test_tall_formats_need_a_js_runtime(monkeypatch):
    monkeypatch.setattr(extract, "YTDLP_JS_RUNTIME", "")

    def boom(*a: Any, **k: Any) -> dict[str, Any]:
        raise AssertionError("yt-dlp must not run")

    monkeypatch.setattr(extract, "extract_info_gated", boom)
    assert extract.extract_tall_formats(URL) == []


def test_tall_formats_are_a_tv_client_extract_of_its_own(monkeypatch):
    monkeypatch.setattr(extract, "YTDLP_JS_RUNTIME", "deno:/opt/deno/deno")
    seen: dict[str, Any] = {}

    def gated(url: str, opts: dict[str, Any], **kw: Any) -> dict[str, Any]:
        seen.update(url=url, opts=opts, **kw)
        return {
            "is_live": True,
            "formats": [
                {"format_id": "315", "protocol": "https", "vcodec": "vp9"},
                {"format_id": "140", "protocol": "https", "vcodec": "none"},
                {"format_id": "96", "protocol": "m3u8_native", "vcodec": "avc1"},
                {"format_id": "sb0", "protocol": "mhtml", "vcodec": "none"},
            ],
        }

    monkeypatch.setattr(extract, "extract_info_gated", gated)
    formats = extract.extract_tall_formats(URL, force=True)
    assert [f["format_id"] for f in formats] == ["315"]
    opts = seen["opts"]
    assert opts["js_runtimes"] == {"deno": {"path": "/opt/deno/deno"}}
    assert opts["extractor_args"]["youtube"] == {
        "player_client": ["tv_samsung"],
        "formats": ["incomplete"],
    }
    # Its own cache entry: the preview cache keeps the JS-less answer.
    assert seen["cache_key"] != URL and seen["force"] is True


def test_a_failed_lookup_only_loses_the_tall_formats(monkeypatch, caplog):
    monkeypatch.setattr(extract, "YTDLP_JS_RUNTIME", "deno")

    def gated(*a: Any, **k: Any) -> dict[str, Any]:
        raise RuntimeError("challenge solving failed")

    monkeypatch.setattr(extract, "extract_info_gated", gated)
    with caplog.at_level("WARNING"):
        assert extract.extract_tall_formats(URL) == []
    assert "challenge solving failed" in caplog.text


def test_an_ended_broadcast_has_no_tall_formats(monkeypatch):
    monkeypatch.setattr(extract, "YTDLP_JS_RUNTIME", "deno")
    monkeypatch.setattr(
        extract,
        "extract_info_gated",
        lambda *a, **k: {
            "is_live": False,
            "formats": [{"format_id": "315", "protocol": "https", "vcodec": "vp9"}],
        },
    )
    assert extract.extract_tall_formats(URL) == []

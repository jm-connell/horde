"""Videos only YouTube's JS clients open (made-for-kids) get one retry with Deno."""

import sys
import types

import pytest

from app.services import ytdlp_common as yc

KIDS = "https://www.youtube.com/watch?v=kidsvideo01"
NOT_AVAILABLE = "ERROR: [youtube] kidsvideo01: This video is not available"


class DummyYDL:
    def __init__(self, opts):
        self.opts = dict(opts)
        DummyYDL.calls.append(self.opts)
        # Like yt-dlp, which writes its defaults into the dict it is given.
        opts.setdefault("js_runtimes", {"deno": {}})

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def extract_info(self, url, download=False):
        return DummyYDL.handler(self.opts, url)


@pytest.fixture
def dummy_ydl(monkeypatch):
    DummyYDL.calls = []
    monkeypatch.setitem(
        sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=DummyYDL)
    )
    monkeypatch.setattr(yc, "ensure_plugins_loaded", lambda: None)
    monkeypatch.setattr(yc, "_EXTRACT_MIN_INTERVAL_SEC", 0)
    monkeypatch.setattr(yc, "YTDLP_JS_RUNTIME", "deno:/opt/deno/deno")
    yc._info_cache.clear()
    yc._last_extract_at = 0.0
    yield DummyYDL
    yc._info_cache.clear()


def _kids_handler(opts, url):
    youtube = (opts.get("extractor_args") or {}).get("youtube") or {}
    if youtube.get("player_client") == ["tv_samsung"]:
        return {"id": "kidsvideo01", "formats": [{"url": "https://cdn.example/v"}]}
    raise RuntimeError(NOT_AVAILABLE)


def test_an_unavailable_video_is_retried_once_with_the_js_client(dummy_ydl):
    dummy_ydl.handler = _kids_handler
    opts = {"quiet": True, "extractor_args": yc.youtube_extractor_args()}
    info = yc.extract_info_gated(KIDS, opts)
    assert info["id"] == "kidsvideo01"
    plain, js = dummy_ydl.calls
    assert "js_runtimes" not in plain
    assert js["js_runtimes"] == {"deno": {"path": "/opt/deno/deno"}}
    assert js["extractor_args"]["youtube"]["player_client"] == ["tv_samsung"]
    # The answer is cached like any other: no third extraction.
    yc.extract_info_gated(KIDS, opts)
    assert len(dummy_ydl.calls) == 2


def test_no_js_retry_without_a_runtime(dummy_ydl, monkeypatch):
    monkeypatch.setattr(yc, "YTDLP_JS_RUNTIME", "")
    dummy_ydl.handler = _kids_handler
    with pytest.raises(RuntimeError, match="not available"):
        yc.extract_info_gated(KIDS, {"quiet": True})
    assert len(dummy_ydl.calls) == 1


@pytest.mark.parametrize(
    "message",
    [
        "ERROR: [youtube] abc: Video unavailable. This video has been removed",
        "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
        "ERROR: [youtube] abc: Sign in to confirm you're not a bot",
    ],
)
def test_other_failures_are_not_retried_with_the_js_client(dummy_ydl, message):
    def handler(opts, url):
        raise RuntimeError(message)

    dummy_ydl.handler = handler
    with pytest.raises(RuntimeError):
        yc.extract_info_gated(KIDS, {"quiet": True})
    assert len(dummy_ydl.calls) == 1


def test_a_failed_js_retry_still_reports_youtubes_answer(dummy_ydl):
    # The channel catalog skips a video it sees as unavailable; a broken
    # challenge solver must not hide that.
    def handler(opts, url):
        if (opts.get("extractor_args") or {}).get("youtube", {}).get(
            "player_client"
        ) == ["tv_samsung"]:
            raise RuntimeError("n challenge solving failed")
        raise RuntimeError(NOT_AVAILABLE)

    dummy_ydl.handler = handler
    with pytest.raises(RuntimeError, match="not available"):
        yc.extract_info_gated(KIDS, {"quiet": True})
    assert len(dummy_ydl.calls) == 2


def test_only_youtubes_exact_answer_needs_the_js_client():
    assert yc.needs_js_client(NOT_AVAILABLE)
    assert yc.needs_js_client(NOT_AVAILABLE + ".")
    assert not yc.needs_js_client(
        "ERROR: [youtube] abc: This video is not available from your location"
    )
    assert not yc.needs_js_client("ERROR: [ARD] abc: This video is not available")

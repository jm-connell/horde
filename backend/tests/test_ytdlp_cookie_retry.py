"""Cookies attach only after an age-restricted or members-only block."""

import sys
import types

import pytest

from app.services import ytdlp_common as yc


class DummyYDL:
    def __init__(self, opts):
        self.opts = opts
        DummyYDL.calls.append(opts)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def extract_info(self, url, download=False):
        return DummyYDL.handler(self.opts, url)


@pytest.fixture
def dummy_ydl(monkeypatch):
    DummyYDL.calls = []
    DummyYDL.handler = lambda opts, url: {"id": "ok", "title": "Public"}
    monkeypatch.setitem(
        sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=DummyYDL)
    )
    monkeypatch.setattr(yc, "ensure_plugins_loaded", lambda: None)
    monkeypatch.setattr(yc, "_EXTRACT_MIN_INTERVAL_SEC", 0)
    yc._info_cache.clear()
    yc._cookie_required_until.clear()
    yc._last_extract_at = 0.0
    yield DummyYDL
    yc._info_cache.clear()
    yc._cookie_required_until.clear()


def _attach_cookies(opts):
    merged = dict(opts)
    merged["cookiefile"] = "/tmp/cookies.txt"
    return merged


def test_extract_retries_with_cookies_after_age_gate(dummy_ydl, monkeypatch):
    monkeypatch.setattr(yc, "cookie_configured", lambda: True)
    monkeypatch.setattr(yc, "apply_cookie_opts", _attach_cookies)

    def handler(opts, url):
        if opts.get("cookiefile"):
            return {
                "id": "gated",
                "title": "Secret",
                "availability": "age_restricted",
                "formats": [{"url": "https://cdn.example/v"}],
            }
        raise RuntimeError("Login required / age-restricted")

    dummy_ydl.handler = handler
    info = yc.extract_info_gated(
        "https://www.youtube.com/watch?v=gatedvid1",
        {"quiet": True},
        cache_key="test-age",
    )
    assert info["id"] == "gated"
    assert len(dummy_ydl.calls) == 2
    assert "cookiefile" not in dummy_ydl.calls[0]
    assert dummy_ydl.calls[1]["cookiefile"] == "/tmp/cookies.txt"
    assert yc.extract_used_cookies()
    assert yc.url_cookie_required("https://www.youtube.com/watch?v=gatedvid1")


def test_extract_retries_with_cookies_after_members_gate(dummy_ydl, monkeypatch):
    monkeypatch.setattr(yc, "cookie_configured", lambda: True)
    monkeypatch.setattr(yc, "apply_cookie_opts", _attach_cookies)

    def handler(opts, url):
        if opts.get("cookiefile"):
            return {
                "id": "mem",
                "title": "[Members only] Hangout",
                "availability": "subscriber_only",
                "formats": [{"url": "https://cdn.example/v"}],
            }
        raise RuntimeError("Join this channel to get access to members-only content")

    dummy_ydl.handler = handler
    info = yc.extract_info_gated("https://www.youtube.com/watch?v=memvid", {"quiet": True})
    assert yc.extract_has_media(info)
    assert len(dummy_ydl.calls) == 2
    assert dummy_ydl.calls[1].get("cookiefile")


def test_extract_does_not_retry_bot_check_with_cookies(dummy_ydl, monkeypatch):
    monkeypatch.setattr(yc, "cookie_configured", lambda: True)
    monkeypatch.setattr(yc, "apply_cookie_opts", _attach_cookies)

    def handler(opts, url):
        raise RuntimeError("Sign in to confirm you’re not a bot")

    dummy_ydl.handler = handler
    with pytest.raises(RuntimeError, match="not a bot"):
        yc.extract_info_gated("https://www.youtube.com/watch?v=botvid", {"quiet": True})
    assert len(dummy_ydl.calls) == 1
    assert "cookiefile" not in dummy_ydl.calls[0]
    assert not yc.extract_used_cookies()


def test_listing_extract_does_not_attach_cookies(dummy_ydl, monkeypatch):
    monkeypatch.setattr(yc, "cookie_configured", lambda: True)
    monkeypatch.setattr(yc, "apply_cookie_opts", _attach_cookies)

    def handler(opts, url):
        raise RuntimeError("Login required / age-restricted")

    dummy_ydl.handler = handler
    with pytest.raises(RuntimeError, match="age-restricted"):
        yc.extract_info_gated(
            "https://www.youtube.com/@channel/videos",
            {"quiet": True, "extract_flat": "in_playlist"},
            cookie_retry=False,
        )
    assert len(dummy_ydl.calls) == 1
    assert "cookiefile" not in dummy_ydl.calls[0]


def test_known_gated_url_skips_anonymous_extract(dummy_ydl, monkeypatch):
    monkeypatch.setattr(yc, "cookie_configured", lambda: True)
    monkeypatch.setattr(yc, "apply_cookie_opts", _attach_cookies)
    url = "https://www.youtube.com/watch?v=known"
    yc.remember_cookie_required(url)

    def handler(opts, url):
        assert opts.get("cookiefile")
        return {"id": "known", "formats": [{"url": "https://cdn.example/v"}]}

    dummy_ydl.handler = handler
    yc.extract_info_gated(url, {"quiet": True}, cache_key="test-known")
    assert len(dummy_ydl.calls) == 1
    assert dummy_ydl.calls[0]["cookiefile"]


def test_public_extract_never_attaches_cookies(dummy_ydl, monkeypatch):
    monkeypatch.setattr(yc, "cookie_configured", lambda: True)
    monkeypatch.setattr(yc, "apply_cookie_opts", _attach_cookies)
    info = yc.extract_info_gated(
        "https://www.youtube.com/watch?v=publicvid", {"quiet": True}
    )
    assert info["id"] == "ok"
    assert len(dummy_ydl.calls) == 1
    assert "cookiefile" not in dummy_ydl.calls[0]
    assert not yc.extract_used_cookies()


def test_should_retry_only_for_cookie_and_members_gates(monkeypatch):
    monkeypatch.setattr(yc, "cookie_configured", lambda: True)
    assert yc.should_retry_with_cookies({}, RuntimeError("Login required / age-restricted"))
    assert yc.should_retry_with_cookies(
        {}, RuntimeError("members-only content")
    )
    assert not yc.should_retry_with_cookies(
        {}, RuntimeError("Sign in to confirm you’re not a bot")
    )
    assert not yc.should_retry_with_cookies(
        {"cookiefile": "/tmp/cookies.txt"},
        RuntimeError("Login required / age-restricted"),
    )
    monkeypatch.setattr(yc, "cookie_configured", lambda: False)
    assert not yc.should_retry_with_cookies(
        {}, RuntimeError("Login required / age-restricted")
    )

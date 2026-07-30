"""Tests for AI provider error classification."""

import httpx

from app.services.ai.provider import classify_provider_error, format_provider_error


def test_classify_timeout():
    kind, msg = classify_provider_error(httpx.ReadTimeout("timed out"))
    assert kind == "timeout"
    assert "timed out" in msg.lower()


def test_classify_network():
    kind, msg = classify_provider_error(httpx.ConnectError("refused"))
    assert kind == "network"


def test_classify_auth_and_rate(monkeypatch):
    req = httpx.Request("GET", "https://example.com")
    resp = httpx.Response(401, request=req)
    kind, msg = classify_provider_error(httpx.HTTPStatusError("nope", request=req, response=resp))
    assert kind == "auth"
    resp429 = httpx.Response(429, request=req)
    kind, _ = classify_provider_error(
        httpx.HTTPStatusError("slow", request=req, response=resp429)
    )
    assert kind == "rate_limit"


def test_format_provider_error_includes_kind():
    text = format_provider_error(httpx.ConnectError("down"))
    assert "(network)" in text

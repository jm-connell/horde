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
    kind, msg = classify_provider_error(
        httpx.HTTPStatusError("nope", request=req, response=resp)
    )
    assert kind == "auth"
    resp429 = httpx.Response(429, request=req)
    kind, _ = classify_provider_error(
        httpx.HTTPStatusError("slow", request=req, response=resp429)
    )
    assert kind == "rate_limit"


def test_format_provider_error_includes_kind():
    text = format_provider_error(httpx.ConnectError("down"))
    assert "(network)" in text


def test_connection_tests_do_not_echo_exception_text(client, monkeypatch):
    from app.services.ai import provider

    def boom(self):
        raise RuntimeError("internal detail http://10.0.0.5/secret")

    monkeypatch.setattr(provider.OpenAICompatProvider, "list_models", boom)
    body = client.post(
        "/api/ai/test",
        json={"base_url": "https://openrouter.ai/api/v1", "api_key": "k"},
    ).json()
    assert body["ok"] is False
    assert "10.0.0.5" not in body["detail"]
    assert "server log" in body["detail"]

    req = httpx.Request("GET", "https://openrouter.ai/api/v1/models")
    resp = httpx.Response(401, request=req)

    def rejected(self):
        raise httpx.HTTPStatusError("401 body", request=req, response=resp)

    monkeypatch.setattr(provider.OpenAICompatProvider, "list_models", rejected)
    body = client.post(
        "/api/ai/test",
        json={"base_url": "https://openrouter.ai/api/v1", "api_key": "k"},
    ).json()
    assert body == {
        "ok": False,
        "base_url": "https://openrouter.ai/api/v1",
        "detail": "AI provider rejected credentials",
    }

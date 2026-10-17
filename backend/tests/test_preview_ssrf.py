"""URLs that yt-dlp returns are fetched by the backend, so they go through url_safety."""

from __future__ import annotations

import httpx
import pytest

from app.api import preview
from app.services import stream_preview, url_safety


@pytest.fixture
def upstream(monkeypatch):
    """Preview proxy client backed by a recording mock instead of the network."""
    seen: list[str] = []
    routes: dict[str, httpx.Response] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.host)
        return routes.get(request.url.host, httpx.Response(200, content=b"ok"))

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    )
    monkeypatch.setattr(preview, "_preview_client", client)
    return seen, routes


def _resolved(url: str) -> dict:
    return {"direct_url": url, "http_headers": {}, "content_type": "video/mp4"}


def test_media_proxy_refuses_an_internal_extractor_url(client, monkeypatch, upstream):
    seen, _routes = upstream
    monkeypatch.setattr(
        stream_preview,
        "lookup_preview_media",
        lambda *_a, **_k: _resolved("http://169.254.169.254/latest/meta-data/"),
    )

    for method in ("get", "head"):
        resp = getattr(client, method)(
            "/api/preview/media", params={"token": "t", "itag": "18"}
        )
        assert resp.status_code == 400, method

    assert seen == []


def test_media_proxy_rechecks_every_redirect_hop(client, monkeypatch, upstream):
    seen, routes = upstream
    monkeypatch.setattr(
        stream_preview,
        "lookup_preview_media",
        lambda *_a, **_k: _resolved("http://cdn.example/v.mp4"),
    )
    routes["93.184.216.34"] = httpx.Response(
        302, headers={"Location": "http://127.0.0.1:9/secret"}
    )
    # The mock sees the real host (no pinning in the proxy); route by hostname.
    routes["cdn.example"] = routes.pop("93.184.216.34")

    resp = client.get("/api/preview/media", params={"token": "t", "itag": "18"})

    assert resp.status_code == 400
    assert seen == ["cdn.example"]


def test_legacy_stream_proxy_refuses_an_internal_extractor_url(
    client, monkeypatch, upstream
):
    seen, _routes = upstream
    monkeypatch.setattr(
        stream_preview,
        "resolve_preview_stream",
        lambda *_a, **_k: _resolved("http://10.0.0.8/video.mp4"),
    )

    resp = client.get("/api/preview/stream", params={"url": "https://example.com/v"})

    assert resp.status_code == 400
    assert seen == []


def test_subtitle_proxy_refuses_an_internal_extractor_url(
    client, monkeypatch, upstream
):
    seen, _routes = upstream
    monkeypatch.setattr(
        stream_preview,
        "resolve_preview_subtitle",
        lambda *_a, **_k: _resolved("http://192.168.1.1/en.vtt"),
    )

    resp = client.get("/api/preview/subtitles", params={"url": "https://example.com/v"})

    assert resp.status_code == 400
    assert seen == []


def test_dash_probe_refuses_an_internal_extractor_url():
    with pytest.raises(url_safety.UnsafeUrlError):
        stream_preview._probe_mp4_ranges("http://127.0.0.1:8080/seg.mp4", {})

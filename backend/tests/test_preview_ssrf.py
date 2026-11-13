"""URLs that yt-dlp returns are fetched by the backend, so they go through url_safety."""

from __future__ import annotations

import asyncio
import ipaddress
import socket

import httpx
import pytest

from app.api import preview
from app.services import stream_preview, url_safety


@pytest.fixture
def upstream(monkeypatch):
    """Preview proxy client backed by a recording mock instead of the network."""
    seen: list[str] = []
    routes: dict[str, httpx.Response] = {}
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.host)
        sent.append(request)
        return routes.get(request.url.host, httpx.Response(200, content=b"ok"))

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    )
    monkeypatch.setattr(preview, "_preview_client", client)
    return seen, routes, sent


def _resolved(url: str) -> dict:
    return {"direct_url": url, "http_headers": {}, "content_type": "video/mp4"}


def test_media_proxy_refuses_an_internal_extractor_url(client, monkeypatch, upstream):
    seen, _routes, _sent = upstream
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
    seen, routes, _sent = upstream
    monkeypatch.setattr(
        stream_preview,
        "lookup_preview_media",
        lambda *_a, **_k: _resolved("http://cdn.example/v.mp4"),
    )
    # The connection is pinned: the mock sees the validated address.
    routes["93.184.216.34"] = httpx.Response(
        302, headers={"Location": "http://127.0.0.1:9/secret"}
    )

    resp = client.get("/api/preview/media", params={"token": "t", "itag": "18"})

    assert resp.status_code == 400
    assert seen == ["93.184.216.34"]


def test_legacy_stream_proxy_refuses_an_internal_extractor_url(
    client, monkeypatch, upstream
):
    seen, _routes, _sent = upstream
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
    seen, _routes, _sent = upstream
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


def test_stream_proxy_connects_only_to_the_address_it_checked(
    client, monkeypatch, upstream
):
    """DNS answering a public address to the check must not let httpx resolve the
    name again (and be handed loopback): the connection goes to the checked IP."""
    seen, _routes, sent = upstream
    monkeypatch.setattr(
        stream_preview,
        "resolve_preview_stream",
        lambda *_a, **_k: _resolved("https://rebind.example/video.mp4"),
    )

    resp = client.get("/api/preview/stream", params={"url": "https://example.com/v"})

    assert resp.status_code == 200
    assert seen == ["93.184.216.34"]
    (request,) = sent
    assert request.headers["host"] == "rebind.example"
    assert request.extensions["sni_hostname"] == "rebind.example"


def test_stream_proxy_refuses_a_host_that_does_not_resolve(
    client, monkeypatch, upstream
):
    """A failed check-time lookup must not leave the name for httpx to resolve."""
    seen, _routes, _sent = upstream

    def unresolvable(host: str, port: int):
        if host == "example.com":
            return [ipaddress.ip_address("93.184.216.34")]
        raise socket.gaierror("no such name")

    monkeypatch.setattr(url_safety, "_resolve", unresolvable)
    monkeypatch.setattr(
        stream_preview,
        "resolve_preview_stream",
        lambda *_a, **_k: _resolved("http://rebind.example/video.mp4"),
    )

    resp = client.get("/api/preview/stream", params={"url": "https://example.com/v"})

    assert resp.status_code == 400
    assert seen == []


def test_a_pinned_response_keeps_the_url_by_name(upstream):
    """Relative links in an HLS playlist resolve against ``response.url``."""
    resp = asyncio.run(
        preview._send_validated(
            preview.get_preview_client(),
            "GET",
            "https://cdn.example/live/index.m3u8",
            {},
            stream=False,
        )
    )

    assert str(resp.url) == "https://cdn.example/live/index.m3u8"

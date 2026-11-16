"""URLs that yt-dlp returns are fetched by the backend, so they go through url_safety."""

from __future__ import annotations

import asyncio
import http.server
import ipaddress
import socket
import threading

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
        # Pinned requests carry the name in Host; route by it, then by address.
        route = routes.get(request.headers.get("host", "")) or routes.get(
            request.url.host, httpx.Response(200, content=b"ok")
        )
        return route(request) if callable(route) else route

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
    routes["cdn.example"] = httpx.Response(
        302, headers={"Location": "http://127.0.0.1:9/secret"}
    )

    resp = client.get("/api/preview/media", params={"token": "t", "itag": "18"})

    assert resp.status_code == 400
    assert seen == ["cdn.example"]


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


@pytest.fixture
def loopback_server():
    """A real HTTP server on 127.0.0.1 that records the Host of every request."""
    hosts: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hosts.append(self.headers.get("Host", ""))
            self.send_response(200)
            self.send_header("Content-Length", "6")
            self.end_headers()
            self.wfile.write(b"secret")

        def log_message(self, *_args):
            return None

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1], hosts
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def _fetch_with_real_client(url: str) -> httpx.Response:
    async def run() -> httpx.Response:
        transport = url_safety.pinned_async_transport(httpx.Limits())
        async with httpx.AsyncClient(transport=transport) as client:
            return await preview._send_validated(client, "GET", url, {}, stream=False)

    return asyncio.run(run())


def test_dns_rebinding_cannot_reach_loopback(monkeypatch, loopback_server):
    """DNS answers the check with a public address and the connect with loopback."""
    port, hosts = loopback_server
    answers = iter(["93.184.216.34"])

    def rebinding(host: str, port: int):
        return [ipaddress.ip_address(next(answers, "127.0.0.1"))]

    monkeypatch.setattr(url_safety, "_resolve", rebinding)

    with pytest.raises(url_safety.UnsafeUrlError):
        _fetch_with_real_client(f"http://rebind.example:{port}/secret")
    assert hosts == []


def test_pinned_client_connects_by_name(monkeypatch, loopback_server):
    """Where LAN sources are allowed the same client reaches the server, by name."""
    port, hosts = loopback_server
    monkeypatch.setenv("HORDE_ALLOW_PRIVATE_URLS", "1")
    monkeypatch.setattr(
        url_safety, "_resolve", lambda _h, _p: [ipaddress.ip_address("127.0.0.1")]
    )

    resp = _fetch_with_real_client(f"http://media.example:{port}/v")

    assert resp.content == b"secret"
    assert hosts == [f"media.example:{port}"]


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


def _with_cookie(url: str) -> dict:
    return {**_resolved(url), "http_headers": {"Cookie": "SID=secret", "X-Keep": "1"}}


def test_stream_proxy_drops_cookies_on_a_redirect_to_another_host(
    client, monkeypatch, upstream
):
    """Cookies yt-dlp scoped to the format URL must not follow it to another host."""
    _seen, routes, sent = upstream
    monkeypatch.setattr(
        stream_preview,
        "resolve_preview_stream",
        lambda *_a, **_k: _with_cookie("https://cdn.example/video.mp4"),
    )
    routes["cdn.example"] = httpx.Response(
        302, headers={"Location": "https://other.example/landing"}
    )

    resp = client.get("/api/preview/stream", params={"url": "https://example.com/v"})

    assert resp.status_code == 200
    first, second = sent
    assert first.headers["cookie"] == "SID=secret"
    assert second.headers["host"] == "other.example"
    assert "cookie" not in second.headers
    assert second.headers["x-keep"] == "1"


def test_stream_proxy_keeps_cookies_on_a_same_origin_redirect(
    client, monkeypatch, upstream
):
    _seen, routes, sent = upstream
    monkeypatch.setattr(
        stream_preview,
        "resolve_preview_stream",
        lambda *_a, **_k: _with_cookie("https://cdn.example/video.mp4"),
    )
    routes["cdn.example"] = lambda request: (
        httpx.Response(302, headers={"Location": "/v2.mp4"})
        if request.url.path == "/video.mp4"
        else httpx.Response(200, content=b"ok")
    )

    resp = client.get("/api/preview/stream", params={"url": "https://example.com/v"})

    assert resp.status_code == 200
    assert [r.url.path for r in sent] == ["/video.mp4", "/v2.mp4"]
    assert all(r.headers["cookie"] == "SID=secret" for r in sent)


def test_fetch_bytes_drops_cookies_on_a_redirect_to_another_host(monkeypatch):
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.headers["host"] == "cdn.example":
            return httpx.Response(302, headers={"Location": "http://other.example/x"})
        return httpx.Response(200, content=b"ok")

    real_client = httpx.Client
    monkeypatch.setattr(
        url_safety.httpx,
        "Client",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )

    url_safety.fetch_bytes(
        "http://cdn.example/a", max_bytes=10, headers={"Cookie": "SID=secret"}
    )

    assert [r.headers.get("cookie") for r in sent] == ["SID=secret", None]

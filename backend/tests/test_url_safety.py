"""SSRF gate: scheme, address ranges, redirects, size cap, and API entry points."""

from __future__ import annotations

import ipaddress
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

import httpx
import pytest
from PIL import Image

from app.services import url_safety
from app.services.url_safety import (
    UnsafeUrlError,
    UrlFetchError,
    fetch_bytes,
    validate_public_url,
)

_REAL_RESOLVE = url_safety._resolve


def _png(color=(200, 30, 30)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", (32, 18), color).save(buf, "PNG")
    return buf.getvalue()


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com/",
        "javascript:alert(1)",
        "http://127.0.0.1:8080/",
        "http://localhost/",
        "http://10.0.0.5/",
        "http://192.168.1.10/",
        "http://172.16.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://100.64.0.1/",  # CGNAT / Tailscale
        "http://100.100.100.200/",  # Alibaba metadata
        "http://[::1]/",
        "http://[fd00:ec2::254]/",
        "http://[::ffff:127.0.0.1]/",
        "http://0.0.0.0/",
        "http://224.0.0.1/",
        "http://user:pw@example.com/",
        "http:///nohost",
    ],
)
def test_blocked_urls(url):
    with pytest.raises(UnsafeUrlError):
        validate_public_url(url)


@pytest.mark.parametrize(
    "url",
    ["https://example.com/a", "http://93.184.216.34/", "https://[2606:2800:220:1::1]/"],
)
def test_public_urls_pass(url):
    assert validate_public_url(url) == url


def test_every_resolved_address_must_be_public(monkeypatch):
    monkeypatch.setattr(
        url_safety,
        "_resolve",
        lambda host, port: [
            ipaddress.ip_address("93.184.216.34"),
            ipaddress.ip_address("10.1.2.3"),
        ],
    )
    with pytest.raises(UnsafeUrlError):
        validate_public_url("http://mixed.example/")


def test_decimal_and_hex_ip_forms_are_blocked(monkeypatch):
    """libc turns 2130706433 / 0x7f.1 into 127.0.0.1; the resolved address is checked."""
    monkeypatch.setattr(url_safety, "_resolve", _REAL_RESOLVE)
    monkeypatch.setattr(
        url_safety.socket,
        "getaddrinfo",
        lambda host, port, **_kw: [(2, 1, 6, "", ("127.0.0.1", port))],
    )
    with pytest.raises(UnsafeUrlError):
        validate_public_url("http://2130706433/")
    with pytest.raises(UnsafeUrlError):
        validate_public_url("http://0x7f.1/")


def test_unresolvable_names_pass_the_yt_dlp_preflight_only(monkeypatch):
    import socket

    def boom(host, port):
        raise socket.gaierror("nope")

    monkeypatch.setattr(url_safety, "_resolve", boom)
    assert validate_public_url("https://example.invalid/x")
    # fetch_bytes pins the connection to a validated address, so it cannot proceed.
    with pytest.raises(UnsafeUrlError, match="resolve"):
        fetch_bytes("https://example.invalid/x", max_bytes=1000)


def test_fetch_refuses_a_name_that_fails_to_resolve_even_if_it_would_later(
    local_server, monkeypatch
):
    """DNS that fails the first lookup and answers 127.0.0.1 the second time."""
    import socket

    base, handler = local_server
    monkeypatch.setenv("HORDE_ALLOW_PRIVATE_URLS", "1")

    def boom(host, port):
        raise socket.gaierror("first lookup fails")

    monkeypatch.setattr(url_safety, "_resolve", boom)
    port = base.rsplit(":", 1)[1]

    with pytest.raises(UnsafeUrlError):
        fetch_bytes(f"http://rebind.example:{port}/img.png", max_bytes=1000)

    assert handler.hits == []


@pytest.mark.parametrize(
    "url",
    ["http://[::127.0.0.1]/", "http://[::a00:1]/", "http://[64:ff9b::7f00:1]/"],
)
def test_embedded_ipv4_in_ipv6_forms_is_blocked(url):
    with pytest.raises(UnsafeUrlError):
        validate_public_url(url)


def test_fetch_falls_back_to_the_next_validated_address(monkeypatch):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.host)
        if request.url.host == "2606:2800:220:1::1":
            raise httpx.ConnectError("no IPv6 route")
        return httpx.Response(200, content=b"ok")

    monkeypatch.setattr(
        url_safety,
        "_resolve",
        lambda host, port: [
            ipaddress.ip_address("2606:2800:220:1::1"),
            ipaddress.ip_address("93.184.216.34"),
        ],
    )
    _mock_transport(monkeypatch, handler)

    result = fetch_bytes("http://dual.example/x", max_bytes=1000)

    assert result.body == b"ok"
    assert seen == ["2606:2800:220:1::1", "93.184.216.34"]


def test_private_urls_can_be_allowed_for_lan_sources(monkeypatch):
    monkeypatch.setenv("HORDE_ALLOW_PRIVATE_URLS", "1")
    assert validate_public_url("http://192.168.1.10:8096/video")
    # The scheme rule is not relaxed.
    with pytest.raises(UnsafeUrlError):
        validate_public_url("file:///etc/passwd")


class _Handler(BaseHTTPRequestHandler):
    hits: list[str] = []
    big = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        type(self).hits.append(self.path)
        if self.path == "/img.png":
            self._send(200, _png(), "image/png")
        elif self.path == "/page.html":
            self._send(200, b"<html><script>alert(1)</script></html>", "text/html")
        elif self.path == "/big":
            self._send(200, b"\x00" * type(self).big, "image/png")
        elif self.path == "/loop":
            self.send_response(302)
            self.send_header("Location", "/loop")
            self.end_headers()
        else:
            self._send(404, b"nope", "text/plain")

    def _send(self, status, body, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def local_server():
    """A real HTTP server on 127.0.0.1 recording every request it receives."""
    handler = type("Handler", (_Handler,), {"hits": [], "big": 0})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", handler
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def test_fetch_never_contacts_a_loopback_server(local_server):
    base, handler = local_server

    with pytest.raises(UnsafeUrlError):
        fetch_bytes(f"{base}/img.png", max_bytes=1_000_000)

    assert handler.hits == []


def test_fetch_works_against_a_lan_server_when_opted_in(local_server, monkeypatch):
    base, handler = local_server
    monkeypatch.setenv("HORDE_ALLOW_PRIVATE_URLS", "1")

    result = fetch_bytes(f"{base}/img.png", max_bytes=1_000_000)

    assert result.body == _png()
    assert result.content_type == "image/png"
    assert handler.hits == ["/img.png"]


def test_fetch_enforces_the_size_cap_while_streaming(local_server, monkeypatch):
    base, handler = local_server
    monkeypatch.setenv("HORDE_ALLOW_PRIVATE_URLS", "1")
    handler.big = 200_000

    with pytest.raises(UrlFetchError, match="too large"):
        fetch_bytes(f"{base}/big", max_bytes=50_000)


def test_fetch_stops_after_too_many_redirects(local_server, monkeypatch):
    base, handler = local_server
    monkeypatch.setenv("HORDE_ALLOW_PRIVATE_URLS", "1")

    with pytest.raises(UrlFetchError, match="redirects"):
        fetch_bytes(f"{base}/loop", max_bytes=1000)

    assert len(handler.hits) == url_safety.MAX_REDIRECTS + 1


def _mock_transport(monkeypatch, handler):
    """Route url_safety's httpx client through ``handler`` (no sockets)."""
    real_client = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        url_safety.httpx,
        "Client",
        lambda **kw: real_client(transport=transport, **kw),
    )


def test_redirect_to_loopback_is_blocked_on_the_second_hop(monkeypatch):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["host"])
        return httpx.Response(302, headers={"Location": "http://127.0.0.1:9/secret"})

    _mock_transport(monkeypatch, handler)

    with pytest.raises(UnsafeUrlError):
        fetch_bytes("http://public.example/start", max_bytes=1000)

    assert seen == ["public.example"]


def test_connection_is_pinned_to_the_validated_address(monkeypatch):
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers["host"]))
        return httpx.Response(200, content=b"ok")

    _mock_transport(monkeypatch, handler)

    fetch_bytes("http://public.example:8080/x", max_bytes=1000)

    assert seen == [("93.184.216.34", "public.example:8080")]


# --- API level -----------------------------------------------------------------


def _video_with_thumbnail_slot(add_video):
    return add_video(title="Thumb", source_url="https://example.com/v")


def test_thumbnail_url_pointing_at_loopback_is_refused(client, add_video, local_server):
    base, handler = local_server
    video = _video_with_thumbnail_slot(add_video)

    resp = client.patch(
        f"/api/videos/{video.id}", json={"thumbnail_url": f"{base}/img.png"}
    )

    assert resp.status_code == 400
    assert "private network" in resp.json()["detail"]
    assert handler.hits == []


def test_thumbnail_url_redirecting_to_loopback_is_refused(
    client, add_video, monkeypatch
):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["host"])
        return httpx.Response(302, headers={"Location": "http://127.0.0.1:9/secret"})

    _mock_transport(monkeypatch, handler)
    video = _video_with_thumbnail_slot(add_video)

    resp = client.patch(
        f"/api/videos/{video.id}", json={"thumbnail_url": "http://public.example/t"}
    )

    assert resp.status_code == 400
    assert seen == ["public.example"]


def test_thumbnail_url_must_be_an_image_and_is_stored_as_jpeg(
    client, add_video, monkeypatch, init_db
):
    video = _video_with_thumbnail_slot(add_video)
    bodies = {
        "/page.html": (b"<html>hi</html>", "text/html"),
        "/ok.png": (_png(), "image/png"),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        body, ctype = bodies[request.url.path]
        return httpx.Response(200, content=body, headers={"Content-Type": ctype})

    _mock_transport(monkeypatch, handler)

    html = client.patch(
        f"/api/videos/{video.id}",
        json={"thumbnail_url": "http://public.example/page.html"},
    )
    assert html.status_code == 400
    assert not (init_db["data"] / "thumbnails" / f"{video.id}.jpg").exists()

    ok = client.patch(
        f"/api/videos/{video.id}",
        json={"thumbnail_url": "http://public.example/ok.png"},
    )
    assert ok.status_code == 200
    served = client.get(f"/api/thumbnails/{video.id}")
    assert served.headers["content-type"] == "image/jpeg"
    assert Image.open(BytesIO(served.content)).format == "JPEG"


@pytest.mark.parametrize(
    "bad", ["javascript:alert(1)", "data:text/html,<script>", "ftp://x/y", "//evil/x"]
)
def test_source_and_channel_urls_must_be_http(client, add_video, bad):
    video = add_video(title="Links")

    for field in ("source_url", "channel_url"):
        resp = client.patch(f"/api/videos/{video.id}", json={field: bad})
        assert resp.status_code == 422, (field, bad)

    ok = client.patch(
        f"/api/videos/{video.id}",
        json={"source_url": "https://example.com/watch?v=1", "channel_url": ""},
    )
    assert ok.status_code == 200


@pytest.mark.parametrize(
    "url", ["http://127.0.0.1:1/x", "http://169.254.169.254/", "file:///etc/passwd"]
)
def test_ytdlp_entry_points_refuse_internal_urls(client, monkeypatch, url):
    from app.services import downloader

    def must_not_run(*_a, **_kw):
        raise AssertionError("yt-dlp was started for an unsafe URL")

    monkeypatch.setattr(downloader, "extract_preview", must_not_run)
    monkeypatch.setattr(downloader, "extract_playlist", must_not_run)
    monkeypatch.setattr(downloader, "extract_playlist_entries", must_not_run)

    assert client.get("/api/downloads/preview", params={"url": url}).status_code == 400
    assert client.post("/api/downloads", json={"url": url}).status_code == 400
    assert client.get("/api/playlists/preview", params={"url": url}).status_code == 400
    assert client.post("/api/playlists/import", json={"url": url}).status_code == 400
    assert (
        client.post(
            "/api/playlists/import",
            json={"url": "https://example.com/playlist?list=PL1", "entries": [url]},
        ).status_code
        == 400
    )
    assert client.get("/api/preview/meta", params={"url": url}).status_code == 400
    assert client.get("/api/preview/manifest", params={"url": url}).status_code == 400
    assert client.get("/api/preview/stream", params={"url": url}).status_code == 400
    assert client.get("/api/channels/feed", params={"url": url}).status_code == 400
    sizes = client.post("/api/playlists/estimate", json={"urls": [url]})
    assert sizes.status_code == 200
    assert sizes.json() == {"sizes": {}}


def test_bulk_download_skips_unsafe_urls(client):
    resp = client.post(
        "/api/downloads/bulk",
        json={"urls": ["http://127.0.0.1/x", "file:///etc/passwd"]},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["jobs"] == []
    assert {s["reason"] for s in body["skips"]} == {"invalid_url"}

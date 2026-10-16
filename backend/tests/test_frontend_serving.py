"""PWA serving: /api/ping, cache headers for the shell, and the SPA fallback."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _frontend(tmp_path):
    root = tmp_path / "static"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>Horde</title>")
    (root / "sw.js").write_text("self.addEventListener('fetch', () => {});")
    (root / "manifest.json").write_text("{}")
    (root / "horde-icon.webp").write_bytes(b"RIFF")
    (root / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("nope")
    return root


def _client(tmp_path) -> TestClient:
    from app.main import mount_frontend, ping

    app = FastAPI()
    app.add_api_route("/api/ping", ping, methods=["GET"])
    mount_frontend(app, _frontend(tmp_path), tmp_path / "no-wiki")
    return TestClient(app)


def test_ping_is_uncached(tmp_path):
    resp = _client(tmp_path).get("/api/ping")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert resp.headers["cache-control"] == "no-store"


def test_hashed_assets_are_immutable(tmp_path):
    resp = _client(tmp_path).get("/assets/index-abc123.js")
    assert resp.status_code == 200
    assert "immutable" in resp.headers["cache-control"]


def test_shell_files_revalidate(tmp_path):
    client = _client(tmp_path)
    for path in ("/sw.js", "/manifest.json", "/watch/12"):
        resp = client.get(path)
        assert resp.status_code == 200, path
        assert resp.headers["cache-control"] == "no-cache", path
    sw = client.get("/sw.js")
    assert "javascript" in sw.headers["content-type"]


def test_icons_cache_briefly(tmp_path):
    resp = _client(tmp_path).get("/horde-icon.webp")
    assert resp.headers["cache-control"] == "public, max-age=86400"


def test_spa_fallback_serves_index(tmp_path):
    resp = _client(tmp_path).get("/offline")
    assert resp.status_code == 200
    assert "<title>Horde</title>" in resp.text


def test_unknown_api_and_missing_worker_404(tmp_path):
    client = _client(tmp_path)
    (tmp_path / "static" / "sw.js").unlink()
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/sw.js").status_code == 404


def test_no_path_traversal(tmp_path):
    resp = _client(tmp_path).get("/..%2Fsecret.txt")
    assert "nope" not in resp.text


def test_unknown_api_paths_404_whatever_their_spelling(tmp_path):
    """A doubled slash or other case must not turn an API miss into the SPA page."""
    client = _client(tmp_path)
    for path in (
        "http://testserver//api/videos",
        "/API/videos",
        "/Api/ping/x",
        "/api",
        "/API",
    ):
        resp = client.get(path)
        assert resp.status_code == 404, path
        assert resp.json()["code"] == "not_found", path
    # Paths that merely start with the letters stay SPA routes.
    assert client.get("/apiary").status_code == 200

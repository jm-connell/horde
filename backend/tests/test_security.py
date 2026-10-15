"""Host allowlist, CSRF gate, media-only CORS, security headers, request limits."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import security
from app.security import HostPolicy, install_security

CSRF = {"X-Horde-Request": "1"}


# --- Host allowlist ------------------------------------------------------------


@pytest.mark.parametrize(
    "host",
    [
        "testserver",
        "localhost:8080",
        "127.0.0.1:8686",
        "[::1]:8686",
        "192.168.1.20:8686",
        "10.0.0.7",
        "172.20.1.1:80",
        "169.254.10.10",
        "100.101.102.103:8686",  # Tailscale CGNAT
        "truenas",
        "truenas:8686",
        "horde.local",
        "nas.lan:8080",
        "router.home.arpa",
        "box.internal",
        "myhost.tail1234.ts.net",
        "Horde.LOCAL.",
    ],
)
def test_default_host_policy_allows_lan_names(host):
    assert HostPolicy.from_env(None).allows(host)


@pytest.mark.parametrize(
    "host",
    [
        "evil.com",
        "evil.com:8686",
        "rebind.attacker.example",
        "8.8.8.8",
        "93.184.216.34:8686",
        "[2606:2800:220:1::1]",
        "horde.local.evil.com",
        "",
        "bad host",
    ],
)
def test_default_host_policy_rejects_public_names(host):
    assert not HostPolicy.from_env(None).allows(host)


def test_allowed_hosts_env_extends_the_defaults():
    policy = HostPolicy.from_env("horde.example.com, *.corp.example ,203.0.113.9")

    assert policy.allows("horde.example.com")
    assert policy.allows("horde.example.com:8443")
    assert policy.allows("a.corp.example")
    assert policy.allows("203.0.113.9")
    assert policy.allows("truenas")
    assert not policy.allows("corp.example")
    assert not policy.allows("evil.com")


def test_allowed_hosts_star_disables_the_check():
    assert HostPolicy.from_env("*").allows("anything.example.org")


def test_unexpected_host_gets_400_naming_the_env_var(raw_client):
    resp = raw_client.get("/api/health", headers={"Host": "rebind.attacker.example"})

    assert resp.status_code == 400
    assert "HORDE_ALLOWED_HOSTS" in resp.json()["detail"]
    # Rejections still carry the security headers.
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_host_allowlist_applies_to_every_route(client):
    for path in ("/api/health", "/api/videos", "/api/thumbnails/1"):
        resp = client.get(path, headers={"Host": "evil.example"})
        assert resp.status_code == 400, path


def test_env_hosts_are_honoured_by_install_security(monkeypatch):
    monkeypatch.setenv("HORDE_ALLOWED_HOSTS", "horde.example.com")
    app = FastAPI()
    app.add_api_route("/x", lambda: {"ok": True}, methods=["GET"])
    install_security(app)

    with TestClient(app) as c:
        assert c.get("/x", headers={"Host": "horde.example.com"}).status_code == 200
        assert c.get("/x", headers={"Host": "other.example.com"}).status_code == 400


# --- CSRF ----------------------------------------------------------------------


def test_mutation_without_the_header_is_refused(raw_client):
    resp = raw_client.post("/api/downloads/queue/pause")

    assert resp.status_code == 403
    assert "X-Horde-Request" in resp.json()["detail"]


def test_simple_cross_site_post_without_content_type_is_refused(raw_client):
    """The attack from the review: a no-preflight POST whose body is sent bare."""
    resp = raw_client.post(
        "/api/setup/reset",
        content=b'{"erase_media": true}',
        headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    )

    assert resp.status_code == 403


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_every_unsafe_method_needs_the_header(raw_client, method):
    resp = raw_client.request(method, "/api/videos/1")

    assert resp.status_code == 403


def test_mutation_with_the_header_goes_through(raw_client):
    resp = raw_client.post("/api/downloads/queue/pause", headers=CSRF)

    assert resp.status_code == 200


def test_safe_methods_do_not_need_the_header(raw_client):
    assert raw_client.get("/api/health").status_code == 200
    assert raw_client.head("/api/health").status_code in (200, 405)


def test_cross_site_fetch_metadata_is_refused_even_with_the_header(raw_client):
    resp = raw_client.post(
        "/api/downloads/queue/pause",
        headers={**CSRF, "Sec-Fetch-Site": "cross-site"},
    )

    assert resp.status_code == 403
    for ok in ("same-origin", "same-site", "none"):
        resp = raw_client.post(
            "/api/downloads/queue/pause", headers={**CSRF, "Sec-Fetch-Site": ok}
        )
        assert resp.status_code == 200, ok


def test_origin_must_match_the_requested_host(raw_client):
    bad = raw_client.post(
        "/api/downloads/queue/pause",
        headers={**CSRF, "Origin": "https://evil.example"},
    )
    null = raw_client.post(
        "/api/downloads/queue/pause", headers={**CSRF, "Origin": "null"}
    )
    good = raw_client.post(
        "/api/downloads/queue/pause",
        headers={**CSRF, "Origin": "http://testserver"},
    )
    proxied = raw_client.post(
        "/api/downloads/queue/pause",
        headers={
            **CSRF,
            "Origin": "https://horde.example.com",
            "X-Forwarded-Host": "horde.example.com",
        },
    )

    assert bad.status_code == 403
    assert null.status_code == 403
    assert good.status_code == 200
    assert proxied.status_code == 200


# --- CORS only on media routes ---------------------------------------------------


def test_cors_is_sent_on_media_routes_only(client, add_video):
    video = add_video(write_file=True)
    origin = {"Origin": "https://www.gstatic.com"}
    media = [
        f"/api/videos/{video.id}/stream",
        f"/api/videos/{video.id}/stream?rendition=compat",
        f"/api/videos/{video.id}/subtitles/en",
        f"/api/thumbnails/{video.id}",
    ]
    for path in media:
        resp = client.get(path, headers=origin)
        assert resp.headers.get("access-control-allow-origin") == "*", path
        assert "Content-Range" in resp.headers["access-control-expose-headers"]

    others = [
        "/api/videos",
        f"/api/videos/{video.id}",
        f"/api/videos/{video.id}/file",
        "/api/health",
        "/api/settings",
        "/api/fonts",
        "/api/downloads",
    ]
    for path in others:
        resp = client.get(path, headers=origin)
        assert "access-control-allow-origin" not in resp.headers, path
        assert "access-control-expose-headers" not in resp.headers, path


def test_media_preflight_allows_get_with_range_only(client, add_video):
    video = add_video(write_file=True)

    resp = client.options(
        f"/api/videos/{video.id}/stream",
        headers={
            "Origin": "https://www.gstatic.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "range",
        },
    )

    assert resp.status_code == 204
    assert resp.headers["access-control-allow-origin"] == "*"
    assert resp.headers["access-control-allow-methods"] == "GET, HEAD, OPTIONS"
    assert "Range" in resp.headers["access-control-allow-headers"]


def test_other_routes_never_answer_a_preflight(client):
    for path in ("/api/setup/reset", "/api/videos/1", "/api/downloads"):
        resp = client.options(
            path,
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-horde-request,content-type",
            },
        )
        assert "access-control-allow-origin" not in resp.headers, path
        assert "access-control-allow-headers" not in resp.headers, path


def test_post_responses_carry_no_cors_headers(client):
    resp = client.post(
        "/api/downloads/queue/pause", headers={"Origin": "http://testserver"}
    )

    assert resp.status_code == 200
    assert "access-control-allow-origin" not in resp.headers


# --- Security headers -------------------------------------------------------------


def test_security_headers_on_every_response(client):
    for path in ("/api/health", "/api/videos/999999", "/api/health"):
        resp = client.get(path)
        csp = resp.headers["content-security-policy"]
        assert "frame-ancestors 'self'" in csp
        assert "default-src 'self'" in csp
        assert "object-src 'none'" in csp
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert resp.headers["referrer-policy"] == "same-origin"
        assert resp.headers["x-frame-options"] == "SAMEORIGIN"


def test_app_csp_lists_only_the_origins_the_app_loads():
    csp = security.content_security_policy("/")

    assert "script-src 'self' https://www.gstatic.com" in csp
    assert "https://sponsor.ajay.app" in csp
    assert "https://fonts.googleapis.com" in csp
    assert "'unsafe-eval'" not in csp
    script_src = next(p for p in csp.split("; ") if p.startswith("script-src"))
    assert "'unsafe-inline'" not in script_src


def test_wiki_gets_its_own_policy():
    assert security.content_security_policy("/wiki/") == security.WIKI_CSP
    assert security.content_security_policy("/wiki") == security.WIKI_CSP
    assert security.content_security_policy("/wikipedia") == security.APP_CSP
    assert "'unsafe-inline'" in security.WIKI_CSP.split("script-src")[1].split(";")[0]


# --- Factory reset confirmation ------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"erase_media": True},
        {"erase_media": True, "confirm": "RESET"},
        {"erase_media": False, "confirm": "ERASE MEDIA"},
        {"erase_media": False, "confirm": "reset"},
    ],
)
def test_reset_needs_the_typed_confirmation(client, add_video, body):
    video = add_video(write_file=True)

    resp = client.post("/api/setup/reset", json=body)

    assert resp.status_code == 400
    assert client.get(f"/api/videos/{video.id}").status_code == 200


# --- Request size limits -------------------------------------------------------------


def test_json_bodies_have_a_global_cap(client):
    big = "x" * (security.DEFAULT_BODY_LIMIT + 1)

    resp = client.post("/api/playlists", json={"name": big})

    assert resp.status_code == 413


def test_chunked_body_without_length_is_capped_too(client, monkeypatch):
    monkeypatch.setattr(security, "DEFAULT_BODY_LIMIT", 1000)

    def chunks():
        for _ in range(10):
            yield b'{"name": "' + b"a" * 400 + b'"}'

    resp = client.post(
        "/api/playlists", content=chunks(), headers={"Content-Type": "application/json"}
    )

    assert resp.status_code == 413


def test_bulk_lists_are_bounded(client):
    ids = list(range(1001))

    assert (
        client.post("/api/videos/bulk-delete", json={"video_ids": ids}).status_code
        == 422
    )
    assert (
        client.patch(
            "/api/videos/bulk-notes", json={"video_ids": ids, "notes": "n"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/downloads/bulk", json={"urls": ["https://e.com"] * 1001}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/playlists/estimate", json={"urls": ["https://e.com"] * 1001}
        ).status_code
        == 422
    )


# --- Download progress stream --------------------------------------------------------


def test_job_events_for_unknown_job_is_404(client):
    assert client.get("/api/downloads/987654/events").status_code == 404


def test_job_events_closes_for_a_finished_job(client, session, monkeypatch):
    from app.models import DownloadJob, JobStatus
    from app.services import downloader

    # Other tests leave snapshots behind in the process-wide store.
    monkeypatch.setattr(downloader, "progress_store", {})

    job = DownloadJob(url="https://example.com/v", status=JobStatus.completed)
    session.add(job)
    session.commit()
    session.refresh(job)

    resp = client.get(f"/api/downloads/{job.id}/events")

    assert resp.status_code == 200
    assert '"status": "completed"' in resp.text


# --- Resource limits -------------------------------------------------------------------


def test_preview_extraction_times_out_instead_of_hanging(client, app, monkeypatch):
    import time

    from app.services import downloader
    from app.services.limits import ExtractionGate

    app.state.extraction_gate = ExtractionGate(1, wait_sec=0.05, timeout_sec=0.1)
    monkeypatch.setattr(downloader, "extract_preview", lambda *_a: time.sleep(0.5))

    slow = client.get("/api/downloads/preview", params={"url": "https://example.com/v"})
    busy = client.get("/api/downloads/preview", params={"url": "https://example.com/w"})

    assert slow.status_code == 504
    # The timed-out read still holds the only slot, so the next caller is told to wait.
    assert busy.status_code == 429


def test_thumbnail_candidate_grabs_are_capped(client, app, add_video):
    from app.services.limits import ConcurrencyLimit

    video = add_video(write_file=True)
    app.state.thumbnail_grab_limit = ConcurrencyLimit("thumbnail grabs", 1, 0.05)

    with app.state.thumbnail_grab_limit.slot():
        resp = client.post(f"/api/videos/{video.id}/thumbnail/candidates")

    assert resp.status_code == 429


# --- Path containment ---------------------------------------------------------------------


def test_thumbnail_outside_the_thumbnail_dir_is_not_served(
    client, add_video, session, tmp_path
):
    secret = tmp_path / "secret.jpg"
    secret.write_bytes(b"not for you")
    video = add_video()
    video.thumbnail_path = str(secret)
    session.add(video)
    session.commit()

    assert client.get(f"/api/thumbnails/{video.id}").status_code == 404


def test_production_app_installs_the_stack_in_order():
    from app.main import app as production_app

    installed = [m.cls for m in production_app.user_middleware]
    expected = [s.cls for s in security.build_stack(HostPolicy())]
    assert installed == expected

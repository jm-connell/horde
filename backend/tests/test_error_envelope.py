"""Every error response has the same body: ``{"detail", "code", ...}``."""

from __future__ import annotations

import logging

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.errors import CodedHTTPException


def test_unknown_route_is_a_coded_404(client):
    resp = client.get("/api/definitely-not-a-route")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not Found", "code": "not_found"}


def test_wrong_method_is_a_coded_405(client):
    resp = client.put("/api/ping")
    assert resp.status_code == 405
    assert resp.json()["code"] == "method_not_allowed"


def test_plain_http_exception_gets_a_code_from_its_status(client):
    resp = client.get("/api/videos/999999")
    assert resp.status_code == 404
    body = resp.json()
    assert isinstance(body["detail"], str)
    assert body["code"] == "not_found"


def test_validation_error_lists_fields_and_reads_as_a_sentence(client):
    resp = client.post("/api/downloads", json={})
    assert resp.status_code == 422
    body = resp.json()
    assert body["code"] == "validation_error"
    assert body["fields"] == [{"loc": ["body", "url"], "msg": "Field required"}]
    assert body["detail"] == "url: Field required"


def test_path_validation_error(client):
    resp = client.get("/api/videos/not-a-number")
    assert resp.status_code == 422
    body = resp.json()
    assert body["fields"][0]["loc"] == ["path", "video_id"]
    assert body["detail"].startswith("video_id: ")


def test_duplicate_download_names_the_reason_in_code(client, monkeypatch):
    from app.services.downloads import jobs

    monkeypatch.setattr(
        jobs, "classify_enqueue_duplicate", lambda s, u: ("already_queued", 1)
    )
    resp = client.post("/api/downloads", json={"url": "https://example.com/v"})
    assert resp.status_code == 409
    body = resp.json()
    assert body["code"] == "already_queued"
    assert isinstance(body["detail"], str)


def test_auth_and_csrf_rejections_use_the_envelope(app, init_db):
    anonymous = TestClient(app)
    resp = anonymous.get("/api/videos")
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Sign in to continue", "code": "auth_required"}

    resp = anonymous.post("/api/downloads", json={})
    assert resp.status_code == 403
    assert resp.json()["code"] == "csrf_rejected"


def test_host_rejection_has_a_code(app):
    resp = TestClient(app, headers={"Host": "evil.example.com"}).get("/api/ping")
    assert resp.status_code == 400
    assert resp.json()["code"] == "host_not_allowed"


def test_coded_exception_carries_extra(app, client):
    def boom():
        raise CodedHTTPException(
            400, "Could not read link", "extract_failed", extra={"error_kind": "pot"}
        )

    app.add_api_route("/api/_test/coded", boom, methods=["GET"])
    resp = client.get("/api/_test/coded")
    assert resp.json() == {
        "detail": "Could not read link",
        "code": "extract_failed",
        "extra": {"error_kind": "pot"},
    }


def test_plain_exception_with_dict_detail_still_yields_a_string(app, client):
    def boom():
        raise HTTPException(400, detail={"message": "old style", "x": 1})

    app.add_api_route("/api/_test/dict", boom, methods=["GET"])
    resp = client.get("/api/_test/dict")
    assert resp.json()["detail"] == "old style"


def test_unhandled_error_is_a_generic_500_with_the_request_id(
    app, init_db, admin_user, caplog
):
    def boom():
        raise RuntimeError("secret internal detail")

    app.add_api_route("/api/_test/boom", boom, methods=["GET"])
    from tests.conftest import _session_cookie

    caller = TestClient(
        app,
        raise_server_exceptions=False,
        cookies=_session_cookie(init_db, admin_user),
    )
    with caplog.at_level(logging.ERROR, logger="app.errors"):
        resp = caller.get("/api/_test/boom", headers={"X-Request-ID": "req-abc123"})
    assert resp.status_code == 500
    body = resp.json()
    assert body["code"] == "internal_error"
    assert body["request_id"] == "req-abc123"
    assert resp.headers["X-Request-ID"] == "req-abc123"
    assert "secret internal detail" not in resp.text
    # Sent outside the security-headers middleware, so the handler adds them.
    normal = caller.get("/api/ping")
    for name in (
        "Content-Security-Policy",
        "X-Content-Type-Options",
        "Referrer-Policy",
        "X-Frame-Options",
    ):
        assert resp.headers[name] == normal.headers[name]
    logged = [r for r in caplog.records if r.name == "app.errors"]
    assert logged and logged[0].exc_info is not None

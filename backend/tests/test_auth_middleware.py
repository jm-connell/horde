"""AuthMiddleware: deny by default, public allowlist, sessions, proxy mode."""

from __future__ import annotations

import re
from datetime import timedelta

import pytest
from fastapi.routing import APIRoute, iter_route_contexts
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.auth import PUBLIC_ROUTES
from app.models import UserSession, utcnow
from app.security import install_security
from app.services.auth import accounts
from app.services.auth.runtime import AuthConfig

#: The complete list of routes a signed-out caller may use. Adding to it is a
#: security decision: keep this copy in the test so it cannot grow unnoticed.
EXPECTED_PUBLIC = {
    ("GET", "/api/ping"),
    ("GET", "/api/ready"),
    ("GET", "/api/health"),
    ("GET", "/api/auth/state"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/bootstrap"),
}


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)


def _api_routes(app):
    # Routers are included lazily, so ask FastAPI for the effective routes.
    for route in iter_route_contexts(app.routes):
        if isinstance(route.original_route, APIRoute) and route.path.startswith("/api"):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                yield method, route.path


def test_public_allowlist_is_exactly_the_documented_one():
    assert PUBLIC_ROUTES == EXPECTED_PUBLIC


def test_every_other_api_route_is_401_when_signed_out(app, anon_client):
    checked = 0
    for method, path in _api_routes(app):
        if (method, path) in EXPECTED_PUBLIC:
            continue
        resp = anon_client.request(method, _concrete(path))
        assert resp.status_code == 401, f"{method} {path} answered {resp.status_code}"
        assert resp.json() == {
            "detail": "Sign in to continue",
            "code": "auth_required",
        }
        checked += 1
    assert checked > 100


@pytest.mark.parametrize(
    "path", ["/api/no-such-route", "/docs", "/redoc", "/openapi.json"]
)
def test_unknown_api_paths_and_docs_are_protected(anon_client, path):
    assert anon_client.get(path).status_code == 401


def test_docs_open_for_a_signed_in_user(client):
    assert client.get("/openapi.json").status_code == 200


def test_public_routes_answer_without_a_session(anon_client):
    assert anon_client.get("/api/health").status_code == 200


def test_a_bad_cookie_is_the_same_as_none(app, init_db, admin_user):
    with TestClient(app, cookies={accounts.SESSION_COOKIE: "forged"}) as c:
        assert c.get("/api/videos").status_code == 401


def test_expired_session_is_refused(app, init_db, admin_user):
    with Session(init_db["engine"]) as s:
        token = accounts.start_session(
            s, admin_user, now=utcnow() - accounts.SESSION_TTL - timedelta(days=1)
        )
    with TestClient(app, cookies={accounts.SESSION_COOKIE: token}) as c:
        assert c.get("/api/videos").status_code == 401


def test_a_session_slides_while_in_use(app, init_db, admin_user):
    with Session(init_db["engine"]) as s:
        token = accounts.start_session(s, admin_user, now=utcnow() - timedelta(days=29))
    with TestClient(app, cookies={accounts.SESSION_COOKIE: token}) as c:
        assert c.get("/api/videos").status_code == 200
    with Session(init_db["engine"]) as s:
        row = s.exec(select(UserSession)).one()
        assert accounts.as_utc(row.expires_at) > utcnow() + timedelta(days=29)


def test_disabling_a_user_cuts_off_their_session_at_once(
    client, member_client, init_db, member_user
):
    assert member_client.get("/api/videos").status_code == 200
    with Session(init_db["engine"]) as s:
        accounts.update_user(s, member_user.id, disabled=True)
    assert member_client.get("/api/videos").status_code == 401


# --- HORDE_AUTH_DISABLED -----------------------------------------------------


def _proxy_app(app_factory_config: AuthConfig, init_db):
    from fastapi import FastAPI

    from app.api import videos

    proxied = FastAPI()
    proxied.include_router(videos.router)
    install_security(proxied, auth_config=app_factory_config)
    return proxied


def test_disabled_mode_runs_as_the_first_admin(init_db, admin_user):
    proxied = _proxy_app(AuthConfig(disabled=True), init_db)
    with TestClient(proxied) as c:
        assert c.get("/api/videos").status_code == 200


def test_disabled_mode_creates_an_admin_on_an_empty_install(init_db):
    proxied = _proxy_app(AuthConfig(disabled=True), init_db)
    with TestClient(proxied) as c:
        assert c.get("/api/videos").status_code == 200
    with Session(init_db["engine"]) as s:
        users = accounts.list_users(s)
        assert [(u.username, u.is_admin) for u in users] == [("admin", True)]


def test_trusted_header_picks_the_account_only_behind_a_trusted_proxy(
    init_db, admin_user
):
    with Session(init_db["engine"]) as s:
        accounts.create_user(s, "kid", "password-two")
    cfg = AuthConfig(disabled=True, trust_proxy=True, trusted_user_header="x-user")
    with TestClient(_proxy_app(cfg, init_db)) as c:
        assert c.get("/api/videos", headers={"X-User": "KID"}).status_code == 200
        assert c.get("/api/videos", headers={"X-User": "ghost"}).status_code == 401
        # The proxy is expected to always send the header; absent means bypassed.
        assert c.get("/api/videos").status_code == 401
    untrusted = AuthConfig(
        disabled=True, trust_proxy=False, trusted_user_header="x-user"
    )
    with TestClient(_proxy_app(untrusted, init_db)) as c:
        # Without HORDE_TRUST_PROXY the header is ignored and the admin is used.
        assert c.get("/api/videos", headers={"X-User": "ghost"}).status_code == 200

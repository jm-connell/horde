"""Sign-in, bootstrap, sessions, user management, signed media URLs."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.models import UserSettings, UserVideoState, VideoAiChatMessage
from app.services.auth import accounts, media_token
from app.services.auth.limiter import FREE_ATTEMPTS

CSRF = {"X-Horde-Request": "1"}


@pytest.fixture
def fresh_client(app, init_db):
    """A server nobody has set up yet: no users."""
    with TestClient(app, headers=CSRF) as c:
        yield c


def _login(c: TestClient, username="admin", password="admin-password"):  # noqa: S107 - fixture credentials
    return c.post("/api/auth/login", json={"username": username, "password": password})


# --- state and bootstrap -----------------------------------------------------


def test_state_for_an_empty_server(fresh_client):
    assert fresh_client.get("/api/auth/state").json() == {
        "users_exist": False,
        "authenticated": False,
        "user": None,
        "setup_completed": False,
    }


def test_state_for_anonymous_and_signed_in(anon_client, client):
    anon = anon_client.get("/api/auth/state").json()
    assert (anon["users_exist"], anon["authenticated"], anon["user"]) == (
        True,
        False,
        None,
    )
    me = client.get("/api/auth/state").json()
    assert me["authenticated"] is True
    assert (me["user"]["username"], me["user"]["is_admin"]) == ("admin", True)


def test_bootstrap_creates_the_admin_once_and_signs_in(fresh_client):
    resp = fresh_client.post(
        "/api/auth/bootstrap", json={"username": "Owner", "password": "first-password"}
    )
    assert resp.status_code == 200
    assert resp.json()["user"]["is_admin"] is True
    assert fresh_client.get("/api/videos").status_code == 200  # cookie is set

    again = fresh_client.post(
        "/api/auth/bootstrap", json={"username": "other", "password": "second-password"}
    )
    assert (again.status_code, again.json()["code"]) == (409, "already_bootstrapped")


def test_bootstrap_validates_the_password(fresh_client):
    resp = fresh_client.post(
        "/api/auth/bootstrap", json={"username": "owner", "password": "short"}
    )
    assert (resp.status_code, resp.json()["code"]) == (400, "weak_password")
    same = fresh_client.post(
        "/api/auth/bootstrap", json={"username": "samename1", "password": "samename1"}
    )
    assert same.status_code == 400


def test_bootstrap_moves_legacy_history_settings_and_chat_to_the_admin(
    fresh_client, init_db, add_video
):
    from app.services import app_settings

    app_settings.save({"ui": {"theme": "oled"}})
    watched = add_video(
        title="Seen",
        last_position_sec=33.0,
        last_watched_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    add_video(title="Unseen")
    with Session(init_db["engine"]) as s:
        s.add(
            VideoAiChatMessage(video_id=watched.id, role="user", content="old question")
        )
        s.commit()

    assert (
        fresh_client.post(
            "/api/auth/bootstrap",
            json={"username": "owner", "password": "first-password"},
        ).status_code
        == 200
    )

    row = next(
        r
        for r in fresh_client.get("/api/videos").json()["items"]
        if r["id"] == watched.id
    )
    assert row["last_position_sec"] == 33.0
    assert fresh_client.get("/api/settings").json()["ui"]["theme"] == "oled"
    chat = fresh_client.get(f"/api/videos/{watched.id}/ai/chat").json()["messages"]
    assert [m["content"] for m in chat] == ["old question"]
    with Session(init_db["engine"]) as s:
        assert len(s.exec(select(UserVideoState)).all()) == 1
        assert s.exec(select(UserSettings)).one().user_id == 1


# --- sign in / out -----------------------------------------------------------


def test_login_sets_a_hardened_session_cookie(anon_client, admin_user):
    resp = _login(anon_client)
    assert resp.status_code == 200
    cookie = resp.headers["set-cookie"].lower()
    assert "horde_session=" in cookie
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie
    assert "secure" not in cookie  # plain http
    assert anon_client.get("/api/videos").status_code == 200


def test_login_is_case_insensitive_on_the_name(anon_client, admin_user):
    assert _login(anon_client, "ADMIN").status_code == 200


def test_cookie_is_secure_over_https(app, admin_user):
    with TestClient(app, headers=CSRF, base_url="https://testserver") as c:
        assert "secure" in _login(c).headers["set-cookie"].lower()


def test_forwarded_proto_is_ignored_without_trust_proxy(anon_client, admin_user):
    resp = anon_client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin-password"},
        headers={"X-Forwarded-Proto": "https"},
    )
    assert "secure" not in resp.headers["set-cookie"].lower()


def test_wrong_password_and_unknown_user_look_the_same(anon_client, admin_user):
    wrong = _login(anon_client, "admin", "nope-nope-nope")
    unknown = _login(anon_client, "ghost", "nope-nope-nope")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()
    assert wrong.json()["code"] == "invalid_credentials"
    assert "set-cookie" not in wrong.headers


def test_failed_logins_are_rate_limited_with_retry_after(anon_client, admin_user):
    for _ in range(FREE_ATTEMPTS):
        assert _login(anon_client, "admin", "wrong-password").status_code == 401
    blocked = _login(anon_client, "admin", "wrong-password")
    assert blocked.status_code == 429
    assert blocked.json()["code"] == "rate_limited"
    assert int(blocked.headers["retry-after"]) > 0
    # Even the right password waits its turn; another name is not affected.
    assert _login(anon_client, "admin", "admin-password").status_code == 429
    assert _login(anon_client, "someone", "wrong-password").status_code == 401


def test_a_successful_login_resets_the_counter(anon_client, admin_user):
    for _ in range(FREE_ATTEMPTS - 1):
        _login(anon_client, "admin", "wrong-password")
    assert _login(anon_client).status_code == 200
    for _ in range(FREE_ATTEMPTS - 1):
        assert _login(anon_client, "admin", "wrong-password").status_code == 401


def test_disabled_account_cannot_sign_in(anon_client, client, member_user):
    client.patch(f"/api/users/{member_user.id}", json={"disabled": True})
    assert _login(anon_client, "member", "member-password").status_code == 401


def test_logout_ends_only_this_session(app, init_db, admin_user, client):
    other = TestClient(app, headers=CSRF)
    assert _login(other).status_code == 200
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/videos").status_code == 401
    assert other.get("/api/videos").status_code == 200
    other.close()


def test_logout_requires_a_session(anon_client):
    assert anon_client.post("/api/auth/logout").status_code == 401


# --- own password ------------------------------------------------------------


def test_changing_your_password_signs_out_your_other_browsers(app, client, init_db):
    other = TestClient(app, headers=CSRF)
    _login(other)
    bad = client.post(
        "/api/auth/password",
        json={"current_password": "wrong-password", "new_password": "brand-new-pass"},
    )
    assert (bad.status_code, bad.json()["code"]) == (400, "wrong_password")
    ok = client.post(
        "/api/auth/password",
        json={"current_password": "admin-password", "new_password": "brand-new-pass"},
    )
    assert ok.status_code == 204
    assert client.get("/api/videos").status_code == 200  # this browser stays in
    assert other.get("/api/videos").status_code == 401
    fresh = TestClient(app, headers=CSRF)
    assert _login(fresh, "admin", "admin-password").status_code == 401
    assert _login(fresh, "admin", "brand-new-pass").status_code == 200
    other.close()
    fresh.close()


def test_new_password_must_pass_the_policy(client):
    resp = client.post(
        "/api/auth/password",
        json={"current_password": "admin-password", "new_password": "short"},
    )
    assert (resp.status_code, resp.json()["code"]) == (400, "weak_password")


# --- health ------------------------------------------------------------------


def test_health_is_minimal_for_anonymous_callers(anon_client, client):
    anon = anon_client.get("/api/health").json()
    assert set(anon) == {"status", "setup_required", "auth_required"}
    assert anon["auth_required"] is True
    full = client.get("/api/health").json()
    assert "library_video_count" in full and "disk" in full


# --- user management ---------------------------------------------------------


def test_admin_manages_users(client, anon_client, init_db):
    created = client.post(
        "/api/users",
        json={"username": "Kid", "password": "kid-password", "permissions": ["use_ai"]},
    )
    assert created.status_code == 201
    uid = created.json()["id"]
    assert created.json()["permissions"] == ["use_ai"]

    dup = client.post(
        "/api/users", json={"username": "kid", "password": "kid-password"}
    )
    assert (dup.status_code, dup.json()["code"]) == (409, "username_taken")

    assert _login(anon_client, "kid", "kid-password").status_code == 200
    reset = client.patch(f"/api/users/{uid}", json={"password": "kid-password-2"})
    assert reset.status_code == 200
    assert anon_client.get("/api/videos").status_code == 401  # their session ended
    assert _login(anon_client, "kid", "kid-password-2").status_code == 200

    assert client.patch(f"/api/users/{uid}", json={"is_admin": True}).json()["is_admin"]
    listed = {u["username"]: u for u in client.get("/api/users").json()}
    assert set(listed) == {"admin", "Kid"}
    assert client.delete(f"/api/users/{uid}").status_code == 204
    assert anon_client.get("/api/videos").status_code == 401
    assert client.patch("/api/users/999", json={"disabled": True}).status_code == 404


def test_last_admin_cannot_be_removed_through_the_api(client, admin_user):
    for call in (
        client.patch(f"/api/users/{admin_user.id}", json={"is_admin": False}),
        client.patch(f"/api/users/{admin_user.id}", json={"disabled": True}),
    ):
        assert (call.status_code, call.json()["code"]) == (409, "self_lockout")
    call = client.delete(f"/api/users/{admin_user.id}")
    assert (call.status_code, call.json()["code"]) == (409, "last_admin")
    assert client.get("/api/videos").status_code == 200


def test_an_admin_cannot_demote_or_disable_themselves(client, admin_user):
    other = client.post(
        "/api/users",
        json={"username": "other", "password": "other-password", "is_admin": True},
    ).json()
    for body in ({"is_admin": False}, {"disabled": True}):
        call = client.patch(f"/api/users/{admin_user.id}", json=body)
        assert (call.status_code, call.json()["code"]) == (409, "self_lockout")
    me = next(u for u in client.get("/api/users").json() if u["id"] == admin_user.id)
    assert me["is_admin"] and not me["disabled"]
    # Harmless self edits and changes to another admin still go through.
    assert (
        client.patch(
            f"/api/users/{admin_user.id}", json={"is_admin": True, "disabled": False}
        ).status_code
        == 200
    )
    demoted = client.patch(f"/api/users/{other['id']}", json={"is_admin": False})
    assert demoted.status_code == 200 and not demoted.json()["is_admin"]


def test_members_cannot_manage_users(member_client):
    assert member_client.get("/api/users").status_code == 403
    assert (
        member_client.post(
            "/api/users", json={"username": "x", "password": "password-x"}
        ).status_code
        == 403
    )


# --- AI chat is per user -----------------------------------------------------


def test_chat_history_is_private_to_each_user(
    client, member_client, add_video, init_db, admin_user, member_user
):
    video = add_video()
    with Session(init_db["engine"]) as s:
        s.add(
            VideoAiChatMessage(
                video_id=video.id,
                user_id=admin_user.id,
                role="user",
                content="admin asks",
            )
        )
        s.add(
            VideoAiChatMessage(
                video_id=video.id,
                user_id=member_user.id,
                role="user",
                content="member asks",
            )
        )
        s.commit()
    path = f"/api/videos/{video.id}/ai/chat"
    assert [m["content"] for m in client.get(path).json()["messages"]] == ["admin asks"]
    assert [m["content"] for m in member_client.get(path).json()["messages"]] == [
        "member asks"
    ]
    assert member_client.delete(path).status_code == 200
    assert member_client.get(path).json()["messages"] == []
    assert len(client.get(path).json()["messages"]) == 1


# --- signed media URLs -------------------------------------------------------


@pytest.fixture
def media(app, add_video, client, anon_client, admin_user):
    video = add_video(write_file=True, file_bytes=b"0123456789" * 40)
    other = add_video(write_file=True)
    token = client.get(f"/api/videos/{video.id}/media-token").json()["token"]
    return type(
        "Media",
        (),
        {
            "video": video,
            "other": other,
            "token": token,
            "secret": app.state.auth.secret(),
            "user": admin_user,
            "epoch": media_token.token_epoch(admin_user.password_hash),
        },
    )


def test_media_token_endpoint_shape(client, add_video):
    video = add_video()
    body = client.get(f"/api/videos/{video.id}/media-token").json()
    assert set(body) == {"token", "expires_at"}
    expires = datetime.fromisoformat(body["expires_at"].replace("Z", "+00:00"))
    assert timedelta(hours=11) < expires - datetime.now(UTC) <= timedelta(hours=12)
    assert client.get("/api/videos/999/media-token").status_code == 404


def test_media_token_needs_a_session_to_mint(anon_client, add_video):
    video = add_video()
    assert anon_client.get(f"/api/videos/{video.id}/media-token").status_code == 401


def test_a_valid_token_streams_without_a_cookie(anon_client, media):
    url = f"/api/videos/{media.video.id}/stream"
    assert anon_client.get(url).status_code == 401
    resp = anon_client.get(url, params={"mt": media.token})
    assert resp.status_code in (200, 206)
    assert resp.content.startswith(b"0123456789")
    ranged = anon_client.get(
        url, params={"mt": media.token}, headers={"Range": "bytes=0-9"}
    )
    assert ranged.status_code == 206


def test_token_for_one_video_is_refused_for_another(anon_client, media):
    resp = anon_client.get(
        f"/api/videos/{media.other.id}/stream", params={"mt": media.token}
    )
    assert resp.status_code == 401


def test_tampered_and_expired_tokens_are_refused(anon_client, media):
    url = f"/api/videos/{media.video.id}/stream"
    expiry, uid, mac = media.token.split(".")
    for bad in (
        f"{expiry}.{uid}.{'0' * len(mac)}",
        f"{int(expiry) + 3600}.{uid}.{mac}",
        f"{expiry}.{int(uid) + 1}.{mac}",
        "garbage",
        "",
    ):
        assert anon_client.get(url, params={"mt": bad}).status_code == 401, bad
    old, _ = media_token.sign(
        media.secret,
        media.video.id,
        media.user.id,
        media.epoch,
        datetime.now(UTC) - timedelta(hours=13),
    )
    assert anon_client.get(url, params={"mt": old}).status_code == 401


def test_a_token_is_only_good_for_media_routes(anon_client, media):
    for path in (
        "/api/videos",
        f"/api/videos/{media.video.id}",
        f"/api/videos/{media.video.id}/file",
    ):
        assert anon_client.get(path, params={"mt": media.token}).status_code == 401, (
            path
        )
    assert (
        anon_client.get(
            f"/api/thumbnails/{media.video.id}", params={"mt": media.token}
        ).status_code
        != 401
    )
    assert (
        anon_client.get(
            f"/api/videos/{media.video.id}/subtitles/en", params={"mt": media.token}
        ).status_code
        == 404  # authorised, there just is no such track
    )


def test_a_token_stops_working_when_its_user_is_disabled(anon_client, media, init_db):
    with Session(init_db["engine"]) as s:
        viewer = accounts.create_user(s, "viewer", "viewer-password")
        token, _ = media_token.sign(
            media.secret,
            media.video.id,
            viewer.id,
            media_token.token_epoch(viewer.password_hash),
        )
        url = f"/api/videos/{media.video.id}/stream"
        assert anon_client.get(url, params={"mt": token}).status_code in (200, 206)
        accounts.update_user(s, viewer.id, disabled=True)
    assert anon_client.get(url, params={"mt": token}).status_code == 401


def test_secret_key_file_is_private(client, media, init_db):
    key = init_db["data"] / "secret_key"
    assert key.exists() and oct(key.stat().st_mode & 0o777) == "0o600"
    assert key.read_bytes() not in media.token.encode()


def test_a_spoofed_leftmost_forwarded_for_does_not_dodge_the_throttle(app, admin_user):
    from app.services.auth.runtime import AuthConfig

    app.state.auth.config = AuthConfig(trust_proxy=True)
    with TestClient(app, headers=CSRF) as c:
        statuses = [
            c.post(
                "/api/auth/login",
                json={"username": "admin", "password": "wrong-password"},
                # The proxy appends the real peer (10.0.0.9); the client invents the rest.
                headers={"X-Forwarded-For": f"203.0.113.{i}, 10.0.0.9"},
            ).status_code
            for i in range(FREE_ATTEMPTS + 1)
        ]
    assert statuses[:FREE_ATTEMPTS] == [401] * FREE_ATTEMPTS
    assert statuses[-1] == 429


def _forwarded_for(app, *lines: str, hops: int = 1) -> str:
    """``client_address`` for a request carrying one X-Forwarded-For header line per argument."""
    from starlette.requests import Request

    from app.services.auth.runtime import AuthConfig

    runtime = app.state.auth
    runtime.config = AuthConfig(trust_proxy=True, proxy_hops=hops)
    scope = {
        "type": "http",
        "headers": [(b"x-forwarded-for", line.encode()) for line in lines],
        "client": ("127.0.0.1", 1),
    }
    return runtime.client_address(Request(scope))


def test_proxy_hops_picks_the_entry_counted_from_the_right(app):
    assert _forwarded_for(app, "1.1.1.1, 2.2.2.2, 3.3.3.3", hops=2) == "2.2.2.2"


def test_a_proxy_that_adds_its_own_header_line_cannot_be_spoofed(app):
    """HAProxy ``option forwardfor`` adds a line; the client controls the first one."""
    assert _forwarded_for(app, "6.6.6.6", "203.0.113.50") == "203.0.113.50"
    assert _forwarded_for(app, "6.6.6.6, 7.7.7.7", "203.0.113.50", hops=2) == "7.7.7.7"
    # Lines are joined in order: the last entry of the last line is the nearest hop.
    assert _forwarded_for(app, "6.6.6.6", "7.7.7.7, 203.0.113.50") == "203.0.113.50"


@pytest.mark.parametrize(
    ("entry", "address"),
    [
        ("203.0.113.9:51234", "203.0.113.9"),
        ("[2001:db8::7]:443", "2001:db8::7"),
        ("[2001:db8::7]", "2001:db8::7"),
        ("2001:db8::7", "2001:db8::7"),
        ("203.0.113.9", "203.0.113.9"),
    ],
)
def test_ports_are_stripped_from_forwarded_addresses(app, entry, address):
    assert _forwarded_for(app, f"6.6.6.6, {entry}") == address


def test_non_ascii_token_is_a_401_not_a_500(anon_client, media):
    url = f"/api/videos/{media.video.id}/stream"
    expiry, uid, mac = media.token.split(".")
    for bad in (f"{expiry}.{uid}.\u00e9", f"{expiry}.{uid}.{mac[:-1]}\u00e9"):
        assert anon_client.get(url, params={"mt": bad}).status_code == 401


def test_resetting_the_password_voids_outstanding_tokens(anon_client, client, media):
    url = f"/api/videos/{media.video.id}/stream"
    assert anon_client.get(url, params={"mt": media.token}).status_code in (200, 206)
    # The admin changes their own password (keeping this browser signed in).
    client.post(
        "/api/auth/password",
        json={"current_password": "admin-password", "new_password": "another-password"},
    )
    assert anon_client.get(url, params={"mt": media.token}).status_code == 401
    fresh = client.get(f"/api/videos/{media.video.id}/media-token").json()["token"]
    assert anon_client.get(url, params={"mt": fresh}).status_code in (200, 206)


def test_websockets_on_protected_paths_are_closed(app, anon_client):
    import pytest
    from starlette.websockets import WebSocketDisconnect

    with (
        pytest.raises(WebSocketDisconnect),
        anon_client.websocket_connect("/api/anything"),
    ):
        pass


def test_current_password_guesses_are_throttled(client):
    body = {"current_password": "wrong-password", "new_password": "brand-new-pass"}
    codes = [
        client.post("/api/auth/password", json=body).status_code
        for _ in range(FREE_ATTEMPTS + 1)
    ]
    assert codes[:FREE_ATTEMPTS] == [400] * FREE_ATTEMPTS
    assert codes[-1] == 429
    # The right password is refused while locked, and sign-in is unaffected.
    good = {"current_password": "admin-password", "new_password": "brand-new-pass"}
    assert client.post("/api/auth/password", json=good).status_code == 429
    with TestClient(client.app, headers=CSRF) as other:
        assert _login(other).status_code == 200


def test_verify_password_confirms_the_signed_in_accounts_password(client):
    ok = client.post("/api/auth/verify-password", json={"password": "admin-password"})
    assert ok.status_code == 204
    bad = client.post("/api/auth/verify-password", json={"password": "nope"})
    assert (bad.status_code, bad.json()["code"]) == (400, "wrong_password")
    # Nothing changed: the same password still works to sign in.
    with TestClient(client.app, headers=CSRF) as other:
        assert _login(other).status_code == 200


def test_verify_password_guesses_share_the_password_throttle(client):
    for _ in range(FREE_ATTEMPTS):
        client.post("/api/auth/verify-password", json={"password": "x"})
    blocked = client.post(
        "/api/auth/verify-password", json={"password": "admin-password"}
    )
    assert (blocked.status_code, blocked.json()["code"]) == (429, "rate_limited")
    body = {"current_password": "admin-password", "new_password": "brand-new-pass"}
    assert client.post("/api/auth/password", json=body).status_code == 429


def test_verify_password_needs_a_session(anon_client):
    resp = anon_client.post("/api/auth/verify-password", json={"password": "x"})
    assert resp.status_code == 401


def test_an_admin_changing_their_own_password_stays_signed_in(app, client, admin_user):
    other = TestClient(app, headers=CSRF)
    _login(other)
    resp = client.post(
        "/api/auth/password",
        json={"current_password": "admin-password", "new_password": "my-new-password"},
    )
    assert resp.status_code == 204
    assert client.get("/api/videos").status_code == 200  # this browser stays in
    assert other.get("/api/videos").status_code == 401  # the others do not
    other.close()


def test_resetting_someone_elses_password_signs_them_out_not_you(
    client, member_client, member_user
):
    client.patch(
        f"/api/users/{member_user.id}", json={"password": "their-new-password"}
    )
    assert member_client.get("/api/videos").status_code == 401
    assert client.get("/api/videos").status_code == 200

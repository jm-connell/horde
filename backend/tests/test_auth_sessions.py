"""Signed-in devices: list, sign one out, sign out everywhere else."""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlmodel import Session

from app.models import UserSession, utcnow
from tests.conftest import ADMIN_PASSWORD, CSRF, MEMBER_PASSWORD

IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
)


def _sign_in(app, username: str, password: str, user_agent: str | None = None):
    headers = dict(CSRF)
    if user_agent:
        headers["user-agent"] = user_agent
    c = TestClient(app, headers=headers)
    c.__enter__()
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200
    return c


@pytest.fixture
def phone(app, admin_user):
    """A second browser of the administrator."""
    c = _sign_in(app, "admin", ADMIN_PASSWORD, IPHONE)
    yield c
    c.__exit__(None, None, None)


def _ids(client) -> list[dict]:
    return client.get("/api/auth/sessions").json()["items"]


def test_lists_only_your_sessions_and_marks_the_current_one(
    client, phone, member_client
):
    mine = _ids(client)
    assert len(mine) == 2
    assert [row["current"] for row in mine].count(True) == 1
    on_phone = next(row for row in mine if row["device"] == "Safari on iPhone")
    assert on_phone["current"] is False
    assert on_phone["user_agent"] == IPHONE
    assert on_phone["ip"]
    # The phone sees the same two, with itself current.
    from_phone = _ids(phone)
    assert {row["id"] for row in from_phone} == {row["id"] for row in mine}
    assert next(row for row in from_phone if row["current"])["id"] == on_phone["id"]
    # A member's sessions never show up in the administrator's list.
    assert len(_ids(member_client)) == 1
    assert {row["id"] for row in _ids(member_client)}.isdisjoint(
        {row["id"] for row in mine}
    )


def test_newest_activity_first_and_expired_sessions_are_hidden(client, phone, init_db):
    rows = _ids(client)
    on_phone = next(row for row in rows if not row["current"])
    with Session(init_db["engine"]) as s:
        s.execute(
            update(UserSession)
            .where(UserSession.id == on_phone["id"])
            .values(last_seen_at=utcnow() - timedelta(hours=3))
        )
        s.commit()
    rows = _ids(client)
    assert [row["current"] for row in rows] == [True, False]
    with Session(init_db["engine"]) as s:
        s.execute(
            update(UserSession)
            .where(UserSession.id == on_phone["id"])
            .values(expires_at=utcnow() - timedelta(minutes=1))
        )
        s.commit()
    assert [row["current"] for row in _ids(client)] == [True]


def test_revoking_another_session_signs_that_browser_out(client, phone):
    other = next(row for row in _ids(client) if not row["current"])
    assert phone.get("/api/videos").status_code == 200
    assert client.delete(f"/api/auth/sessions/{other['id']}").status_code == 204
    assert phone.get("/api/videos").status_code == 401
    assert client.get("/api/videos").status_code == 200  # this one is untouched
    assert len(_ids(client)) == 1


def test_revoking_your_own_current_session_signs_you_out(client):
    current = _ids(client)[0]
    resp = client.delete(f"/api/auth/sessions/{current['id']}")
    assert resp.status_code == 204
    assert "horde_session" in resp.headers.get("set-cookie", "")
    assert client.get("/api/videos").status_code == 401


def test_cannot_revoke_someone_elses_session(client, member_client):
    theirs = _ids(member_client)[0]
    resp = client.delete(f"/api/auth/sessions/{theirs['id']}")
    assert (resp.status_code, resp.json()["code"]) == (404, "session_not_found")
    assert member_client.get("/api/videos").status_code == 200
    # Same answer for an id that does not exist.
    assert client.delete("/api/auth/sessions/999999").status_code == 404


def test_revoke_others_keeps_the_current_session(client, phone, member_client):
    assert client.post("/api/auth/sessions/revoke-others").status_code == 204
    assert phone.get("/api/videos").status_code == 401
    assert client.get("/api/videos").status_code == 200
    assert [row["current"] for row in _ids(client)] == [True]
    assert member_client.get("/api/videos").status_code == 200  # other accounts stay


def test_sessions_need_a_sign_in(anon_client):
    assert anon_client.get("/api/auth/sessions").status_code == 401
    assert anon_client.delete("/api/auth/sessions/1").status_code == 401
    assert anon_client.post("/api/auth/sessions/revoke-others").status_code == 401


# --- administrators ------------------------------------------------------------


def test_admin_lists_and_ends_a_members_sessions(
    client, member_client, member_user, app
):
    second = _sign_in(app, "member", MEMBER_PASSWORD)
    try:
        rows = client.get(f"/api/users/{member_user.id}/sessions").json()["items"]
        assert len(rows) == 2
        assert not any(row["current"] for row in rows)  # none is the admin's browser
        resp = client.delete(f"/api/users/{member_user.id}/sessions/{rows[0]['id']}")
        assert resp.status_code == 204
        assert (
            len(client.get(f"/api/users/{member_user.id}/sessions").json()["items"])
            == 1
        )
        # Both of the member's browsers share the list: exactly one was signed out.
        statuses = sorted(
            c.get("/api/videos").status_code for c in (member_client, second)
        )
        assert statuses == [200, 401]
    finally:
        second.__exit__(None, None, None)


def test_admin_signs_a_member_out_everywhere(client, member_client, member_user):
    assert client.delete(f"/api/users/{member_user.id}/sessions").status_code == 204
    assert member_client.get("/api/videos").status_code == 401
    assert client.get(f"/api/users/{member_user.id}/sessions").json()["items"] == []
    assert client.get("/api/videos").status_code == 200


def test_admin_session_routes_check_the_user_and_the_owner(
    client, member_client, member_user, admin_user
):
    assert client.get("/api/users/9999/sessions").status_code == 404
    assert client.delete("/api/users/9999/sessions").status_code == 404
    mine = _ids(client)[0]
    # The session exists, but not under that user.
    resp = client.delete(f"/api/users/{member_user.id}/sessions/{mine['id']}")
    assert (resp.status_code, resp.json()["code"]) == (404, "session_not_found")
    assert client.get("/api/videos").status_code == 200


def test_members_cannot_use_the_admin_session_routes(
    member_client, member_user, admin_user
):
    assert member_client.get(f"/api/users/{admin_user.id}/sessions").status_code == 403
    assert (
        member_client.delete(f"/api/users/{admin_user.id}/sessions").status_code == 403
    )
    assert (
        member_client.delete(f"/api/users/{admin_user.id}/sessions/1").status_code
        == 403
    )


def test_ending_a_session_through_the_api_removes_only_its_row(client, phone, init_db):
    other = next(row for row in _ids(client) if not row["current"])
    client.delete(f"/api/auth/sessions/{other['id']}")
    with Session(init_db["engine"]) as s:
        assert s.get(UserSession, other["id"]) is None
        assert s.get(UserSession, _ids(client)[0]["id"]) is not None


def test_throttle_keeps_last_seen_from_moving_on_every_request(client, init_db):
    before = _ids(client)[0]["last_seen_at"]
    for _ in range(3):
        client.get("/api/videos")
    assert _ids(client)[0]["last_seen_at"] == before

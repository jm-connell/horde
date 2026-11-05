"""Invite links: an administrator makes one, a new member joins with it once."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from sqlmodel import Session, select

from app.models import User, UserInvite, utcnow
from app.services.auth import accounts, invites


def _invite(client, **body) -> Any:
    res = client.post("/api/users/invites", json=body)
    assert res.status_code == 201, res.text
    return res.json()


NEW_PASSWORD = "new-password"


def _accept(anon_client, token: str, username="newbie", password=NEW_PASSWORD):
    return anon_client.post(
        "/api/auth/invite/accept",
        json={"token": token, "username": username, "password": password},
    )


def test_an_invite_makes_a_signed_in_member_with_the_chosen_permissions(
    client, anon_client, init_db
):
    made = _invite(client, label="Mum", permissions=["download"], days=3)
    token = made["token"]
    assert made["invite"]["label"] == "Mum"
    assert made["invite"]["permissions"] == ["download"]
    assert len(token) >= 32
    # Only its hash is stored.
    with Session(init_db["engine"]) as s:
        row = s.get(UserInvite, made["invite"]["id"])
        assert row is not None and token not in row.token_hash

    check = anon_client.post("/api/auth/invite/check", json={"token": token})
    assert check.status_code == 200
    assert check.json()["label"] == "Mum"

    res = _accept(anon_client, token)
    assert res.status_code == 200, res.text
    user = res.json()["user"]
    assert user["username"] == "newbie"
    assert user["is_admin"] is False
    assert user["permissions"] == ["download"]
    # The browser is signed in as the new member.
    me = anon_client.get("/api/auth/state").json()
    assert me["authenticated"] is True and me["user"]["username"] == "newbie"

    with Session(init_db["engine"]) as s:
        row = s.get(UserInvite, made["invite"]["id"])
        assert row is not None and row.used_at is not None
        new_user = accounts.get_by_username(s, "newbie")
        assert new_user is not None and row.used_by == new_user.id
    # A used invite is no longer pending.
    assert client.get("/api/users/invites").json() == []


def test_default_permissions_when_none_are_chosen(client, anon_client):
    token = _invite(client)["token"]
    user = _accept(anon_client, token).json()["user"]
    assert set(user["permissions"]) == set(accounts.permissions.DEFAULT_PERMISSIONS)


def test_an_invite_works_once(app, client, anon_client):
    from fastapi.testclient import TestClient

    token = _invite(client)["token"]
    assert _accept(anon_client, token).status_code == 200
    with TestClient(app, headers={"X-Horde-Request": "1"}) as other:
        again = _accept(other, token, username="second")
        assert again.status_code == 404
        assert again.json()["code"] == "invite_invalid"
        check = other.post("/api/auth/invite/check", json={"token": token})
        assert check.status_code == 404


def test_unknown_and_expired_tokens_are_refused(client, anon_client, init_db):
    assert _accept(anon_client, "not-a-real-token").json()["code"] == "invite_invalid"
    made = _invite(client)
    with Session(init_db["engine"]) as s:
        row = s.get(UserInvite, made["invite"]["id"])
        assert row is not None
        row.expires_at = utcnow() - timedelta(minutes=1)
        s.add(row)
        s.commit()
    assert _accept(anon_client, made["token"]).status_code == 404
    assert client.get("/api/users/invites").json() == []


def test_a_taken_username_or_empty_password_keeps_the_invite_usable(
    client, anon_client, admin_user
):
    token = _invite(client)["token"]
    taken = _accept(anon_client, token, username=admin_user.username)
    assert taken.status_code == 409
    assert taken.json()["code"] == "username_taken"
    empty = _accept(anon_client, token, password="")
    assert empty.status_code == 400
    assert _accept(anon_client, token).status_code == 200


def test_a_revoked_invite_stops_working(client, anon_client):
    made = _invite(client)
    assert (
        client.delete(f"/api/users/invites/{made['invite']['id']}").status_code == 204
    )
    assert _accept(anon_client, made["token"]).status_code == 404
    assert (
        client.delete(f"/api/users/invites/{made['invite']['id']}").status_code == 404
    )


def test_members_cannot_make_invites(member_client):
    assert member_client.post("/api/users/invites", json={}).status_code == 403


def test_unknown_permissions_are_refused(client):
    res = client.post("/api/users/invites", json={"permissions": ["rule_the_world"]})
    assert res.status_code == 400


def test_refused_when_sign_in_is_disabled(app, anon_client, client):
    from app.services.auth.runtime import AuthConfig

    token = _invite(client)["token"]
    app.state.auth.config = AuthConfig(disabled=True)
    for path in ("/api/auth/invite/check", "/api/auth/invite/accept"):
        res = anon_client.post(
            path, json={"token": token, "username": "x", "password": "y"}
        )
        assert res.json()["code"] == "auth_disabled", path


def test_redeem_claims_the_invite_before_making_the_account(init_db, admin_user):
    """Two requests with one token: the second finds the invite already claimed."""
    with Session(init_db["engine"]) as s:
        _, token = invites.create(s, admin_user.id, granted=None, label=None, days=1)
    with Session(init_db["engine"]) as first, Session(init_db["engine"]) as second:
        # Both looked the invite up before either claimed it.
        assert invites.find_valid(first, token) is not None
        assert invites.find_valid(second, token) is not None
        invites.redeem(first, token, "one", "pw-one")
        with pytest.raises(invites.InvalidInvite):
            invites.redeem(second, token, "two", "pw-two")
    with Session(init_db["engine"]) as s:
        names = {u.username for u in s.exec(select(User)).all()}
    assert "one" in names and "two" not in names

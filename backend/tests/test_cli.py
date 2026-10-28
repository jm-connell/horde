"""python -m app.cli: the way back in when the only admin forgot the password."""

from __future__ import annotations

import io

from sqlmodel import Session

from app import cli
from app.services.auth import accounts


def _run(monkeypatch, capsys, stdin: str, *argv: str):
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    code = cli.main(list(argv))
    return code, capsys.readouterr()


def test_reset_password_changes_it_and_ends_sessions(
    init_db, admin_user, monkeypatch, capsys, anon_client
):
    with Session(init_db["engine"]) as s:
        token = accounts.start_session(s, admin_user)
    code, out = _run(
        monkeypatch, capsys, "a-fresh-password\n", "reset-password", "ADMIN"
    )
    assert code == 0 and "Password updated" in out.out
    with Session(init_db["engine"]) as s:
        assert accounts.resolve_session(s, token) is None

    def login(pw):
        resp = anon_client.post(
            "/api/auth/login", json={"username": "admin", "password": pw}
        )
        return resp.status_code

    assert login("admin-password") == 401
    assert login("a-fresh-password") == 200


def test_reset_password_reenables_a_disabled_account(
    init_db, admin_user, member_user, monkeypatch, capsys
):
    with Session(init_db["engine"]) as s:
        accounts.update_user(s, member_user.id, disabled=True)
    code, _ = _run(
        monkeypatch, capsys, "another-password\n", "reset-password", "member"
    )
    assert code == 0
    with Session(init_db["engine"]) as s:
        assert accounts.get_by_username(s, "member").disabled is False


def test_reset_password_for_an_unknown_user_fails(init_db, monkeypatch, capsys):
    code, out = _run(monkeypatch, capsys, "whatever-pass\n", "reset-password", "ghost")
    assert code == 1 and "No user named" in out.err


def test_reset_password_enforces_the_policy(init_db, admin_user, monkeypatch, capsys):
    code, out = _run(monkeypatch, capsys, "\n", "reset-password", "admin")
    assert code == 1 and "must not be empty" in out.err


def test_create_admin_on_an_empty_database(init_db, monkeypatch, capsys):
    code, out = _run(monkeypatch, capsys, "owner-password\n", "create-admin", "Owner")
    assert code == 0 and "Created administrator Owner" in out.out
    with Session(init_db["engine"]) as s:
        user = accounts.get_by_username(s, "owner")
        assert user.is_admin


def test_create_admin_refuses_a_taken_name(init_db, admin_user, monkeypatch, capsys):
    code, out = _run(monkeypatch, capsys, "owner-password\n", "create-admin", "admin")
    assert code == 1 and "already taken" in out.err

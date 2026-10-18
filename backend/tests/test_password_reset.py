"""Forgot password: a one-time code written to the server log resets the account."""

from __future__ import annotations

import logging
import re

import pytest

from app.services.auth.reset_codes import (
    CODE_TTL_SEC,
    MAX_ATTEMPTS,
    REISSUE_COOLDOWN_SEC,
    ResetCodes,
    account_binding,
)

CODE_RE = re.compile(r"PASSWORD RESET CODE for '(\w+)': ([A-Z0-9-]+)")


@pytest.fixture
def ask(anon_client, caplog, member_user):
    """Ask for a code; return it as read from the log (None if none was logged)."""

    def run(username: str) -> str | None:
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="app.api.auth"):
            res = anon_client.post("/api/auth/forgot", json={"username": username})
        assert res.status_code == 204
        found = [CODE_RE.search(r.getMessage()) for r in caplog.records]
        codes = [m.group(2) for m in found if m]
        return codes[-1] if codes else None

    return run


def _reset(c, username, code, password="brand-new-password"):  # noqa: S107 - test password
    return c.post(
        "/api/auth/reset",
        json={"username": username, "code": code, "new_password": password},
    )


def test_a_logged_code_resets_the_password_and_signs_in(anon_client, client, ask):
    code = ask("admin")
    assert code is not None

    res = _reset(anon_client, "admin", code.lower().replace("-", " "))
    assert res.status_code == 200
    assert res.json()["user"]["username"] == "admin"
    # Signed in on this browser...
    assert anon_client.get("/api/auth/state").json()["authenticated"] is True
    # ...and every other session of the account is gone.
    assert client.get("/api/auth/state").json()["authenticated"] is False
    login = anon_client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "brand-new-password"},
    )
    assert login.status_code == 200

    # Single use.
    again = _reset(anon_client, "admin", code, "another-new-password")
    assert again.json()["code"] == "invalid_reset_code"


def test_unknown_users_get_the_same_answer_and_no_code(ask):
    assert ask("nobody-here") is None


def test_asking_again_within_the_cooldown_logs_nothing(ask):
    assert ask("member") is not None
    assert ask("member") is None


def test_a_wrong_code_is_refused_and_does_not_change_the_password(anon_client, ask):
    code = ask("member")
    assert code is not None
    res = _reset(anon_client, "member", "AAAAA-AAAAA")
    assert res.status_code == 400
    assert res.json()["code"] == "invalid_reset_code"
    login = anon_client.post(
        "/api/auth/login",
        json={"username": "member", "password": "brand-new-password"},
    )
    assert login.status_code == 401


def test_a_weak_password_keeps_the_code_usable(anon_client, ask):
    code = ask("member")
    assert code is not None
    weak = _reset(anon_client, "member", code, "short")
    assert weak.status_code == 400
    assert weak.json()["code"] == "weak_password"
    assert _reset(anon_client, "member", code).status_code == 200


def test_a_disabled_account_gets_no_code(client, ask):
    users = {u["username"]: u for u in client.get("/api/users").json()}
    client.patch(f"/api/users/{users['member']['id']}", json={"disabled": True})
    assert ask("member") is None


def test_a_code_dies_when_the_password_changes_another_way(anon_client, client, ask):
    code = ask("member")
    assert code is not None
    users = {u["username"]: u for u in client.get("/api/users").json()}
    client.patch(
        f"/api/users/{users['member']['id']}", json={"password": "admin-chose-this"}
    )
    res = _reset(anon_client, "member", code)
    assert res.json()["code"] == "invalid_reset_code"


def test_signing_in_normally_cancels_pending_codes(anon_client, ask):
    from tests.conftest import MEMBER_PASSWORD

    code = ask("member")
    assert code is not None
    login = anon_client.post(
        "/api/auth/login", json={"username": "member", "password": MEMBER_PASSWORD}
    )
    assert login.status_code == 200
    assert _reset(anon_client, "member", code).json()["code"] == "invalid_reset_code"


def test_repeated_wrong_codes_are_throttled(anon_client, ask):
    assert ask("member") is not None
    statuses = [
        _reset(anon_client, "member", f"WRONG-{i:05d}").status_code for i in range(12)
    ]
    assert 429 in statuses
    limited = _reset(anon_client, "member", "WRONG-CODE0")
    assert limited.json()["code"] == "rate_limited"


def test_refused_when_sign_in_is_disabled(app, anon_client):
    from app.services.auth.runtime import AuthConfig

    app.state.auth.config = AuthConfig(disabled=True)
    for path, body in (
        ("/api/auth/forgot", {"username": "admin"}),
        (
            "/api/auth/reset",
            {"username": "admin", "code": "X", "new_password": "long-enough-1"},
        ),
    ):
        res = anon_client.post(path, json=body)
        assert res.status_code == 400
        assert res.json()["code"] == "auth_disabled"


BOUND = account_binding(1, "hash-a")


def _clocked():
    now = [0.0]
    return now, ResetCodes(clock=lambda: now[0])


def test_a_code_works_exactly_once():
    _, codes = _clocked()
    code = codes.issue("jon", BOUND)
    assert code is not None
    # Two requests racing with the same code: only one gets in.
    assert codes.redeem("jon", code, BOUND)
    assert not codes.redeem("jon", code, BOUND)


def test_codes_are_bound_to_the_account_and_its_password():
    _, codes = _clocked()
    code = codes.issue("jon", BOUND)
    assert code is not None
    assert not codes.redeem("jon", code, account_binding(1, "hash-b"))
    assert not codes.redeem("jon", code, account_binding(2, "hash-a"))


def test_asking_again_keeps_the_previous_codes_valid():
    now, codes = _clocked()
    first = codes.issue("jon", BOUND)
    now[0] += REISSUE_COOLDOWN_SEC
    second = codes.issue("jon", BOUND)
    assert first and second
    assert codes.redeem("jon", first, BOUND)


def test_codes_expire():
    now, codes = _clocked()
    code = codes.issue("jon", BOUND)
    assert code is not None
    now[0] += CODE_TTL_SEC
    assert not codes.redeem("jon", code, BOUND)


def test_too_many_guesses_cancel_the_codes_but_not_the_cooldown():
    _, codes = _clocked()
    code = codes.issue("jon", BOUND)
    assert code is not None
    for _ in range(MAX_ATTEMPTS):
        assert not codes.redeem("jon", "WRONG-CODE0", BOUND)
    # The real code no longer works once the guesses are used up...
    assert not codes.redeem("jon", code, BOUND)
    # ...and burning them does not open the way to flooding the log.
    assert codes.issue("jon", BOUND) is None

"""Two-step sign-in: enrolling, the code step, recovery codes, the requirement, resets."""

from __future__ import annotations

import io
import itertools
import time
import types

import pytest
from sqlmodel import Session, select

from app import cli
from app.models import User, UserRecoveryCode
from app.services.auth import accounts, login_tickets, totp, two_factor
from app.services.auth.limiter import FREE_ATTEMPTS, LoginLimiter

ADMIN_PW = "admin-password"
MEMBER_PW = "member-password"


@pytest.fixture
def now(monkeypatch):
    """The clock two-step checks read, frozen five seconds into a 30 second step."""
    base = float(int(time.time()) // totp.STEP_SECONDS * totp.STEP_SECONDS + 5)
    clock = [base]
    monkeypatch.setattr(
        two_factor, "time", types.SimpleNamespace(time=lambda: clock[0])
    )
    return clock


def _code(secret: str, clock: list[float], steps_ahead: int = 0) -> str:
    return totp.code_at(secret, clock[0] + steps_ahead * totp.STEP_SECONDS)


def _enroll(c, clock, password=ADMIN_PW) -> tuple[str, list[str]]:
    """Set two-step sign-in up on ``c``'s account; returns (secret, recovery codes)."""
    res = c.post("/api/auth/2fa/setup", json={"current_password": password})
    assert res.status_code == 200, res.text
    secret = res.json()["secret"]
    res = c.post("/api/auth/2fa/confirm", json={"code": _code(secret, clock)})
    assert res.status_code == 200, res.text
    return secret, res.json()["recovery_codes"]


def _password_step(c, username="admin", password=ADMIN_PW):
    return c.post("/api/auth/login", json={"username": username, "password": password})


def _ticket(c, username="admin", password=ADMIN_PW) -> str:
    res = _password_step(c, username, password)
    assert res.status_code == 401 and res.json()["code"] == "totp_required", res.text
    assert "set-cookie" not in res.headers  # a right password alone starts no session
    return res.json()["extra"]["pending_token"]


def _second_step(c, ticket: str, code: str):
    return c.post("/api/auth/login/totp", json={"pending_token": ticket, "code": code})


def _signed_in(c) -> bool:
    return c.get("/api/auth/state").json()["authenticated"]


@pytest.fixture
def enrolled(client, anon_client, now):
    """The admin has two-step sign-in on; ``anon_client`` is signed out."""
    secret, codes = _enroll(client, now)
    return types.SimpleNamespace(secret=secret, codes=codes)


# --- enrolling ------------------------------------------------------------------


def test_setup_needs_the_current_password(client, now):
    wrong = client.post("/api/auth/2fa/setup", json={"current_password": "nope-nope"})
    assert wrong.status_code == 400 and wrong.json()["code"] == "wrong_password"
    assert client.get("/api/auth/2fa").json()["enabled"] is False


def test_setup_returns_the_secret_the_link_and_a_qr_code_and_is_not_cached(client, now):
    res = client.post("/api/auth/2fa/setup", json={"current_password": ADMIN_PW})
    body = res.json()
    assert res.headers["cache-control"] == "no-store"
    plain = body["secret"].replace(" ", "")
    assert len(plain) == 32 and f"secret={plain}" in body["otpauth_uri"]
    assert body["otpauth_uri"].startswith("otpauth://totp/Horde%3Aadmin?")
    assert body["qr_svg"].startswith("<svg") and "</svg>" in body["qr_svg"]
    # Setting up does not turn anything on by itself.
    assert client.get("/api/auth/2fa").json()["enabled"] is False
    assert _password_step(client).status_code == 200


def test_confirm_with_a_wrong_code_changes_nothing(client, now):
    client.post("/api/auth/2fa/setup", json={"current_password": ADMIN_PW})
    res = client.post("/api/auth/2fa/confirm", json={"code": "000000"})
    assert res.status_code == 400 and res.json()["code"] == "invalid_totp"
    assert client.get("/api/auth/2fa").json()["enabled"] is False


def test_confirm_without_setup_is_refused(client, now):
    res = client.post("/api/auth/2fa/confirm", json={"code": "123456"})
    assert res.status_code == 409 and res.json()["code"] == "no_enrollment"


def test_confirm_turns_it_on_and_gives_ten_recovery_codes_once(client, now):
    secret, codes = _enroll(client, now)
    assert secret
    assert len(codes) == 10 == len(set(codes))
    status = client.get("/api/auth/2fa").json()
    assert status["enabled"] is True and status["recovery_codes_left"] == 10
    assert client.get("/api/auth/state").json()["user"]["two_factor_enabled"] is True
    # Setting up again while it is on is refused.
    again = client.post("/api/auth/2fa/setup", json={"current_password": ADMIN_PW})
    assert again.status_code == 409 and again.json()["code"] == "two_factor_enabled"


def test_confirming_signs_out_the_other_browsers_but_not_this_one(
    client, app, init_db, admin_user, now
):
    from tests.conftest import _client, _session_cookie

    with _client(app, cookies=_session_cookie(init_db, admin_user)) as other:
        assert _signed_in(other)
        _enroll(client, now)
        assert _signed_in(client)
        assert not _signed_in(other)


def test_the_database_keeps_no_recovery_code_in_the_clear(client, init_db, now):
    _, codes = _enroll(client, now)
    with Session(init_db["engine"]) as s:
        stored = [row.code_hash for row in s.exec(select(UserRecoveryCode))]
    assert len(stored) == 10
    plain = {c.replace("-", "") for c in codes}
    assert not plain & set(stored)
    assert all(len(h) == 64 and h not in plain for h in stored)


def test_the_secret_is_never_part_of_a_user_or_state_response(client, member_user, now):
    secret, _ = _enroll(client, now)
    plain = secret.replace(" ", "")
    for path in ("/api/auth/state", "/api/users", "/api/auth/2fa"):
        assert plain not in client.get(path).text


# --- signing in -----------------------------------------------------------------


def test_a_right_password_asks_for_a_code_and_the_code_signs_in(
    anon_client, enrolled, now
):
    ticket = _ticket(anon_client)
    assert not _signed_in(anon_client)
    res = _second_step(anon_client, ticket, _code(enrolled.secret, now, 1))
    assert res.status_code == 200, res.text
    assert res.json()["user"]["username"] == "admin"
    assert "horde_session=" in res.headers["set-cookie"]
    assert _signed_in(anon_client)


def test_a_wrong_password_never_hints_at_two_step(anon_client, enrolled):
    res = _password_step(anon_client, password="not-the-password")
    assert res.status_code == 401 and res.json()["code"] == "invalid_credentials"
    assert "extra" not in res.json()


def test_the_code_of_the_previous_and_next_step_work_but_not_two_away(
    anon_client, enrolled, now
):
    # enrolled used step s (now). Steps s+1 and later are fresh.
    ahead = _second_step(
        anon_client, _ticket(anon_client), _code(enrolled.secret, now, 1)
    )
    assert ahead.status_code == 200
    anon_client.post("/api/auth/logout")
    now[0] += 60  # now step s+2: s+1 is the previous step, but it was used
    too_far = _second_step(
        anon_client, _ticket(anon_client), _code(enrolled.secret, now, 2)
    )
    assert too_far.status_code == 401 and too_far.json()["code"] == "invalid_totp"
    fresh = _second_step(
        anon_client, _ticket(anon_client), _code(enrolled.secret, now, 1)
    )
    assert fresh.status_code == 200


def test_the_previous_step_is_accepted_when_it_was_not_used(anon_client, enrolled, now):
    now[0] += 90  # three steps on; the previous one (s+2) was never used
    res = _second_step(
        anon_client, _ticket(anon_client), _code(enrolled.secret, now, -1)
    )
    assert res.status_code == 200


def test_a_code_cannot_be_replayed(anon_client, enrolled, now, app, init_db):
    from tests.conftest import _client

    code = _code(enrolled.secret, now, 1)
    assert _second_step(anon_client, _ticket(anon_client), code).status_code == 200
    with _client(app) as second:
        replay = _second_step(second, _ticket(second), code)
    assert replay.status_code == 401 and replay.json()["code"] == "invalid_totp"
    assert not _signed_in(second)


def test_the_code_used_to_confirm_cannot_sign_in_either(anon_client, enrolled, now):
    spent = _code(enrolled.secret, now)
    res = _second_step(anon_client, _ticket(anon_client), spent)
    assert res.status_code == 401 and res.json()["code"] == "invalid_totp"


def test_a_ticket_works_once(anon_client, enrolled, now):
    ticket = _ticket(anon_client)
    assert (
        _second_step(anon_client, ticket, _code(enrolled.secret, now, 1)).status_code
        == 200
    )
    anon_client.post("/api/auth/logout")
    again = _second_step(anon_client, ticket, _code(enrolled.secret, now, 2))
    assert again.status_code == 401 and again.json()["code"] == "totp_ticket_invalid"


def test_five_wrong_codes_burn_the_ticket(anon_client, enrolled, now, app):
    # The throttle's clock runs fast, so only the ticket's own limit is in play.
    ticks = itertools.count(1000, 10)
    app.state.auth.limiter = LoginLimiter(clock=lambda: float(next(ticks)))
    ticket = _ticket(anon_client)
    for i in range(login_tickets.MAX_ATTEMPTS):
        res = _second_step(anon_client, ticket, f"00000{i}")
        assert res.json()["code"] == "invalid_totp"
    # The ticket is spent on its own account, even for the right code.
    good = _second_step(anon_client, ticket, _code(enrolled.secret, now, 1))
    assert good.status_code == 401 and good.json()["code"] == "totp_ticket_invalid"
    assert not _signed_in(anon_client)


def test_a_ticket_expires(anon_client, enrolled, now, app, monkeypatch):
    ticket = _ticket(anon_client)
    later = time.time() + login_tickets.TICKET_TTL_SEC + 5
    monkeypatch.setattr(
        login_tickets, "time", types.SimpleNamespace(time=lambda: later)
    )
    app.state.auth.pending_logins = login_tickets.PendingLogins(clock=lambda: later)
    res = _second_step(anon_client, ticket, _code(enrolled.secret, now, 1))
    assert res.status_code == 401 and res.json()["code"] == "totp_ticket_invalid"


def test_a_ticket_does_not_survive_a_password_change(
    anon_client, enrolled, now, client, admin_user
):
    ticket = _ticket(anon_client)
    res = client.post(
        "/api/auth/password",
        json={
            "current_password": "admin-password",
            "new_password": "a-brand-new-password",
        },
    )
    assert res.status_code == 204
    spent = _second_step(anon_client, ticket, _code(enrolled.secret, now, 1))
    assert spent.status_code == 401 and spent.json()["code"] == "totp_ticket_invalid"


def test_a_ticket_does_not_survive_turning_two_step_off(
    anon_client, enrolled, now, client, member_user, init_db
):
    ticket = _ticket(anon_client)
    with Session(init_db["engine"]) as s:
        two_factor.reset(s, 1)
    res = _second_step(anon_client, ticket, _code(enrolled.secret, now, 1))
    assert res.status_code == 401 and res.json()["code"] == "totp_ticket_invalid"


@pytest.mark.parametrize(
    "ticket",
    [
        "",
        "garbage",
        "v1.1.1.aa.bb",
        "é" * 90,
        "v1." + "9" * 12 + ".1." + "a" * 32 + "." + "b" * 64,
    ],
)
def test_a_forged_or_malformed_ticket_is_a_plain_401(anon_client, enrolled, ticket):
    res = _second_step(anon_client, ticket, "123456")
    assert res.status_code == 401 and res.json()["code"] == "totp_ticket_invalid"


def test_a_ticket_signed_for_another_user_does_not_work(
    anon_client, enrolled, member_user, now, app
):
    ticket = _ticket(anon_client)
    parsed = login_tickets.parse(ticket)
    assert parsed is not None
    swapped = ticket.replace(f".{parsed.user_id}.", f".{member_user.id}.", 1)
    res = _second_step(anon_client, swapped, _code(enrolled.secret, now, 1))
    assert res.status_code == 401 and res.json()["code"] == "totp_ticket_invalid"


def test_a_disabled_account_cannot_finish_the_second_step(
    anon_client, enrolled, now, init_db
):
    ticket = _ticket(anon_client)
    with Session(init_db["engine"]) as s:
        user = accounts.get_by_username(s, "admin")
        user.disabled = True
        s.add(user)
        s.commit()
    res = _second_step(anon_client, ticket, _code(enrolled.secret, now, 1))
    assert res.status_code == 401


def test_last_login_waits_for_the_second_step(anon_client, enrolled, now, init_db):
    def last_login():
        with Session(init_db["engine"]) as s:
            user = accounts.get_by_username(s, "admin")
            s.refresh(user)
            return user.last_login_at

    ticket = _ticket(anon_client)
    before = last_login()
    wrong = _second_step(anon_client, ticket, "000000")
    assert wrong.status_code == 401
    assert last_login() == before
    _second_step(anon_client, ticket, _code(enrolled.secret, now, 1))
    assert last_login() != before


# --- the throttle ----------------------------------------------------------------


def test_wrong_codes_count_in_the_same_throttle_as_wrong_passwords(
    anon_client, enrolled
):
    ticket = _ticket(anon_client)  # the right password used up the first try
    statuses = []
    for i in range(FREE_ATTEMPTS - 1):
        res = _second_step(anon_client, ticket, f"00000{i}")
        statuses.append(res.status_code)
    assert statuses == [401] * (FREE_ATTEMPTS - 1)
    # Now both steps wait: the password step and the code step.
    assert _password_step(anon_client).status_code == 429
    assert _second_step(anon_client, ticket, "999999").status_code == 429


def test_failures_before_the_password_step_count_too(anon_client, enrolled):
    for _ in range(FREE_ATTEMPTS - 2):
        _password_step(anon_client, password="wrong-wrong-wrong")
    ticket = _ticket(anon_client)
    assert _second_step(anon_client, ticket, "000000").status_code == 401
    assert _second_step(anon_client, ticket, "000001").status_code == 429


def test_a_right_password_does_not_reset_the_code_failures(anon_client, enrolled, app):
    """Ten wrong codes make the code step wait, however many right passwords came between."""
    from app.services.auth.limiter import CODE_LOCK_EVERY

    clock = [1000.0]
    app.state.auth.limiter = LoginLimiter(clock=lambda: clock[0])
    addresses = itertools.count(1)
    app.state.auth.client_address = lambda request: f"203.0.113.{next(addresses)}"
    for round_ in range(CODE_LOCK_EVERY):
        clock[0] += 61.0  # past the per-minute slowdown, a new address each time
        ticket = _ticket(anon_client)
        res = _second_step(anon_client, ticket, f"00000{round_ % 10}")
        assert res.json()["code"] == "invalid_totp"
    ticket = _ticket(anon_client)  # the password step is not held up
    assert _second_step(anon_client, ticket, "000099").status_code == 429


def test_a_successful_second_step_clears_the_failures(anon_client, enrolled, now):
    ticket = _ticket(anon_client)
    for i in range(FREE_ATTEMPTS - 2):
        _second_step(anon_client, ticket, f"00000{i}")
    assert (
        _second_step(anon_client, ticket, _code(enrolled.secret, now, 1)).status_code
        == 200
    )
    anon_client.post("/api/auth/logout")
    for _ in range(FREE_ATTEMPTS - 1):
        assert (
            _password_step(anon_client, password="wrong-wrong-wrong").status_code == 401
        )


# --- recovery codes ----------------------------------------------------------------


def test_a_recovery_code_signs_in_once(anon_client, enrolled, app):
    code = enrolled.codes[0]
    first = _second_step(anon_client, _ticket(anon_client), code.lower())
    assert first.status_code == 200
    anon_client.post("/api/auth/logout")
    second = _second_step(anon_client, _ticket(anon_client), code)
    assert second.status_code == 401 and second.json()["code"] == "invalid_totp"


def test_using_a_recovery_code_uses_up_one_of_ten(anon_client, enrolled, client):
    _second_step(anon_client, _ticket(anon_client), enrolled.codes[3])
    assert anon_client.get("/api/auth/2fa").json()["recovery_codes_left"] == 9


def test_recovery_codes_work_with_or_without_the_dash_and_in_any_case(
    anon_client, enrolled
):
    typed = enrolled.codes[1].replace("-", " ").lower()
    assert _second_step(anon_client, _ticket(anon_client), typed).status_code == 200


def test_regenerating_replaces_the_set(client, anon_client, enrolled, now):
    res = client.post(
        "/api/auth/2fa/recovery-codes",
        json={"current_password": ADMIN_PW, "code": _code(enrolled.secret, now, 1)},
    )
    assert res.status_code == 200, res.text
    fresh = res.json()["recovery_codes"]
    assert len(fresh) == 10 and not set(fresh) & set(enrolled.codes)
    assert res.headers["cache-control"] == "no-store"
    old = _second_step(anon_client, _ticket(anon_client), enrolled.codes[0])
    assert old.status_code == 401
    new = _second_step(anon_client, _ticket(anon_client), fresh[0])
    assert new.status_code == 200


def test_regenerating_needs_the_password_and_a_code(client, enrolled, now):
    no_pw = client.post(
        "/api/auth/2fa/recovery-codes",
        json={
            "current_password": "wrong-wrong",
            "code": _code(enrolled.secret, now, 1),
        },
    )
    assert no_pw.json()["code"] == "wrong_password"
    no_code = client.post(
        "/api/auth/2fa/recovery-codes",
        json={"current_password": ADMIN_PW, "code": "000000"},
    )
    assert no_code.status_code == 400 and no_code.json()["code"] == "invalid_totp"
    assert client.get("/api/auth/2fa").json()["recovery_codes_left"] == 10


def test_a_recovery_code_can_authorise_turning_it_off(client, enrolled):
    res = client.post(
        "/api/auth/2fa/disable",
        json={"current_password": ADMIN_PW, "code": enrolled.codes[0]},
    )
    assert res.status_code == 204


# --- turning it off ---------------------------------------------------------------


def test_turning_it_off_needs_the_password_and_a_code(
    client, anon_client, enrolled, now, init_db
):
    wrong_code = client.post(
        "/api/auth/2fa/disable", json={"current_password": ADMIN_PW, "code": "000000"}
    )
    assert wrong_code.json()["code"] == "invalid_totp"
    wrong_pw = client.post(
        "/api/auth/2fa/disable",
        json={"current_password": "nope-nope", "code": _code(enrolled.secret, now, 1)},
    )
    assert wrong_pw.json()["code"] == "wrong_password"
    assert client.get("/api/auth/2fa").json()["enabled"] is True

    ok = client.post(
        "/api/auth/2fa/disable",
        json={"current_password": ADMIN_PW, "code": _code(enrolled.secret, now, 1)},
    )
    assert ok.status_code == 204
    assert client.get("/api/auth/2fa").json()["enabled"] is False
    assert _password_step(anon_client).status_code == 200
    with Session(init_db["engine"]) as s:
        user = accounts.get_by_username(s, "admin")
        assert (user.totp_secret, user.totp_enabled_at, user.totp_last_step) == (
            None,
            None,
            None,
        )
        assert not list(s.exec(select(UserRecoveryCode)))


def test_guessing_codes_while_turning_it_off_is_throttled(client, enrolled):
    codes = [
        client.post(
            "/api/auth/2fa/disable",
            json={"current_password": ADMIN_PW, "code": f"00000{i}"},
        ).status_code
        for i in range(FREE_ATTEMPTS + 1)
    ]
    assert codes[:FREE_ATTEMPTS] == [400] * FREE_ATTEMPTS and codes[-1] == 429


def test_disabling_without_it_being_on_is_refused(client):
    res = client.post(
        "/api/auth/2fa/disable", json={"current_password": ADMIN_PW, "code": "123456"}
    )
    assert res.status_code == 400 and res.json()["code"] == "invalid_totp"


# --- forgot / reset password ----------------------------------------------------------


def test_the_password_reset_does_not_skip_the_second_step(
    anon_client, enrolled, now, caplog
):
    import logging
    import re

    with caplog.at_level(logging.WARNING, logger="app.api.auth"):
        anon_client.post("/api/auth/forgot", json={"username": "admin"})
    code = next(
        m.group(1)
        for r in caplog.records
        if (
            m := re.search(
                r"PASSWORD RESET CODE for 'admin': ([A-Z0-9-]+)", r.getMessage()
            )
        )
    )
    res = anon_client.post(
        "/api/auth/reset",
        json={"username": "admin", "code": code, "new_password": "reset-password-1"},
    )
    assert res.status_code == 401 and res.json()["code"] == "totp_required"
    assert "set-cookie" not in res.headers and not _signed_in(anon_client)
    ticket = res.json()["extra"]["pending_token"]

    # The password did change, and the ticket finishes the sign-in.
    assert _password_step(anon_client).json()["code"] == "invalid_credentials"
    done = _second_step(anon_client, ticket, _code(enrolled.secret, now, 1))
    assert done.status_code == 200 and _signed_in(anon_client)


def test_a_recovery_code_finishes_a_password_reset_too(anon_client, enrolled, caplog):
    import logging
    import re

    with caplog.at_level(logging.WARNING, logger="app.api.auth"):
        anon_client.post("/api/auth/forgot", json={"username": "admin"})
    code = next(
        m.group(1)
        for r in caplog.records
        if (
            m := re.search(
                r"PASSWORD RESET CODE for 'admin': ([A-Z0-9-]+)", r.getMessage()
            )
        )
    )
    res = anon_client.post(
        "/api/auth/reset",
        json={"username": "admin", "code": code, "new_password": "reset-password-1"},
    )
    ticket = res.json()["extra"]["pending_token"]
    assert _second_step(anon_client, ticket, enrolled.codes[0]).status_code == 200


# --- the requirement -----------------------------------------------------------------


def _require(client, value):
    res = client.patch("/api/settings", json={"require_two_factor": value})
    assert res.status_code == 200, res.text
    return res


def test_the_setting_defaults_to_off_and_only_admins_can_change_or_read_it(
    client, member_client, now
):
    assert client.get("/api/settings").json()["require_two_factor"] == "off"
    denied = member_client.patch(
        "/api/settings", json={"require_two_factor": "everyone"}
    )
    assert denied.status_code == 403
    bad = client.patch("/api/settings", json={"require_two_factor": "sometimes"})
    assert bad.status_code == 422
    _enroll(client, now)  # an administrator without it would be held back at once
    _require(client, "admins")
    assert client.get("/api/settings").json()["require_two_factor"] == "admins"
    assert member_client.get("/api/settings").json()["require_two_factor"] == "off"


def test_a_required_account_without_it_can_only_enroll(client, member_client, now):
    _require(client, "everyone")
    state = member_client.get("/api/auth/state").json()
    assert state["user"]["two_factor_enrollment_required"] is True
    for method, path in [
        ("GET", "/api/videos"),
        ("GET", "/api/settings"),
        ("GET", "/api/auth/sessions"),
        ("POST", "/api/auth/password"),
        ("PATCH", "/api/auth/me"),
        ("GET", "/api/auth/avatar/1"),
        ("POST", "/api/auth/2fa/disable"),
        ("POST", "/api/auth/2fa/recovery-codes"),
    ]:
        res = member_client.request(method, path)
        assert res.status_code == 403, f"{method} {path} answered {res.status_code}"
        assert res.json()["code"] == "two_factor_enrollment_required"
    # The routes that let them finish.
    assert member_client.get("/api/auth/2fa").json()["required"] is True
    secret, _ = _enroll(member_client, now, MEMBER_PW)
    assert secret
    assert member_client.get("/api/videos").status_code == 200
    state = member_client.get("/api/auth/state").json()
    assert state["user"]["two_factor_enrollment_required"] is False
    assert state["user"]["two_factor_enabled"] is True


def test_a_required_account_can_still_sign_out(client, member_client):
    _require(client, "everyone")
    assert member_client.post("/api/auth/logout").status_code == 204
    assert not _signed_in(member_client)


def test_admins_only_leaves_members_alone(client, member_client, app, init_db):
    from tests.conftest import _client, _session_cookie

    with Session(init_db["engine"]) as s:
        second_admin = accounts.create_user(s, "boss2", "boss2-password", is_admin=True)
    _require(client, "admins")
    assert member_client.get("/api/videos").status_code == 200
    with _client(app, cookies=_session_cookie(init_db, second_admin)) as boss:
        assert boss.get("/api/videos").status_code == 403
    # The admin who changed the setting is held back from the next request on.
    assert client.get("/api/videos").status_code == 403


def test_signing_in_while_required_lands_on_enrollment_not_in_the_app(
    client, anon_client, member_user
):
    _require(client, "everyone")
    res = anon_client.post(
        "/api/auth/login", json={"username": "member", "password": MEMBER_PW}
    )
    assert res.status_code == 200
    assert res.json()["user"]["two_factor_enrollment_required"] is True
    assert anon_client.get("/api/videos").status_code == 403


def test_the_requirement_also_covers_signed_media_links(
    client, member_client, app, init_db, add_video
):
    video = add_video(write_file=True)
    token = member_client.get(f"/api/videos/{video.id}/media-token").json()["token"]
    from tests.conftest import _client

    with _client(app) as receiver:
        url = f"/api/videos/{video.id}/stream?mt={token}"
        assert receiver.get(url).status_code in (200, 206)
        _require(client, "everyone")
        assert receiver.get(url).status_code == 403


def test_lowering_the_requirement_frees_the_account_at_once(client, member_client, now):
    _enroll(client, now)  # an enrolled administrator can change the setting back
    _require(client, "everyone")
    assert member_client.get("/api/videos").status_code == 403
    assert client.get("/api/videos").status_code == 200  # already has it
    _require(client, "off")
    assert member_client.get("/api/videos").status_code == 200


def test_unreadable_settings_keep_the_last_requirement_in_force(
    client, member_client, now, monkeypatch
):
    from app.services import app_settings

    _enroll(client, now)
    assert member_client.get("/api/videos").status_code == 200  # reads "off"
    _require(client, "everyone")
    assert member_client.get("/api/videos").status_code == 403  # reads "everyone"
    # A damaged settings file hands back stand-in defaults: they are not the
    # administrator's choice, so the last value read stays.
    monkeypatch.setattr(app_settings, "is_degraded", lambda: True)
    assert member_client.get("/api/videos").status_code == 403
    monkeypatch.setattr(app_settings, "is_degraded", lambda: False)
    _require(client, "off")
    assert member_client.get("/api/videos").status_code == 200  # reads "off"
    monkeypatch.setattr(app_settings, "is_degraded", lambda: True)
    assert member_client.get("/api/videos").status_code == 200


def test_a_proxy_authenticated_server_never_forces_enrollment(app, admin_user, init_db):
    from fastapi.testclient import TestClient

    from app.services import app_settings
    from app.services.auth.runtime import AuthConfig

    app_settings.save({"require_two_factor": "everyone"})
    app.state.auth.config = AuthConfig(disabled=True)
    with TestClient(app, headers={"X-Horde-Request": "1"}) as c:
        assert c.get("/api/videos").status_code == 200
        res = c.post("/api/auth/login/totp", json={"pending_token": "x", "code": "1"})
        assert res.json()["code"] == "auth_disabled"


# --- administrators and the command line ------------------------------------------------


def test_an_admin_can_reset_a_members_two_step_sign_in(
    client, member_client, app, init_db, member_user, now
):
    from tests.conftest import _client

    secret, codes = _enroll(member_client, now, MEMBER_PW)
    with _client(app) as other:
        assert (
            other.post(
                "/api/auth/login", json={"username": "member", "password": MEMBER_PW}
            ).json()["code"]
            == "totp_required"
        )
    listed = {u["username"]: u for u in client.get("/api/users").json()}
    assert listed["member"]["two_factor_enabled"] is True

    res = client.delete(f"/api/users/{member_user.id}/two-factor")
    assert res.status_code == 204
    assert not _signed_in(member_client)  # signed out everywhere
    with _client(app) as other:
        assert (
            other.post(
                "/api/auth/login", json={"username": "member", "password": MEMBER_PW}
            ).status_code
            == 200
        )
    with Session(init_db["engine"]) as s:
        assert not list(
            s.exec(
                select(UserRecoveryCode).where(
                    UserRecoveryCode.user_id == member_user.id
                )
            )
        )
    assert {u["username"]: u for u in client.get("/api/users").json()}["member"][
        "two_factor_enabled"
    ] is False


def test_only_an_admin_can_reset_and_not_their_own(
    client, member_client, admin_user, member_user
):
    assert (
        member_client.delete(f"/api/users/{admin_user.id}/two-factor").status_code
        == 403
    )
    own = client.delete(f"/api/users/{admin_user.id}/two-factor")
    assert own.status_code == 409
    assert client.delete("/api/users/9999/two-factor").status_code == 404


def test_the_cli_turns_it_off_and_signs_the_user_out(
    anon_client, enrolled, init_db, monkeypatch, capsys, client
):
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    assert cli.main(["reset-2fa", "ADMIN"]) == 0
    assert "off for admin" in capsys.readouterr().out.lower()
    assert not _signed_in(client)
    assert _password_step(anon_client).status_code == 200
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    assert cli.main(["reset-2fa", "nobody"]) == 1


def test_deleting_an_account_removes_its_recovery_codes(
    client, member_client, member_user, init_db, now
):
    _enroll(member_client, now, MEMBER_PW)
    assert client.delete(f"/api/users/{member_user.id}").status_code == 204
    with Session(init_db["engine"]) as s:
        assert not list(s.exec(select(UserRecoveryCode)))
        assert s.get(User, member_user.id) is None


# --- races ------------------------------------------------------------------------------


def test_two_requests_with_the_same_code_cannot_both_win(init_db, enrolled, now):
    """Both read ``totp_last_step`` before either wrote it: the SQL compare-and-set decides."""
    key = b"k" * 32
    code = _code(enrolled.secret, now, 1)
    with Session(init_db["engine"]) as a, Session(init_db["engine"]) as b:
        first = accounts.get_by_username(a, "admin")
        second = accounts.get_by_username(b, "admin")
        assert first is not None and second is not None
        assert two_factor.check_code(a, first, code, key=key, now=now[0]) == "totp"
        assert two_factor.check_code(b, second, code, key=key, now=now[0]) is None

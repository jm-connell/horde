"""Hardening for a sign-in that faces the internet (the 2FA security review).

* the throttle reserves a try before hashing, so a burst cannot get past it;
* hashing is capped, so a burst cannot starve the server;
* a stolen session cookie cannot take the account over (no password-less
  self-reset, step-up re-authentication for the sensitive admin actions);
* a known-device cookie spares the owner the name-wide lanes;
* IPv6 clients are throttled per /64;
* wrong second-step codes escalate per name over weeks.
"""

from __future__ import annotations

import asyncio
import time
import types
from collections import Counter

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.services.auth import accounts, hash_gate, passwords, totp, two_factor
from app.services.auth.limiter import FREE_ATTEMPTS, LoginLimiter, Throttled
from tests.conftest import ADMIN_PASSWORD, CSRF


@pytest.fixture
def now(monkeypatch):
    """A frozen clock for TOTP: tests move it a step at a time."""
    base = float(int(time.time()) // totp.STEP_SECONDS * totp.STEP_SECONDS + 5)
    clock = [base]
    monkeypatch.setattr(
        two_factor, "time", types.SimpleNamespace(time=lambda: clock[0])
    )
    return clock


def _enroll(client, clock) -> str:
    """Turn two-step sign-in on for the signed-in client's account; return its secret."""
    secret = client.post(
        "/api/auth/2fa/setup", json={"current_password": ADMIN_PASSWORD}
    ).json()["secret"]
    res = client.post(
        "/api/auth/2fa/confirm", json={"code": totp.code_at(secret, clock[0])}
    )
    assert res.status_code == 200, res.text
    return secret


async def _burst(app, address: str, requests):
    """Fire every ``(path, json)`` at once from ``address``; the JSON bodies back."""
    transport = httpx.ASGITransport(app=app, client=(address, 1234))
    async with httpx.AsyncClient(
        transport=transport, base_url="http://localhost", headers=CSRF
    ) as c:
        results = await asyncio.gather(
            *[c.post(path, json=body) for path, body in requests]
        )
    return [r.json().get("code") for r in results]


# --- 1. the throttle reserves before it hashes -------------------------------


def test_concurrent_wrong_passwords_are_judged_exactly_the_budget(
    app, init_db, monkeypatch
):
    monkeypatch.setattr(passwords, "CURRENT_PARAMS", passwords.ScryptParams())
    with Session(init_db["engine"]) as s:
        accounts.create_user(s, "victim", "victim-password-1", is_admin=True)
    codes = asyncio.run(
        _burst(
            app,
            "203.0.113.7",
            [
                (
                    "/api/auth/login",
                    {"username": "victim", "password": f"guess-{i:04d}"},
                )
                for i in range(80)
            ],
        )
    )
    assert Counter(codes) == {
        "invalid_credentials": FREE_ATTEMPTS,
        "rate_limited": 80 - FREE_ATTEMPTS,
    }


def test_concurrent_wrong_codes_are_judged_exactly_the_budget(
    app, init_db, admin_user, client, now
):
    _enroll(client, now)

    async def run():
        transport = httpx.ASGITransport(app=app, client=("203.0.113.9", 1234))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://localhost", headers=CSRF
        ) as c:
            tickets = []
            for _ in range(12):
                r = await c.post(
                    "/api/auth/login",
                    json={"username": "admin", "password": ADMIN_PASSWORD},
                )
                assert r.status_code == 401, r.text
                tickets.append(r.json()["extra"]["pending_token"])
            results = await asyncio.gather(
                *[
                    c.post(
                        "/api/auth/login/totp",
                        json={
                            "pending_token": t,
                            "code": f"{(i * 7919) % 1000000:06d}",
                        },
                    )
                    for t in tickets
                    for i in range(5)
                ]
            )
            return [r.json().get("code") for r in results]

    codes = Counter(asyncio.run(run()))
    assert codes["invalid_totp"] == FREE_ATTEMPTS
    assert codes["invalid_totp"] + codes["rate_limited"] == 60


def test_concurrent_current_password_checks_are_judged_exactly_the_budget(
    app, init_db, admin_user, client, monkeypatch
):
    """The same reservation guards ``verify-password`` (and so change-password, ``PATCH /me``)."""
    results: list[int] = []

    async def run():
        transport = httpx.ASGITransport(app=app, client=("203.0.113.5", 1234))
        cookies = dict(client.cookies)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://localhost",
            headers=CSRF,
            cookies=cookies,
        ) as c:
            res = await asyncio.gather(
                *[
                    c.post(
                        "/api/auth/verify-password", json={"password": f"wrong-{i:03d}"}
                    )
                    for i in range(40)
                ]
            )
            results.extend(r.status_code for r in res)

    asyncio.run(run())
    assert Counter(results) == {400: FREE_ATTEMPTS, 429: 40 - FREE_ATTEMPTS}


def test_a_refused_try_is_not_a_failure():
    limiter = LoginLimiter(clock=lambda: 0.0)
    held = [limiter.begin("1.2.3.4", "alice") for _ in range(FREE_ATTEMPTS)]
    with pytest.raises(Throttled):
        limiter.begin("1.2.3.4", "alice")
    for attempt in held:
        attempt.release()  # nothing judged: the budget is whole again
    assert limiter.retry_after("1.2.3.4", "alice") == 0
    limiter.begin("1.2.3.4", "alice").release()


def test_a_judged_failure_frees_its_slot_and_counts():
    limiter = LoginLimiter(clock=lambda: 0.0)
    for _ in range(FREE_ATTEMPTS):
        with limiter.begin("1.2.3.4", "alice") as attempt:
            attempt.failure()
    with pytest.raises(Throttled) as locked:
        limiter.begin("1.2.3.4", "alice")
    assert locked.value.wait > 1  # a lockout, not just a busy slot


def test_tries_on_one_name_in_flight_are_capped_across_addresses():
    limiter = LoginLimiter(clock=lambda: 0.0)
    held = [limiter.begin(f"9.9.9.{i}", "alice") for i in range(5)]
    with pytest.raises(Throttled):
        limiter.begin("9.9.9.99", "alice")
    limiter.begin("9.9.9.99", "bob").release()  # other names are unaffected
    for attempt in held:
        attempt.release()


# --- 1. hashing is capped ------------------------------------------------------


def test_hash_gate_turns_away_when_every_slot_is_taken():
    gate = hash_gate.HashGate(size=1, wait=0)
    with (
        gate.slot(),
        pytest.raises(hash_gate.CodedHTTPException) as busy,
        gate.slot(),
    ):
        pass
    assert (busy.value.status_code, busy.value.code) == (503, "busy")
    assert busy.value.headers == {"Retry-After": "1"}
    with gate.slot():  # released again
        pass


@pytest.mark.parametrize("username", ["admin", "nobody-here"])
def test_sign_in_is_busy_when_hashing_is_saturated(
    app, anon_client, admin_user, username
):
    """An unknown name goes through the gate too, so timing and answers match."""
    gate = hash_gate.HashGate(size=1, wait=0)
    app.state.auth.hashing = gate
    with gate.slot():
        res = anon_client.post(
            "/api/auth/login", json={"username": username, "password": "whatever-1"}
        )
    assert (res.status_code, res.json()["code"]) == (503, "busy")
    assert res.headers["Retry-After"] == "1"
    # A busy server judged nothing: it is not a failed sign-in.
    assert app.state.auth.limiter.retry_after("testclient", username) == 0


# --- 4. IPv6 clients are throttled per /64 ---------------------------------------


def test_throttle_address_keys_ipv6_by_slash_64_and_unwraps_mapped_ipv4():
    from app.services.auth.limiter import throttle_address

    assert throttle_address("2001:db8:1:2:aaaa::1") == throttle_address(
        "2001:db8:1:2:bbbb:cccc:dddd:eeee"
    )
    assert throttle_address("2001:db8:1:2::1") != throttle_address("2001:db8:1:3::1")
    assert throttle_address("::ffff:203.0.113.9") == "203.0.113.9"
    assert throttle_address("203.0.113.9") == "203.0.113.9"
    assert throttle_address("unknown") == "unknown"
    assert throttle_address("fe80::1%eth0") == throttle_address("fe80::2")


def test_rotating_through_a_slash_64_does_not_dodge_the_lockout():
    limiter = LoginLimiter(clock=lambda: 0.0)
    for i in range(FREE_ATTEMPTS):
        limiter.record_failure(f"2001:db8:1:2::{i + 1:x}", "alice")
    assert limiter.retry_after("2001:db8:1:2:ffff::99", "alice") > 0
    assert limiter.retry_after("2001:db8:1:3::1", "alice") == 0  # another network


# --- 8. made-up names cannot flush a real account's state --------------------------


def test_spraying_made_up_names_evicts_made_up_names_first(monkeypatch):
    from app.services.auth import limiter as limiter_module

    monkeypatch.setattr(limiter_module, "MAX_TRACKED_KEYS", 50)
    clock = [0.0]
    limiter = LoginLimiter(clock=lambda: clock[0])
    for _ in range(FREE_ATTEMPTS):
        limiter.record_failure("198.51.100.1", "victim", known=True)
        clock[0] += 1
    assert limiter.retry_after("198.51.100.1", "victim") > 0
    for i in range(500):  # the attacker sprays junk, later than the victim's failures
        limiter.record_failure(f"203.0.113.{i % 250}", f"junk-{i}", known=False)
        clock[0] += 0.001
    assert limiter.retry_after("198.51.100.1", "victim") > 0


# --- 5. wrong codes escalate per name over weeks -----------------------------------


def _wrong_codes(limiter, count, clock, *, name="alice"):
    """``count`` wrong second-step codes, each from a new address a minute after the last.

    (A minute apart so neither the per-address lanes nor the per-minute slowdown fire.)
    """
    for i in range(count):
        clock[0] += 61.0
        limiter.record_failure(f"10.{i // 250}.{i % 250}.1", name, code_name=name)


def test_code_step_waits_longer_after_every_ten_wrong_codes():
    from app.services.auth.limiter import (
        CODE_BASE_DELAY_SEC,
        CODE_LOCK_EVERY,
        CODE_MAX_DELAY_SEC,
    )

    clock = [0.0]
    limiter = LoginLimiter(clock=lambda: clock[0])
    _wrong_codes(limiter, CODE_LOCK_EVERY - 1, clock)
    assert limiter.retry_after("9.9.9.9", "alice", code_name="alice") == 0
    _wrong_codes(limiter, 1, clock)  # the tenth
    first = limiter.retry_after("9.9.9.9", "alice", code_name="alice")
    assert CODE_BASE_DELAY_SEC <= first <= CODE_BASE_DELAY_SEC + 1
    # Only the code step waits: a password try is not held up.
    assert limiter.retry_after("9.9.9.9", "alice") == 0
    with pytest.raises(Throttled):
        limiter.begin("9.9.9.9", "alice", code_name="alice")
    clock[0] += first
    _wrong_codes(limiter, CODE_LOCK_EVERY - 1, clock)
    assert limiter.retry_after("9.9.9.9", "alice", code_name="alice") == 0
    _wrong_codes(limiter, 1, clock)  # the twentieth: twice as long
    second = limiter.retry_after("9.9.9.9", "alice", code_name="alice")
    assert second > first
    assert 2 * CODE_BASE_DELAY_SEC <= second <= 2 * CODE_BASE_DELAY_SEC + 1
    # Capped at an hour.
    for _ in range(40):
        clock[0] += CODE_MAX_DELAY_SEC
        _wrong_codes(limiter, CODE_LOCK_EVERY, clock)
    assert limiter.retry_after("9.9.9.9", "alice", code_name="alice") <= (
        CODE_MAX_DELAY_SEC + 1
    )
    # Another name's code step is untouched.
    assert limiter.retry_after("9.9.9.9", "bob", code_name="bob") == 0


def test_a_right_password_does_not_clear_the_code_counter_but_a_right_code_does():
    clock = [0.0]
    limiter = LoginLimiter(clock=lambda: clock[0])
    _wrong_codes(limiter, 10, clock)
    assert limiter.retry_after("9.9.9.9", "alice", code_name="alice") > 0
    limiter.record_success("9.9.9.9", "alice")  # the password step succeeded
    assert limiter.retry_after("9.9.9.9", "alice", code_name="alice") > 0
    limiter.record_success("9.9.9.9", "alice", code_name="alice")  # a right code
    assert limiter.retry_after("9.9.9.9", "alice", code_name="alice") == 0


def test_the_code_counter_decays_after_a_day_without_failures():
    from app.services.auth.limiter import CODE_FORGET_AFTER_SEC

    clock = [0.0]
    limiter = LoginLimiter(clock=lambda: clock[0])
    _wrong_codes(limiter, 10, clock)
    clock[0] += CODE_FORGET_AFTER_SEC + 1
    assert limiter.retry_after("9.9.9.9", "alice", code_name="alice") == 0
    _wrong_codes(limiter, 9, clock)  # starts over: nine are not yet a lock
    assert limiter.retry_after("9.9.9.9", "alice", code_name="alice") == 0


def test_the_code_step_is_refused_while_the_counter_waits(
    app, anon_client, admin_user, client, now
):
    secret = _enroll(client, now)
    clock = [0.0]
    limiter = LoginLimiter(clock=lambda: clock[0])
    app.state.auth.limiter = limiter
    _wrong_codes(limiter, 10, clock, name="admin")

    ticket = anon_client.post(
        "/api/auth/login", json={"username": "admin", "password": ADMIN_PASSWORD}
    )
    assert ticket.json()["code"] == "totp_required"  # the password step still works
    body = {
        "pending_token": ticket.json()["extra"]["pending_token"],
        "code": totp.code_at(secret, now[0] + totp.STEP_SECONDS),
    }
    now[0] += totp.STEP_SECONDS
    blocked = anon_client.post("/api/auth/login/totp", json=body)
    assert (blocked.status_code, blocked.json()["code"]) == (429, "rate_limited")
    clock[0] += 31.0
    assert anon_client.post("/api/auth/login/totp", json=body).status_code == 200
    # A right code cleared the counter.
    assert limiter.retry_after("9.9.9.9", "admin", code_name="admin") == 0


# --- 3. a known device is spared the name-wide lanes ---------------------------------


def _saturate_daily_ceiling(limiter, name="admin"):
    """Enough failures from enough addresses to put ``name`` in its daily slow lane."""
    from app.services.auth.limiter import DAILY_CEILING

    for i in range(DAILY_CEILING):
        limiter.record_failure(f"10.9.{i // 250}.{i % 250}", name)


def _login(client, username="admin", password=ADMIN_PASSWORD):
    return client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )


def test_sign_in_sets_a_signed_long_lived_device_cookie(app, anon_client, admin_user):
    from app.services.auth import device_cookie

    res = _login(anon_client)
    assert res.status_code == 200
    header = next(
        h
        for h in res.headers.get_list("set-cookie")
        if h.startswith(f"{device_cookie.COOKIE}=")
    )
    assert "HttpOnly" in header
    assert "SameSite=lax" in header
    assert f"Max-Age={device_cookie.MAX_AGE_SEC}" in header
    value = anon_client.cookies[device_cookie.COOKIE]
    assert device_cookie.verify(app.state.auth.secret(), value, admin_user)
    # Signing in again from the same browser keeps its device id.
    _login(anon_client)
    assert anon_client.cookies[device_cookie.COOKIE] == value


def test_a_known_device_signs_in_while_the_name_is_in_its_daily_slow_lane(
    app, anon_client, admin_user
):
    from app.services.auth import device_cookie

    assert _login(anon_client).status_code == 200  # get the cookie
    cookie = anon_client.cookies[device_cookie.COOKIE]
    stranger = TestClient(app, headers=CSRF)
    _saturate_daily_ceiling(app.state.auth.limiter)

    blocked = _login(stranger)
    assert (blocked.status_code, blocked.json()["code"]) == (429, "rate_limited")
    stranger.cookies.set(device_cookie.COOKIE, cookie)
    assert _login(stranger).status_code == 200
    stranger.close()


def test_a_device_cookie_is_only_good_for_its_own_account(
    app, anon_client, admin_user, member_user
):
    from app.services.auth import device_cookie

    assert _login(anon_client, "member", "member-password").status_code == 200
    members_cookie = anon_client.cookies[device_cookie.COOKIE]
    _saturate_daily_ceiling(app.state.auth.limiter)
    stranger = TestClient(app, headers=CSRF)
    stranger.cookies.set(device_cookie.COOKIE, members_cookie)
    blocked = _login(stranger)  # the admin's name, the member's cookie
    assert blocked.status_code == 429
    stranger.close()


def test_a_forged_or_retired_device_cookie_is_ignored(app, init_db, admin_user):
    from app.services.auth import device_cookie

    secret = app.state.auth.secret()
    device_id = device_cookie.new_device_id()
    good = device_cookie.sign(secret, admin_user, device_id)
    assert device_cookie.verify(secret, good, admin_user) == device_id
    assert device_cookie.verify(secret, good[:-1] + "0", admin_user) is None
    assert device_cookie.verify(b"x" * 32, good, admin_user) is None
    assert device_cookie.verify(secret, "garbage", admin_user) is None
    assert device_cookie.verify(secret, None, admin_user) is None
    assert device_cookie.verify(secret, good, None) is None
    # A new password retires every device cookie of the account.
    with Session(init_db["engine"]) as s:
        user = accounts.get_user(s, admin_user.id)
        accounts.set_password(s, user, "a-brand-new-password")
        s.refresh(user)
        assert device_cookie.verify(secret, good, user) is None


def test_a_device_keeps_its_own_back_off():
    """Exempt from the name-wide lanes, not from per-device or per-address lockouts."""
    limiter = LoginLimiter(clock=lambda: 0.0)
    for _ in range(FREE_ATTEMPTS):
        limiter.record_failure("198.51.100.1", "alice", device="d1")
    assert limiter.retry_after("198.51.100.1", "alice", device="d1") > 0  # its address
    assert limiter.retry_after("198.51.100.2", "alice", device="d1") > 0  # its device
    assert limiter.retry_after("198.51.100.2", "alice", device="d2") == 0
    _saturate_daily_ceiling(limiter, "alice")
    assert limiter.retry_after("198.51.100.3", "alice") > 0
    assert limiter.retry_after("198.51.100.3", "alice", device="d2") == 0


def test_a_known_device_is_not_spared_the_code_counter():
    clock = [0.0]
    limiter = LoginLimiter(clock=lambda: clock[0])
    _wrong_codes(limiter, 10, clock)
    with pytest.raises(Throttled):
        limiter.begin("9.9.9.9", "alice", device="d1", code_name="alice")
    limiter.begin("9.9.9.9", "alice", device="d1").release()  # the password step is


# --- 2. a stolen admin cookie cannot take the account over -------------------------


def _set_reauth(init_db, when):
    """Pretend every session last proved the password at ``when`` (None: never)."""
    from sqlalchemy import update

    from app.models import UserSession

    with Session(init_db["engine"]) as s:
        s.execute(update(UserSession).values(reauth_at=when))
        s.commit()


@pytest.fixture
def stale(init_db, client):
    """The signed-in admin client, whose session proved the password long ago.

    That is what a stolen cookie looks like: signed in, but not recently.
    """
    from datetime import timedelta

    from app.models import utcnow

    _set_reauth(init_db, utcnow() - timedelta(hours=1))
    return client


def _new_user(client, name="backdoor", is_admin=True):
    return client.post(
        "/api/users",
        json={"username": name, "password": "backdoor-pass-1", "is_admin": is_admin},
    )


def test_a_stolen_cookie_cannot_set_the_admins_own_password(stale, admin_user):
    res = stale.patch(
        f"/api/users/{admin_user.id}", json={"password": "attacker-chosen-pw"}
    )
    assert (res.status_code, res.json()["code"]) == (400, "use_change_password")


def test_a_stolen_cookie_cannot_mint_a_backdoor_administrator(stale, anon_client):
    res = _new_user(stale)
    assert (res.status_code, res.json()["code"]) == (403, "reauth_required")
    assert (
        anon_client.post(
            "/api/auth/login",
            json={"username": "backdoor", "password": "backdoor-pass-1"},
        ).status_code
        == 401
    )


def test_reauthenticating_unlocks_the_sensitive_actions_for_a_while(stale):
    wrong = stale.post("/api/auth/reauth", json={"password": "not-the-password"})
    assert (wrong.status_code, wrong.json()["code"]) == (400, "wrong_password")
    assert _new_user(stale).status_code == 403
    assert (
        stale.post("/api/auth/reauth", json={"password": ADMIN_PASSWORD}).status_code
        == 204
    )
    assert _new_user(stale).status_code == 201


def test_signing_in_counts_as_proving_the_password(client):
    assert _new_user(client, "colleague", is_admin=False).status_code == 201


def test_the_reauth_window_is_ten_minutes(init_db, client):
    from datetime import timedelta

    from app.models import utcnow

    _set_reauth(init_db, utcnow() - timedelta(minutes=9))
    assert _new_user(client, "inside", is_admin=False).status_code == 201
    _set_reauth(init_db, utcnow() - timedelta(minutes=11))
    assert _new_user(client, "outside", is_admin=False).status_code == 403
    _set_reauth(
        init_db, None
    )  # a session from before the upgrade has never reauthenticated
    assert _new_user(client, "never", is_admin=False).status_code == 403


def test_reauth_wrong_guesses_share_the_password_throttle(stale):
    for _ in range(FREE_ATTEMPTS):
        assert (
            stale.post("/api/auth/reauth", json={"password": "nope-nope"}).status_code
            == 400
        )
    blocked = stale.post("/api/auth/reauth", json={"password": ADMIN_PASSWORD})
    assert (blocked.status_code, blocked.json()["code"]) == (429, "rate_limited")


def test_reauth_needs_a_code_when_the_account_has_two_step(stale, now):
    secret = _enroll(stale, now)
    no_code = stale.post("/api/auth/reauth", json={"password": ADMIN_PASSWORD})
    assert (no_code.status_code, no_code.json()["code"]) == (400, "invalid_totp")
    now[0] += totp.STEP_SECONDS
    ok = stale.post(
        "/api/auth/reauth",
        json={"password": ADMIN_PASSWORD, "code": totp.code_at(secret, now[0])},
    )
    assert ok.status_code == 204


@pytest.mark.parametrize(
    "request_args",
    [
        pytest.param(
            ("PATCH", "/api/users/{m}", {"password": "attacker-chosen-pw"}),
            id="another-password",
        ),
        pytest.param(
            ("PATCH", "/api/users/{m}", {"is_admin": True}), id="promote-to-admin"
        ),
        pytest.param(("DELETE", "/api/users/{m}", None), id="delete-user"),
        pytest.param(
            ("DELETE", "/api/users/{m}/two-factor", None), id="reset-two-factor"
        ),
        pytest.param(
            ("DELETE", "/api/users/{m}/sessions", None), id="sign-out-everywhere"
        ),
        pytest.param(
            ("PATCH", "/api/settings", {"require_two_factor": "everyone"}),
            id="two-factor-requirement",
        ),
        pytest.param(
            ("PATCH", "/api/users/{m}", {"disabled": True}), id="disable-user"
        ),
        pytest.param(
            ("PATCH", "/api/users/{m}", {"permissions": ["download"]}),
            id="change-permissions",
        ),
        pytest.param(
            ("POST", "/api/setup/reset", {"confirm": "RESET"}), id="factory-reset"
        ),
        pytest.param(
            (
                "POST",
                "/api/setup/reset",
                {"erase_media": True, "confirm": "ERASE MEDIA"},
            ),
            id="factory-reset-erasing-media",
        ),
    ],
)
def test_the_sensitive_admin_actions_need_a_recent_password_check(
    stale, member_user, request_args
):
    method, path, body = request_args
    res = stale.request(method, path.format(m=member_user.id), json=body)
    assert (res.status_code, res.json()["code"]) == (403, "reauth_required")
    assert (
        stale.post("/api/auth/reauth", json={"password": ADMIN_PASSWORD}).status_code
        == 204
    )
    res = stale.request(method, path.format(m=member_user.id), json=body)
    assert res.status_code < 400, res.text


def test_a_stolen_cookie_cannot_demote_another_administrator(
    stale, init_db, admin_user
):
    from tests.conftest import _make_user

    other = _make_user(init_db, "second-admin", "second-admin-pw-1", is_admin=True)
    res = stale.patch(f"/api/users/{other.id}", json={"is_admin": False})
    assert (res.status_code, res.json()["code"]) == (403, "reauth_required")
    assert (
        stale.post("/api/auth/reauth", json={"password": ADMIN_PASSWORD}).status_code
        == 204
    )
    assert (
        stale.patch(f"/api/users/{other.id}", json={"is_admin": False}).status_code
        == 200
    )


def test_a_stolen_cookie_cannot_end_one_session_of_another_user(
    stale, init_db, member_user
):
    from tests.conftest import _session_cookie

    _session_cookie(init_db, member_user)
    sid = stale.get(f"/api/users/{member_user.id}/sessions").json()["items"][0]["id"]
    path = f"/api/users/{member_user.id}/sessions/{sid}"
    res = stale.delete(path)
    assert (res.status_code, res.json()["code"]) == (403, "reauth_required")
    assert (
        stale.post("/api/auth/reauth", json={"password": ADMIN_PASSWORD}).status_code
        == 204
    )
    assert stale.delete(path).status_code == 204


def test_everyday_admin_actions_do_not_ask_again(stale, member_user, admin_user):
    assert (
        stale.patch(
            f"/api/users/{member_user.id}", json={"share_downloads": False}
        ).status_code
        == 200
    )
    same = stale.patch("/api/settings", json={"require_two_factor": "off"})
    assert same.status_code == 200  # unchanged: nothing to protect
    assert (
        stale.patch("/api/settings", json={"progress_expiry_days": 30}).status_code
        == 200
    )
    assert (
        stale.delete(f"/api/users/{admin_user.id}/sessions").status_code == 204
    )  # signing yourself out asks nothing


def test_there_is_nothing_to_prove_when_sign_in_is_disabled(
    init_db, admin_user, monkeypatch
):
    from fastapi import FastAPI

    from app.context import install_context
    from app.main import include_api, install_caches
    from app.security import install_security
    from app.services.auth.runtime import AuthConfig
    from app.services.downloads.queue import DownloadQueue, download_queue

    monkeypatch.setattr(DownloadQueue, "_dispatch", lambda self: None)
    download_queue.reset()
    a = FastAPI()
    include_api(a)
    install_security(a, auth_config=AuthConfig(disabled=True))
    install_context(a, init_db["ctx"])
    install_caches(a, init_db["ctx"])
    with TestClient(a, headers=CSRF) as c:
        assert _new_user(c, "proxied", is_admin=False).status_code == 201

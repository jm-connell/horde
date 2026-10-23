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

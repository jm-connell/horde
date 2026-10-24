"""TOTP (RFC 6238) and the sign-in ticket: pure functions, no server."""

from __future__ import annotations

import base64

import pytest

from app.models import User
from app.services.auth import login_tickets, totp

#: RFC 6238 appendix B: the SHA-1 secret is the ASCII string "12345678901234567890".
RFC_KEY = b"12345678901234567890"
RFC_SECRET = base64.b32encode(RFC_KEY).decode()


@pytest.mark.parametrize(
    ("unix_time", "expected"),
    [
        (59, "94287082"),
        (1111111109, "07081804"),
        (1111111111, "14050471"),
        (1234567890, "89005924"),
        (2000000000, "69279037"),
        (20000000000, "65353130"),
    ],
)
def test_rfc_6238_sha1_test_vectors(unix_time, expected):
    assert totp.code_at(RFC_SECRET, unix_time, digits=8) == expected


def test_six_digit_codes_are_the_tail_of_the_eight_digit_ones():
    assert totp.code_at(RFC_SECRET, 59) == "287082"
    assert totp.code_at(RFC_SECRET, 1111111109) == "081804"


def test_codes_from_the_neighbouring_steps_are_accepted_and_others_are_not():
    now = 1_700_000_015.0
    here = totp.step_at(now)
    for offset, accepted in [(-2, False), (-1, True), (0, True), (1, True), (2, False)]:
        code = totp.code_at(RFC_SECRET, (here + offset) * totp.STEP_SECONDS)
        expected = here + offset if accepted else None
        assert totp.match_step(RFC_SECRET, code, now) == expected


def test_a_step_that_was_used_is_refused_again_and_so_are_older_ones():
    now = 1_700_000_015.0
    here = totp.step_at(now)
    code = totp.code_at(RFC_SECRET, now)
    assert totp.match_step(RFC_SECRET, code, now) == here
    assert totp.match_step(RFC_SECRET, code, now, last_step=here) is None
    older = totp.code_at(RFC_SECRET, now - totp.STEP_SECONDS)
    assert totp.match_step(RFC_SECRET, older, now, last_step=here) is None
    newer = totp.code_at(RFC_SECRET, now + totp.STEP_SECONDS)
    assert totp.match_step(RFC_SECRET, newer, now, last_step=here) == here + 1


@pytest.mark.parametrize(
    "typed", ["", "12345", "1234567", "abcdef", "12345a", "١٢٣٤٥٦"]
)
def test_things_that_are_not_six_digits_never_match(typed):
    assert totp.match_step(RFC_SECRET, typed, 59) is None


def test_spaces_and_dashes_are_ignored_as_typed():
    code = totp.code_at(RFC_SECRET, 59)
    assert totp.match_step(RFC_SECRET, f"{code[:3]} {code[3:]}", 59) is not None
    assert totp.match_step(RFC_SECRET, f"{code[:3]}-{code[3:]}", 59) is not None


def test_a_broken_secret_matches_nothing_instead_of_raising():
    assert totp.match_step("not base32 !!", "123456", 59) is None


def test_new_secrets_are_160_bits_of_base32_and_all_different():
    secrets_ = {totp.new_secret() for _ in range(20)}
    assert len(secrets_) == 20
    for secret in secrets_:
        assert len(secret) == 32 and "=" not in secret
        assert len(base64.b32decode(secret)) == 20


def test_the_provisioning_uri_carries_the_account_and_the_parameters():
    uri = totp.provisioning_uri("ABCDEFGHIJKLMNOP", "jon doe@home")
    assert uri.startswith("otpauth://totp/Horde%3Ajon%20doe%40home?")
    for part in ("secret=ABCDEFGHIJKLMNOP", "issuer=Horde", "digits=6", "period=30"):
        assert part in uri
    assert "algorithm=SHA1" in uri


def test_group_secret_makes_blocks_of_four():
    assert totp.group_secret("ABCDEFGHIJ") == "ABCD EFGH IJ"


# --- the sign-in ticket ---------------------------------------------------------


def _user(password_hash="hash-a", secret="S", user_id=7) -> User:  # noqa: S107 - fixture values, not credentials
    from datetime import UTC, datetime

    return User(
        id=user_id,
        username="u",
        username_norm="u",
        password_hash=password_hash,
        totp_secret=secret,
        totp_enabled_at=datetime(2026, 1, 1, tzinfo=UTC),
    )


KEY = b"k" * 32


def test_a_ticket_round_trips_once():
    clock = [1000.0]
    pending = login_tickets.PendingLogins(clock=lambda: clock[0])
    user = _user()
    token = pending.issue(KEY, user)
    parsed = login_tickets.parse(token)
    assert parsed is not None and parsed.user_id == 7
    assert login_tickets.verify(KEY, parsed, login_tickets.ticket_epoch(user), now=1001)
    assert pending.attempt(parsed)
    assert pending.finish(parsed)
    assert not pending.finish(parsed)  # single use
    assert not pending.attempt(parsed)


def test_a_ticket_expires_after_five_minutes():
    clock = [1000.0]
    pending = login_tickets.PendingLogins(clock=lambda: clock[0])
    user = _user()
    parsed = login_tickets.parse(pending.issue(KEY, user))
    assert parsed is not None
    epoch = login_tickets.ticket_epoch(user)
    assert login_tickets.verify(KEY, parsed, epoch, now=1000 + 300)
    assert not login_tickets.verify(KEY, parsed, epoch, now=1000 + 301)
    clock[0] += 301
    assert not pending.attempt(parsed)  # also forgotten by the registry


def test_a_ticket_is_bound_to_the_password_the_secret_and_the_key():
    pending = login_tickets.PendingLogins(clock=lambda: 1000.0)
    user = _user()
    parsed = login_tickets.parse(pending.issue(KEY, user))
    assert parsed is not None
    now = 1001
    assert login_tickets.verify(KEY, parsed, login_tickets.ticket_epoch(user), now=now)
    for changed in (_user(password_hash="hash-b"), _user(secret="T")):
        assert not login_tickets.verify(
            KEY, parsed, login_tickets.ticket_epoch(changed), now=now
        )
    assert not login_tickets.verify(
        b"x" * 32, parsed, login_tickets.ticket_epoch(user), now=now
    )
    # A forged user id breaks the MAC.
    forged = login_tickets.ParsedTicket(parsed.expiry, 8, parsed.nonce, parsed.mac)
    assert not login_tickets.verify(
        KEY, forged, login_tickets.ticket_epoch(user), now=now
    )


def test_five_wrong_tries_burn_a_ticket():
    pending = login_tickets.PendingLogins(clock=lambda: 1000.0)
    parsed = login_tickets.parse(pending.issue(KEY, _user()))
    assert parsed is not None
    results = [pending.attempt(parsed) for _ in range(login_tickets.MAX_ATTEMPTS + 2)]
    assert results == [True] * login_tickets.MAX_ATTEMPTS + [False, False]


def test_the_registry_is_bounded():
    pending = login_tickets.PendingLogins(clock=lambda: 1000.0)
    first = login_tickets.parse(pending.issue(KEY, _user()))
    for _ in range(login_tickets.MAX_OUTSTANDING):
        pending.issue(KEY, _user())
    assert first is not None and not pending.attempt(first)  # the oldest was dropped


@pytest.mark.parametrize(
    "token",
    [
        "",
        "v1.1.2.abc.def",
        "v2." + "1.2." + "a" * 32 + "." + "b" * 64,
        "é" * 80,
        "x" * 5000,
    ],
)
def test_malformed_tickets_do_not_parse(token):
    assert login_tickets.parse(token) is None

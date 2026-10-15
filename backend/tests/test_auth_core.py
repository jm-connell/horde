"""Password hashing, login throttling, signed media tokens and account rules."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import select

from app.models import UserSession, UserSettings, UserVideoState
from app.services.auth import accounts, media_token, passwords
from app.services.auth.limiter import FREE_ATTEMPTS, LoginLimiter

# --- passwords ---------------------------------------------------------------


def test_default_scrypt_parameters_and_format():
    assert passwords.ScryptParams() == passwords.ScryptParams(
        n=2**15, r=8, p=1, dklen=64
    )
    stored = passwords.hash_password("correct horse", passwords.ScryptParams())
    scheme, n, r, p, salt, digest = stored.split("$")
    assert (scheme, n, r, p) == ("scrypt", str(2**15), "8", "1")
    assert salt and digest
    assert passwords.verify_password("correct horse", stored)
    assert not passwords.verify_password("correct horsf", stored)


def test_verify_rejects_malformed_and_oversized_hashes():
    assert not passwords.verify_password("x", "plaintext")
    assert not passwords.verify_password("x", "scrypt$3$8$1$AAAA$AAAA")
    assert not passwords.verify_password("x", f"scrypt${2**30}$8$1$AAAA$AAAA")


def test_old_parameters_still_verify_and_ask_for_rehash():
    old = passwords.hash_password("hunter2hunter2", passwords.ScryptParams(n=2**4))
    assert passwords.verify_password("hunter2hunter2", old)
    assert passwords.needs_rehash(old) == (
        passwords.ScryptParams(n=2**4) != passwords.CURRENT_PARAMS
    )
    assert passwords.needs_rehash(
        passwords.hash_password("x", passwords.ScryptParams(n=2**5))
    )


@pytest.mark.parametrize(
    ("password", "username"),
    [("short", "alice"), ("Alice1234", "alice1234"), ("x" * 2000, "alice")],
)
def test_password_policy_rejects(password, username):
    with pytest.raises(passwords.PasswordPolicyError):
        passwords.validate_password(password, username)


def test_password_policy_has_no_composition_rules():
    passwords.validate_password("alllowercase", "alice")


# --- limiter -----------------------------------------------------------------


def test_limiter_backs_off_exponentially_then_forgets():
    now = [1000.0]
    limiter = LoginLimiter(clock=lambda: now[0])
    for _ in range(FREE_ATTEMPTS - 1):
        limiter.record_failure("1.2.3.4", "alice")
    assert limiter.retry_after("1.2.3.4", "alice") == 0
    limiter.record_failure("1.2.3.4", "alice")
    first = limiter.retry_after("1.2.3.4", "alice")
    assert first > 0
    assert limiter.retry_after("1.2.3.4", "bob") == 0
    now[0] += first
    assert limiter.retry_after("1.2.3.4", "alice") == 0
    limiter.record_failure("1.2.3.4", "alice")
    assert limiter.retry_after("1.2.3.4", "alice") > first
    limiter.record_success("1.2.3.4", "alice")
    assert limiter.retry_after("1.2.3.4", "alice") == 0


def test_limiter_locks_an_address_that_walks_through_usernames():
    limiter = LoginLimiter(clock=lambda: 0.0)
    for i in range(25):
        limiter.record_failure("9.9.9.9", f"user{i}")
    assert limiter.retry_after("9.9.9.9", "someone-new") > 0
    assert limiter.retry_after("8.8.8.8", "someone-new") == 0


# --- media tokens ------------------------------------------------------------


def test_secret_key_is_created_once_with_private_mode(tmp_path):
    path = tmp_path / "secret_key"
    key = media_token.load_or_create_secret(path)
    assert len(key) == 32
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert media_token.load_or_create_secret(path) == key


def test_media_token_roundtrip_and_rejections():
    secret = b"k" * 32
    now = datetime(2026, 1, 1, tzinfo=UTC)
    token, expires = media_token.sign(secret, 7, 3, now)
    assert expires == now + media_token.TOKEN_TTL
    assert media_token.verify(secret, token, 7, now) == 3
    assert media_token.verify(secret, token, 8, now) is None
    assert media_token.verify(b"z" * 32, token, 7, now) is None
    later = now + media_token.TOKEN_TTL + timedelta(seconds=2)
    assert media_token.verify(secret, token, 7, later) is None
    expiry, user_id, mac = token.split(".")
    assert media_token.verify(secret, f"{expiry}.4.{mac}", 7, now) is None
    assert (
        media_token.verify(secret, f"{int(expiry) + 99999}.{user_id}.{mac}", 7, now)
        is None
    )
    assert media_token.verify(secret, "garbage", 7, now) is None


# --- accounts ----------------------------------------------------------------


def test_usernames_are_case_insensitive_and_validated(session):
    accounts.create_user(session, "Alice", "password-one")
    with pytest.raises(accounts.UsernameTaken):
        accounts.create_user(session, "aLICE", "password-two")
    with pytest.raises(accounts.InvalidUsername):
        accounts.create_user(session, "has space", "password-two")
    with pytest.raises(accounts.WeakPassword):
        accounts.create_user(session, "bob", "short")
    assert accounts.get_by_username(session, "ALICE").username == "Alice"


def test_first_user_is_admin_and_adopts_legacy_history(session, add_video):
    from app.services import app_settings

    app_settings.save({"ui": {"theme": "oled"}})
    watched = add_video(
        last_position_sec=40, last_watched_at=datetime(2026, 1, 2, tzinfo=UTC)
    )
    add_video()  # never watched: no row
    admin = accounts.create_user(session, "root", "password-one", is_admin=False)
    member = accounts.create_user(session, "kid", "password-two")
    assert admin.is_admin and not member.is_admin
    rows = session.exec(select(UserVideoState)).all()
    assert [(r.user_id, r.video_id, r.position_sec) for r in rows] == [
        (admin.id, watched.id, 40.0)
    ]
    ui = session.get(UserSettings, admin.id)
    assert ui is not None and '"oled"' in ui.ui_json
    assert session.get(UserSettings, member.id) is None


def test_session_slides_and_expires(session):
    user = accounts.create_user(session, "root", "password-one")
    start = datetime(2026, 1, 1, tzinfo=UTC)
    token = accounts.start_session(session, user, now=start)

    assert accounts.resolve_session(session, token, now=start).id == user.id
    row = session.exec(select(UserSession)).one()
    assert accounts.as_utc(row.expires_at) == start + accounts.SESSION_TTL

    # Within five minutes nothing is written.
    accounts.resolve_session(session, token, now=start + timedelta(minutes=4))
    session.refresh(row)
    assert accounts.as_utc(row.last_seen_at) == start

    # After five minutes the expiry slides forward.
    later = start + timedelta(days=20)
    assert accounts.resolve_session(session, token, now=later) is not None
    session.refresh(row)
    assert accounts.as_utc(row.expires_at) == later + accounts.SESSION_TTL

    assert (
        accounts.resolve_session(
            session, token, now=later + accounts.SESSION_TTL + timedelta(seconds=1)
        )
        is None
    )
    assert accounts.resolve_session(session, "not-a-token") is None


def test_set_password_keeps_only_the_current_session(session):
    user = accounts.create_user(session, "root", "password-one")
    keep = accounts.start_session(session, user)
    other = accounts.start_session(session, user)
    accounts.set_password(
        session, user, "password-new", keep_token_hash=accounts.hash_token(keep)
    )
    assert accounts.resolve_session(session, keep) is not None
    assert accounts.resolve_session(session, other) is None


def test_authenticate_rejects_disabled_unknown_and_wrong(session):
    dummy = passwords.hash_password("nobody")
    user = accounts.create_user(session, "root", "password-one")
    other = accounts.create_user(session, "kid", "password-two")
    assert accounts.authenticate(session, "ROOT", "password-one", dummy_hash=dummy)
    assert not accounts.authenticate(session, "root", "wrong-pass", dummy_hash=dummy)
    assert not accounts.authenticate(session, "ghost", "password-one", dummy_hash=dummy)
    accounts.update_user(session, other.id, disabled=True)
    assert not accounts.authenticate(session, "kid", "password-two", dummy_hash=dummy)
    assert user.last_login_at is not None


def test_last_admin_is_protected(session):
    admin = accounts.create_user(session, "root", "password-one")
    member = accounts.create_user(session, "kid", "password-two")
    with pytest.raises(accounts.LastAdmin):
        accounts.update_user(session, admin.id, is_admin=False)
    with pytest.raises(accounts.LastAdmin):
        accounts.update_user(session, admin.id, disabled=True)
    with pytest.raises(accounts.LastAdmin):
        accounts.delete_user(session, admin.id)
    accounts.update_user(session, member.id, is_admin=True)
    accounts.update_user(session, admin.id, is_admin=False)
    with pytest.raises(accounts.LastAdmin):
        accounts.delete_user(session, member.id)
    accounts.delete_user(session, admin.id)
    assert accounts.count_users(session) == 1


def test_disable_and_password_reset_end_sessions(session):
    accounts.create_user(session, "root", "password-one")
    member = accounts.create_user(session, "kid", "password-two")
    first = accounts.start_session(session, member)
    accounts.update_user(session, member.id, password="password-three")
    assert accounts.resolve_session(session, first) is None
    second = accounts.start_session(session, member)
    accounts.update_user(session, member.id, disabled=True)
    assert accounts.resolve_session(session, second) is None


def test_deleting_a_user_removes_their_history(session, add_video):
    accounts.create_user(session, "root", "password-one")
    member = accounts.create_user(session, "kid", "password-two")
    video = add_video()
    session.add(UserVideoState(user_id=member.id, video_id=video.id, position_sec=9))
    session.commit()
    accounts.delete_user(session, member.id)
    assert session.exec(select(UserVideoState)).all() == []
    assert session.get(type(video), video.id) is not None

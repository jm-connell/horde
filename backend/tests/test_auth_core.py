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


def _ok(secret, token, video_id, epoch, now):
    parsed = media_token.parse(token)
    return parsed is not None and media_token.verify(
        secret, parsed, video_id, epoch, now
    )


def test_media_token_roundtrip_and_rejections():
    secret = b"k" * 32
    now = datetime(2026, 1, 1, tzinfo=UTC)
    token, expires = media_token.sign(secret, 7, 3, "e1", now)
    assert expires == now + media_token.TOKEN_TTL
    assert _ok(secret, token, 7, "e1", now)
    assert not _ok(secret, token, 8, "e1", now)  # another video
    assert not _ok(secret, token, 7, "e2", now)  # password changed since
    assert not _ok(b"z" * 32, token, 7, "e1", now)
    later = now + media_token.TOKEN_TTL + timedelta(seconds=2)
    assert not _ok(secret, token, 7, "e1", later)
    expiry, user_id, mac = token.split(".")
    assert not _ok(secret, f"{expiry}.4.{mac}", 7, "e1", now)
    assert not _ok(secret, f"{int(expiry) + 99999}.{user_id}.{mac}", 7, "e1", now)


@pytest.mark.parametrize(
    "token",
    [
        "garbage",
        "",
        "1.2.3",
        f"1.2.{'a' * 63}",
        f"1.2.{'A' * 64}",  # digest is lowercase hex
        f"1.2.{'a' * 63}\u00e9",  # non-ASCII must be a clean refusal, not a TypeError
        f"1.-2.{'a' * 64}",
        f"{'9' * 40}.2.{'a' * 64}",
        f" 1.2.{'a' * 64}",
    ],
)
def test_malformed_media_tokens_do_not_parse(token):
    assert media_token.parse(token) is None


def test_epoch_changes_with_the_password_hash():
    assert media_token.token_epoch("scrypt$a") != media_token.token_epoch("scrypt$b")
    assert media_token.token_epoch("scrypt$a") == media_token.token_epoch("scrypt$a")


def test_a_short_secret_file_is_refused_not_replaced(tmp_path):
    path = tmp_path / "secret_key"
    path.write_bytes(b"short")
    with pytest.raises(media_token.SecretKeyError):
        media_token.load_or_create_secret(path)
    assert path.read_bytes() == b"short"


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


# --- concurrency -------------------------------------------------------------


def _race(init_db, first, second, rounds=25):
    """Run two removals at once, ``rounds`` times, and return how many admins survive."""
    import threading

    from sqlmodel import Session

    survivors = []
    for i in range(rounds):
        with Session(init_db["engine"]) as s:
            a = accounts.create_user(s, f"a{i}", "password-one", is_admin=True)
            b = accounts.create_user(s, f"b{i}", "password-two", is_admin=True)
            # Everyone else is out of the way so a and b are the only admins.
            for u in accounts.list_users(s):
                if u.id not in (a.id, b.id) and u.is_admin:
                    accounts.update_user(s, u.id, is_admin=False)
            ids = (a.id, b.id)
        barrier = threading.Barrier(2)
        errors: list[Exception] = []

        def run(action, target, barrier=barrier, errors=errors):
            with Session(init_db["engine"]) as s:
                barrier.wait()
                try:
                    action(s, target)
                except accounts.LastAdmin:
                    pass
                except Exception as exc:  # noqa: BLE001 - reported by the assertion below
                    errors.append(exc)

        threads = [
            threading.Thread(target=run, args=(first, ids[1])),
            threading.Thread(target=run, args=(second, ids[0])),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        assert errors == []
        with Session(init_db["engine"]) as s:
            survivors.append(
                len(
                    [u for u in accounts.list_users(s) if u.is_admin and not u.disabled]
                )
            )
            for u in accounts.list_users(s):
                if u.username_norm[0] in "ab":
                    s.delete(u)
            s.commit()
    return survivors


def test_two_admins_deleting_each_other_never_leaves_nobody(init_db, session):
    accounts.create_user(session, "owner", "password-one")
    survivors = _race(
        init_db,
        lambda s, uid: accounts.delete_user(s, uid),
        lambda s, uid: accounts.delete_user(s, uid),
    )
    assert min(survivors) >= 1


def test_delete_racing_disable_never_leaves_nobody(init_db, session):
    accounts.create_user(session, "owner", "password-one")
    survivors = _race(
        init_db,
        lambda s, uid: accounts.delete_user(s, uid),
        lambda s, uid: accounts.update_user(s, uid, disabled=True),
    )
    assert min(survivors) >= 1


def test_concurrent_creation_of_the_same_name_is_a_clean_409(init_db, session):
    import threading

    from sqlmodel import Session

    accounts.create_user(session, "owner", "password-one")
    results: list[str] = []
    barrier = threading.Barrier(4)

    def make():
        with Session(init_db["engine"]) as s:
            barrier.wait()
            try:
                accounts.create_user(s, "Racer", "password-one")
                results.append("created")
            except accounts.UsernameTaken:
                results.append("taken")
            except Exception as exc:  # noqa: BLE001 - reported by the assertion below
                results.append(repr(exc))

    threads = [threading.Thread(target=make) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert sorted(results) == ["created", "taken", "taken", "taken"]


def test_failures_slow_a_username_across_addresses_without_locking_it():
    now = [0.0]
    limiter = LoginLimiter(clock=lambda: now[0])
    for i in range(FREE_ATTEMPTS):
        limiter.record_failure(f"9.9.9.{i}", "admin")
    assert limiter.retry_after("2.2.2.2", "admin") == 0  # a burst is allowed
    limiter.record_failure("1.1.1.1", "admin")
    # Past the burst another address must wait about a second, not for minutes.
    assert limiter.retry_after("2.2.2.2", "admin") == 2  # 1 s window, rounded up
    now[0] += 1.1
    assert limiter.retry_after("2.2.2.2", "admin") == 0
    # A hundred guesses from a hundred addresses never build a lockout for a
    # fresh address: the escalating lockouts are per address.
    for i in range(100):
        limiter.record_failure(f"10.0.{i}.1", "admin")
        now[0] += 1.1
    assert limiter.retry_after("203.0.113.9", "admin") == 0

"""Two-step sign-in: enrolling, checking a code, recovery codes, turning it off.

Per account and optional unless an administrator requires it (the
``require_two_factor`` setting; see ``required_for``). The second factor is a TOTP
code from an authenticator app (``totp.py``) or one of ten single-use recovery
codes.

Storage (``models.User``, ``models.UserRecoveryCode``):

* ``totp_secret`` is kept as it is, like the session secrets: it has to be readable
  to check a code. Protect ``DATA_DIR`` backups. While ``totp_enabled_at`` is empty
  the secret is an enrollment that was never confirmed and is not used to sign in.
* ``totp_last_step`` is the newest 30 second step accepted. A code is accepted only
  for a later step, with a compare-and-set in SQL, so the same code cannot be used
  twice even by two requests at once.
* Recovery codes are stored as an HMAC (keyed with ``DATA_DIR/secret_key``, which is
  not in the database) and deleted when used, with the delete's row count deciding
  who used it.

Everything takes a ``Session`` and commits its own work, like ``accounts.py``.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import logging
import secrets
import time

import segno
from sqlalchemy import delete, func, insert, select, update
from sqlmodel import Session, col

from ...database import rowcount
from ...models import User, UserRecoveryCode, require_id, utcnow
from . import reset_codes, totp
from .accounts import AccountError, UserNotFound
from .sessions import revoke_others

logger = logging.getLogger(__name__)

RECOVERY_CODE_COUNT = 10
#: No 0/O, 1/I/L: a code is written down and typed.
_RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_RECOVERY_LENGTH = 10

#: Values of the ``require_two_factor`` setting.
REQUIRE_OFF = "off"
REQUIRE_ADMINS = "admins"
REQUIRE_EVERYONE = "everyone"
REQUIREMENTS = (REQUIRE_OFF, REQUIRE_ADMINS, REQUIRE_EVERYONE)


class TwoFactorAlreadyEnabled(AccountError):
    status_code = 409
    code = "two_factor_enabled"


class TwoFactorNotEnabled(AccountError):
    status_code = 409
    code = "two_factor_not_enabled"


class NoEnrollment(AccountError):
    status_code = 409
    code = "no_enrollment"


class InvalidCode(AccountError):
    code = "invalid_totp"


def qr_svg(uri: str) -> str:
    """``uri`` as a QR code (SVG markup), drawn here so the secret never leaves the server."""
    out = io.BytesIO()
    segno.make(uri, error="m").save(
        out,
        kind="svg",
        scale=5,
        border=2,
        dark="#000000",
        light="#ffffff",
        xmldecl=False,
        nl=False,
    )
    return out.getvalue().decode("utf-8")


def normalize_requirement(value: object) -> str:
    """The setting as one of ``REQUIREMENTS`` (anything unknown means off)."""
    return value if isinstance(value, str) and value in REQUIREMENTS else REQUIRE_OFF


def required_for(requirement: str, *, is_admin: bool) -> bool:
    """Whether the setting obliges an account of this kind to use two-step sign-in."""
    if requirement == REQUIRE_EVERYONE:
        return True
    return requirement == REQUIRE_ADMINS and is_admin


def is_enabled(user: User) -> bool:
    return user.totp_enabled_at is not None and bool(user.totp_secret)


# --- Enrollment ----------------------------------------------------------------


def begin_enrollment(session: Session, user: User) -> str:
    """Start (or restart) enrollment: a fresh secret that is not yet used to sign in."""
    if is_enabled(user):
        raise TwoFactorAlreadyEnabled("Two-step sign-in is already on")
    secret = totp.new_secret()
    user.totp_secret = secret
    user.totp_last_step = None
    user.updated_at = utcnow()
    session.add(user)
    session.commit()
    session.refresh(user)
    return secret


def confirm_enrollment(
    session: Session,
    user: User,
    code: str,
    *,
    key: bytes,
    now: float | None = None,
) -> list[str]:
    """Turn two-step sign-in on if ``code`` is right; returns the recovery codes (once)."""
    if is_enabled(user):
        raise TwoFactorAlreadyEnabled("Two-step sign-in is already on")
    if not user.totp_secret:
        raise NoEnrollment("Start setting up two-step sign-in first")
    step = totp.match_step(user.totp_secret, code, time.time() if now is None else now)
    if step is None:
        raise InvalidCode(
            "That code is wrong or has expired. Check your app and retry."
        )
    user_id = _uid(user)
    claimed = session.execute(
        update(User)
        .where(
            col(User.id) == user_id,
            col(User.totp_enabled_at).is_(None),
            col(User.totp_secret) == user.totp_secret,
        )
        .values(totp_enabled_at=utcnow(), totp_last_step=step, updated_at=utcnow())
    )
    if rowcount(claimed) != 1:
        session.rollback()
        raise TwoFactorAlreadyEnabled("Two-step sign-in is already on")
    codes = _replace_recovery_codes(session, user_id, key)
    session.commit()
    session.refresh(user)
    logger.info("two-step sign-in turned on for %r", user.username)
    return codes


# --- Checking a code at sign-in ------------------------------------------------


def check_code(
    session: Session,
    user: User,
    code: str,
    *,
    key: bytes,
    now: float | None = None,
) -> str | None:
    """Spend ``code`` (an authenticator code or a recovery code).

    Returns ``"totp"`` or ``"recovery"`` when it was good, ``None`` otherwise.
    A code works once: the step is compare-and-set, the recovery code deleted.
    """
    if not is_enabled(user) or not user.totp_secret:
        return None
    user_id = _uid(user)
    if totp.looks_like_totp(code):
        step = totp.match_step(
            user.totp_secret,
            code,
            time.time() if now is None else now,
            user.totp_last_step,
        )
        if step is None:
            return None
        claimed = session.execute(
            update(User)
            .where(
                col(User.id) == user_id,
                (col(User.totp_last_step).is_(None))
                | (col(User.totp_last_step) < step),
            )
            .values(totp_last_step=step)
        )
        won = rowcount(claimed) == 1
        session.commit()
        if not won:
            return None
        session.refresh(user)
        return "totp"
    digest = _hash_recovery_code(key, user_id, code)
    used = session.execute(
        delete(UserRecoveryCode).where(
            col(UserRecoveryCode.user_id) == user_id,
            col(UserRecoveryCode.code_hash) == digest,
        )
    )
    won = rowcount(used) == 1
    session.commit()
    if not won:
        return None
    logger.warning(
        "recovery code used to sign in as %r (%d left)",
        user.username,
        recovery_codes_left(session, user_id),
    )
    return "recovery"


# --- Recovery codes --------------------------------------------------------------


def regenerate_recovery_codes(session: Session, user: User, *, key: bytes) -> list[str]:
    """A new set of codes; the old ones stop working."""
    if not is_enabled(user):
        raise TwoFactorNotEnabled("Two-step sign-in is not on")
    codes = _replace_recovery_codes(session, _uid(user), key)
    session.commit()
    return codes


def recovery_codes_left(session: Session, user_id: int) -> int:
    return int(
        session.scalar(
            select(func.count(col(UserRecoveryCode.id))).where(
                col(UserRecoveryCode.user_id) == user_id
            )
        )
        or 0
    )


def _replace_recovery_codes(session: Session, user_id: int, key: bytes) -> list[str]:
    session.execute(
        delete(UserRecoveryCode).where(col(UserRecoveryCode.user_id) == user_id)
    )
    codes = [
        "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(_RECOVERY_LENGTH))
        for _ in range(RECOVERY_CODE_COUNT)
    ]
    now = utcnow()
    session.execute(
        insert(UserRecoveryCode),
        [
            {
                "user_id": user_id,
                "code_hash": _hash_recovery_code(key, user_id, code),
                "created_at": now,
            }
            for code in codes
        ],
    )
    return [reset_codes.format_code(code) for code in codes]


def _hash_recovery_code(key: bytes, user_id: int, code: str) -> str:
    message = f"recovery-code|{user_id}|{reset_codes.normalize_code(code)}".encode()
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def admins_without(session: Session) -> list[str]:
    """Usernames of the enabled administrators who have not turned it on."""
    rows = session.scalars(
        select(User)
        .where(
            col(User.is_admin) == True,  # noqa: E712 - SQL column comparison, not a Python truth test
            col(User.disabled) == False,  # noqa: E712 - SQL column comparison, not a Python truth test
        )
        .order_by(col(User.id))
    )
    return [user.username for user in rows if not is_enabled(user)]


# --- Turning it off ------------------------------------------------------------------


def disable(session: Session, user: User) -> None:
    """Forget the secret and the recovery codes."""
    user_id = _uid(user)
    session.execute(
        delete(UserRecoveryCode).where(col(UserRecoveryCode.user_id) == user_id)
    )
    user.totp_secret = None
    user.totp_enabled_at = None
    user.totp_last_step = None
    user.updated_at = utcnow()
    session.add(user)
    session.commit()
    session.refresh(user)
    logger.info("two-step sign-in turned off for %r", user.username)


def reset(session: Session, user_id: int) -> User:
    """Administrator (or CLI) reset: off for the account, and signed out everywhere."""
    user = session.get(User, user_id)
    if user is None:
        raise UserNotFound("User not found")
    disable(session, user)
    revoke_others(session, user_id, None)
    return user


def _uid(user: User) -> int:
    return require_id(user)

"""Users and browser sessions: creation, lookup, password and role changes.

Everything here takes a ``Session`` and commits its own work; the HTTP layer
(``api/auth.py``, ``api/users.py``) and the recovery CLI share it.

Sessions: the cookie holds a random token, the database only its SHA-256, so a
leaked database file cannot be replayed. Expiry slides: a session lives 30 days
from its last use, and ``last_seen_at`` is only rewritten every five minutes so
a busy page does not write on every request.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, func, insert, literal, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from ...models import (
    User,
    UserSession,
    UserSettings,
    UserVideoState,
    Video,
    VideoAiChatMessage,
    as_utc,
    utcnow,
)
from .. import app_settings
from . import passwords, permissions

logger = logging.getLogger(__name__)

SESSION_COOKIE = "horde_session"
SESSION_TTL = timedelta(days=30)
#: ``last_seen_at`` (and the sliding expiry) is refreshed at most this often.
TOUCH_INTERVAL = timedelta(minutes=5)
USER_AGENT_MAX = 200
IP_MAX = 64

USERNAME_RE = re.compile(r"[\w.@+\-]{1,64}")


class AccountError(Exception):
    """A refused account operation. ``code`` is machine readable for the SPA."""

    status_code = 400
    code = "invalid_request"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class InvalidUsername(AccountError):
    code = "invalid_username"


class WeakPassword(AccountError):
    code = "weak_password"


class UsernameTaken(AccountError):
    status_code = 409
    code = "username_taken"


class LastAdmin(AccountError):
    status_code = 409
    code = "last_admin"


class UserNotFound(AccountError):
    status_code = 404
    code = "user_not_found"


class InvalidPermission(AccountError):
    code = "invalid_permission"


class AlreadyBootstrapped(AccountError):
    status_code = 409
    code = "already_bootstrapped"


@dataclass(frozen=True)
class AuthUser:
    """The signed-in user as request code sees it (detached from any Session)."""

    id: int
    username: str
    is_admin: bool
    #: Effective permissions: everything for an administrator.
    permissions: frozenset[str] = frozenset()

    @classmethod
    def of(cls, user: User) -> AuthUser:
        return cls(
            id=_uid(user),
            username=user.username,
            is_admin=user.is_admin,
            permissions=effective_permissions(user),
        )

    def can(self, permission: str) -> bool:
        return permission in self.permissions


def effective_permissions(user: User) -> frozenset[str]:
    if user.is_admin:
        return permissions.ALL_PERMISSIONS
    return permissions.parse(user.permissions)


def _checked_permissions(names: list[str] | set[str] | frozenset[str]) -> str:
    try:
        return permissions.dump(permissions.validate(names))
    except permissions.UnknownPermission as exc:
        raise InvalidPermission(str(exc)) from exc


def _uid(user: User) -> int:
    """The id of a persisted user (``None`` only before the first flush)."""
    if user.id is None:
        raise RuntimeError("user has not been saved yet")
    return user.id


# --- Users -------------------------------------------------------------------


def clean_username(raw: str) -> tuple[str, str]:
    """``(as entered, lowercased identity)`` or ``InvalidUsername``."""
    name = (raw or "").strip()
    if not USERNAME_RE.fullmatch(name):
        raise InvalidUsername(
            "Username must be 1-64 characters: letters, digits, and . _ - @ +"
        )
    return name, name.lower()


def _check_password(password: str, username: str) -> None:
    try:
        passwords.validate_password(password, username)
    except passwords.PasswordPolicyError as exc:
        raise WeakPassword(str(exc)) from exc


def count_users(session: Session) -> int:
    return int(session.scalar(select(func.count(User.id))) or 0)


def get_user(session: Session, user_id: int) -> User | None:
    return session.get(User, user_id)


def get_by_username(session: Session, username: str) -> User | None:
    return session.scalar(
        select(User).where(User.username_norm == (username or "").strip().lower())
    )


def list_users(session: Session) -> list[User]:
    return list(session.scalars(select(User).order_by(User.id)))


def first_admin(session: Session) -> User | None:
    """The oldest enabled administrator (the identity when sign-in is disabled)."""
    return session.scalar(
        select(User)
        .where(User.is_admin == True, User.disabled == False)  # noqa: E712 - SQL column comparison, not a Python truth test
        .order_by(User.id)
        .limit(1)
    )


def create_user(
    session: Session,
    username: str,
    password: str,
    *,
    is_admin: bool = False,
    granted: list[str] | set[str] | frozenset[str] | None = None,
) -> User:
    """Add a user. The very first user is always an administrator.

    Creating the first user also adopts the single-user data that predates
    accounts: the watch history on ``videos`` and the global ``ui`` settings
    become that administrator's.
    """
    name, norm = clean_username(username)
    _check_password(password, name)
    if get_by_username(session, norm) is not None:
        raise UsernameTaken(f"The username {name!r} is already taken")
    first = count_users(session) == 0
    grants = (
        _checked_permissions(permissions.DEFAULT_PERMISSIONS)
        if granted is None
        else _checked_permissions(granted)
    )
    user = User(
        permissions=grants,
        username=name,
        username_norm=norm,
        password_hash=passwords.hash_password(password),
        is_admin=is_admin or first,
    )
    session.add(user)
    try:
        # The unique index on username_norm is the real guard: two requests can
        # both pass the lookup above.
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise UsernameTaken(f"The username {name!r} is already taken") from exc
    if first:
        _adopt_legacy_data(session, user)
    session.commit()
    session.refresh(user)
    logger.info("Created %s %r", "administrator" if user.is_admin else "user", name)
    return user


def _adopt_legacy_data(session: Session, user: User) -> None:
    """Move the pre-accounts history and UI preferences to the first user."""
    moved = session.execute(
        insert(UserVideoState).from_select(
            ["user_id", "video_id", "position_sec", "last_watched_at"],
            select(
                literal(_uid(user)),
                Video.id,
                Video.last_position_sec,
                Video.last_watched_at,
            ).where(
                or_(Video.last_watched_at.is_not(None), Video.last_position_sec > 0)
            ),
        )
    )
    session.execute(
        update(VideoAiChatMessage)
        .where(VideoAiChatMessage.user_id.is_(None))  # type: ignore[union-attr]
        .values(user_id=_uid(user))
    )
    ui = app_settings.load().get("ui")
    session.add(
        UserSettings(
            user_id=_uid(user),
            ui_json=json.dumps(ui if isinstance(ui, dict) else {}),
        )
    )
    logger.info(
        "Moved %s watch history rows to the first administrator", moved.rowcount
    )


def authenticate(
    session: Session, username: str, password: str, *, dummy_hash: str
) -> User | None:
    """The user for a correct name and password, else ``None``.

    An unknown name still pays for a full hash check (against ``dummy_hash``) so
    response time does not reveal which names exist. Disabled accounts fail
    exactly like a wrong password.
    """
    user = get_by_username(session, username)
    stored = user.password_hash if user is not None else dummy_hash
    matched = passwords.verify_password(password, stored)
    if user is None or not matched or user.disabled:
        return None
    if passwords.needs_rehash(user.password_hash):
        user.password_hash = passwords.hash_password(password)
    user.last_login_at = utcnow()
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def set_password(
    session: Session,
    user: User,
    new_password: str,
    *,
    keep_token_hash: str | None = None,
) -> None:
    """Store a new password and sign the user out everywhere but ``keep_token_hash``."""
    _check_password(new_password, user.username)
    user.password_hash = passwords.hash_password(new_password)
    user.updated_at = utcnow()
    session.add(user)
    _delete_sessions(session, _uid(user), keep_token_hash=keep_token_hash)
    session.commit()


def _enabled_admin_count(session: Session) -> int:
    return int(
        session.scalar(
            select(func.count(User.id)).where(
                User.is_admin == True,  # noqa: E712 - SQL column comparison, not a Python truth test
                User.disabled == False,  # noqa: E712 - SQL column comparison, not a Python truth test
            )
        )
        or 0
    )


def _is_active_admin(user: User) -> bool:
    return user.is_admin and not user.disabled


def update_user(
    session: Session,
    user_id: int,
    *,
    is_admin: bool | None = None,
    disabled: bool | None = None,
    password: str | None = None,
    granted: list[str] | set[str] | frozenset[str] | None = None,
    keep_token_hash: str | None = None,
) -> User:
    """Admin edit of another (or the same) account.

    Refuses any change that would leave no enabled administrator. Disabling an
    account, or resetting its password, signs it out everywhere.
    """
    user = session.get(User, user_id)
    if user is None:
        raise UserNotFound("User not found")
    was_active_admin = _is_active_admin(user)
    if is_admin is not None:
        user.is_admin = is_admin
    if disabled is not None:
        user.disabled = disabled
    # The pending change is flushed by the count query, so zero means "nobody left".
    if (
        was_active_admin
        and not _is_active_admin(user)
        and _enabled_admin_count(session) == 0
    ):
        session.rollback()
        raise LastAdmin(
            "This is the last administrator. Make someone else an administrator first."
        )
    if granted is not None:
        user.permissions = _checked_permissions(granted)
    revoke = disabled is True
    if password is not None:
        _check_password(password, user.username)
        user.password_hash = passwords.hash_password(password)
        revoke = True
    user.updated_at = utcnow()
    session.add(user)
    if revoke:
        _delete_sessions(session, user_id, keep_token_hash=keep_token_hash)
    session.commit()
    session.refresh(user)
    return user


def delete_user(session: Session, user_id: int) -> None:
    """Remove an account, its sessions, history and UI preferences."""
    user = session.get(User, user_id)
    if user is None:
        raise UserNotFound("User not found")
    was_active_admin = _is_active_admin(user)
    # Explicit deletes as well as the FK cascades, matching delete_video_cascade.
    _delete_sessions(session, user_id)
    session.execute(delete(UserVideoState).where(UserVideoState.user_id == user_id))
    session.execute(delete(UserSettings).where(UserSettings.user_id == user_id))
    session.execute(
        delete(VideoAiChatMessage).where(VideoAiChatMessage.user_id == user_id)
    )
    session.delete(user)
    if was_active_admin:
        # Decide after writing: the delete takes SQLite's write lock, so the count
        # sees every concurrent change that committed first. Counting before
        # writing let two admins delete each other and leave nobody.
        session.flush()
        if _enabled_admin_count(session) == 0:
            session.rollback()
            raise LastAdmin("This is the last administrator and cannot be deleted")
    session.commit()


# --- Sessions ----------------------------------------------------------------


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def start_session(
    session: Session,
    user: User,
    *,
    user_agent: str | None = None,
    ip: str | None = None,
    now: datetime | None = None,
) -> str:
    """Create a session row and return the cookie token (shown only once)."""
    now = now or utcnow()
    token = secrets.token_urlsafe(32)
    session.execute(delete(UserSession).where(UserSession.expires_at < now))
    session.add(
        UserSession(
            user_id=_uid(user),
            token_hash=hash_token(token),
            created_at=now,
            last_seen_at=now,
            expires_at=now + SESSION_TTL,
            user_agent=(user_agent or "")[:USER_AGENT_MAX] or None,
            ip=(ip or "")[:IP_MAX] or None,
        )
    )
    session.commit()
    return token


def resolve_session(
    session: Session, token: str, *, now: datetime | None = None
) -> AuthUser | None:
    """The user a cookie token belongs to, sliding the expiry. ``None`` if not valid."""
    now = now or utcnow()
    row = session.execute(
        select(UserSession, User)
        .join(User, User.id == UserSession.user_id)
        .where(UserSession.token_hash == hash_token(token))
    ).first()
    if row is None:
        return None
    user_session, user = row
    if user.disabled or as_utc(user_session.expires_at) < now:
        return None
    if now - as_utc(user_session.last_seen_at) >= TOUCH_INTERVAL:
        session.execute(
            update(UserSession)
            .where(UserSession.id == user_session.id)
            .values(last_seen_at=now, expires_at=now + SESSION_TTL)
        )
        session.commit()
    return AuthUser.of(user)


def end_session(session: Session, token: str) -> None:
    session.execute(
        delete(UserSession).where(UserSession.token_hash == hash_token(token))
    )
    session.commit()


def _delete_sessions(
    session: Session, user_id: int, *, keep_token_hash: str | None = None
) -> None:
    statement = delete(UserSession).where(UserSession.user_id == user_id)
    if keep_token_hash is not None:
        statement = statement.where(UserSession.token_hash != keep_token_hash)
    session.execute(statement)

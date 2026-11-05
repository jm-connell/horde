"""One-time invite links: an administrator makes one, a household member opens it
and picks their own username and password.

The link carries a random token (``secrets.token_urlsafe(24)``, 192 bits); only
its SHA-256 is stored, like session tokens. An invite works once and only until
it expires, and the new account is always a member with the permissions the
administrator chose. Claiming it and creating the account are one transaction,
so two people opening the same link cannot both get an account.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta

from sqlmodel import Session, col, select, update

from ...models import User, UserInvite, require_id, utcnow
from . import accounts, permissions

logger = logging.getLogger(__name__)

DEFAULT_DAYS = 7
MAX_DAYS = 30


class InvalidInvite(accounts.AccountError):
    status_code = 404
    code = "invite_invalid"


def _hash(token: str) -> str:
    return accounts.hash_token(token)


def create(
    session: Session,
    created_by: int,
    *,
    granted: list[str] | None,
    label: str | None,
    days: int = DEFAULT_DAYS,
    now: datetime | None = None,
) -> tuple[UserInvite, str]:
    """Store a new invite; return it and the token (shown only this once).

    ``granted`` None gives the default member permissions.
    """
    now = now or utcnow()
    names = permissions.DEFAULT_PERMISSIONS if granted is None else granted
    try:
        perms = permissions.dump(permissions.validate(names))
    except permissions.UnknownPermission as exc:
        raise accounts.InvalidPermission(str(exc)) from exc
    token = secrets.token_urlsafe(24)
    invite = UserInvite(
        token_hash=_hash(token),
        label=(label or "").strip()[:60] or None,
        permissions=perms,
        created_by=created_by,
        created_at=now,
        expires_at=now + timedelta(days=max(1, min(days, MAX_DAYS))),
    )
    session.add(invite)
    session.commit()
    session.refresh(invite)
    return invite, token


def pending(session: Session, now: datetime | None = None) -> list[UserInvite]:
    """Invites not used yet and not expired, newest first."""
    now = now or utcnow()
    return list(
        session.exec(
            select(UserInvite)
            .where(col(UserInvite.used_at).is_(None))
            .where(col(UserInvite.expires_at) > now)
            .order_by(col(UserInvite.created_at).desc())
        ).all()
    )


def revoke(session: Session, invite_id: int) -> bool:
    """Delete an unused invite. False when there is none (or it was used)."""
    invite = session.get(UserInvite, invite_id)
    if invite is None or invite.used_at is not None:
        return False
    session.delete(invite)
    session.commit()
    return True


def find_valid(
    session: Session, token: str, now: datetime | None = None
) -> UserInvite | None:
    """The unused, unexpired invite for ``token``."""
    now = now or utcnow()
    invite = session.exec(
        select(UserInvite).where(UserInvite.token_hash == _hash(token))
    ).first()
    if invite is None or invite.used_at is not None:
        return None
    expires = invite.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=now.tzinfo)
    return invite if expires > now else None


def redeem(
    session: Session,
    token: str,
    username: str,
    password: str,
    *,
    now: datetime | None = None,
) -> User:
    """Create the member account an invite is for, using the invite up.

    Raises ``InvalidInvite`` for an unknown, used or expired token, and the usual
    ``AccountError`` for a taken name or an empty password (the invite then
    still works).
    """
    now = now or utcnow()
    invite = find_valid(session, token, now)
    if invite is None:
        raise InvalidInvite(
            "This invite link is not valid. It may have been used or expired."
        )
    invite_id = require_id(invite)
    # Claim it first: only one request can turn used_at from NULL to now.
    claimed = session.execute(
        update(UserInvite)
        .where(col(UserInvite.id) == invite_id)
        .where(col(UserInvite.used_at).is_(None))
        .values(used_at=now)
    )
    if getattr(claimed, "rowcount", 0) != 1:
        session.rollback()
        raise InvalidInvite("This invite link has just been used.")
    try:
        # Commits the claim together with the new account.
        user = accounts.create_user(
            session,
            username,
            password,
            granted=permissions.parse(invite.permissions),
        )
    except accounts.AccountError:
        session.rollback()  # the invite stays unused
        raise
    session.execute(
        update(UserInvite)
        .where(col(UserInvite.id) == invite_id)
        .values(used_by=require_id(user))
    )
    session.commit()
    logger.info("%r joined with an invite", user.username)
    return user

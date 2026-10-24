"""Signed-in devices: listing and ending a user's browser sessions.

The cookie token is never stored, only its hash, so "the current session" is found
by hashing the request's cookie. Ending a session deletes its row; the next
request with that cookie is a 401, and an open event stream notices at its next
re-check (``StreamAuthGuard``), the same way it does for a reset password.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, select
from sqlmodel import Session, col

from ...database import rowcount
from ...models import UserSession, as_utc, require_id, utcnow
from . import user_agent
from .accounts import AccountError, hash_token


class SessionNotFound(AccountError):
    status_code = 404
    code = "session_not_found"


@dataclass(frozen=True)
class SessionInfo:
    id: int
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ip: str | None
    user_agent: str | None
    device: str
    current: bool


def list_sessions(
    session: Session, user_id: int, *, current_token: str | None = None
) -> list[SessionInfo]:
    """The user's live sessions, most recently active first. Expired ones are skipped."""
    current_hash = hash_token(current_token) if current_token else None
    rows = session.scalars(
        select(UserSession)
        .where(
            col(UserSession.user_id) == user_id,
            col(UserSession.expires_at) >= utcnow(),
        )
        .order_by(col(UserSession.last_seen_at).desc(), col(UserSession.id).desc())
    )
    return [
        SessionInfo(
            id=require_id(row),
            created_at=as_utc(row.created_at),
            last_seen_at=as_utc(row.last_seen_at),
            expires_at=as_utc(row.expires_at),
            ip=row.ip,
            user_agent=row.user_agent,
            device=user_agent.describe(row.user_agent),
            current=current_hash is not None and row.token_hash == current_hash,
        )
        for row in rows
    ]


def revoke(session: Session, user_id: int, session_id: int) -> str:
    """End one of ``user_id``'s sessions; return its token hash. Others' ids are 404."""
    row = session.scalar(
        select(UserSession).where(
            col(UserSession.id) == session_id, col(UserSession.user_id) == user_id
        )
    )
    if row is None:
        raise SessionNotFound("That device is not signed in")
    token_hash = row.token_hash
    session.execute(delete(UserSession).where(col(UserSession.id) == session_id))
    session.commit()
    return token_hash


def revoke_others(session: Session, user_id: int, current_token: str | None) -> int:
    """Sign ``user_id`` out everywhere except the browser holding ``current_token``."""
    statement = delete(UserSession).where(col(UserSession.user_id) == user_id)
    if current_token:
        statement = statement.where(
            col(UserSession.token_hash) != hash_token(current_token)
        )
    count = rowcount(session.execute(statement))
    session.commit()
    return count

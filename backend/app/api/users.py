"""User management. Administrators only."""

from __future__ import annotations

import logging
from contextlib import AbstractContextManager
from dataclasses import asdict
from typing import cast

from fastapi import APIRouter, Depends, Request, Response
from sqlmodel import Session

from ..auth import ensure_recent_auth, require_admin, require_recent_auth
from ..context import get_session
from ..errors import CodedHTTPException
from ..models import User, as_utc, require_id
from ..schemas import (
    PermissionInfo,
    SessionList,
    SessionRead,
    UserCreate,
    UserRead,
    UserUpdate,
)
from ..services.auth import accounts, avatars, permissions, sessions, two_factor
from ..services.auth.accounts import AuthUser
from ..services.auth.runtime import AuthRuntime

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/users", tags=["users"], dependencies=[Depends(require_admin)]
)


def _hashing(request: Request) -> AbstractContextManager[None]:
    """A slot from the app's password-hashing cap (503 ``busy`` when none is free)."""
    return cast(AuthRuntime, request.app.state.auth).hashing.slot()


def _read(user: User) -> UserRead:
    return UserRead(
        id=require_id(user),
        username=user.username,
        is_admin=user.is_admin,
        disabled=user.disabled,
        permissions=sorted(accounts.effective_permissions(user)),
        created_at=as_utc(user.created_at),
        last_login_at=as_utc(user.last_login_at),
        avatar_version=user.avatar_version,
        share_downloads=user.share_downloads,
        two_factor_enabled=two_factor.is_enabled(user),
    )


@router.get("", response_model=list[UserRead])
def list_users(session: Session = Depends(get_session)):
    return [_read(u) for u in accounts.list_users(session)]


@router.get("/permissions", response_model=list[PermissionInfo])
def list_permissions():
    """The grantable permissions with their descriptions and default."""
    return [
        PermissionInfo(
            name=p.name, label=p.label, description=p.description, default=p.default
        )
        for p in permissions.PERMISSION_TABLE
    ]


@router.post(
    "",
    response_model=UserRead,
    status_code=201,
    dependencies=[Depends(require_recent_auth)],
)
def create_user(
    payload: UserCreate, request: Request, session: Session = Depends(get_session)
):
    with _hashing(request):
        user = accounts.create_user(
            session,
            payload.username,
            payload.password,
            is_admin=payload.is_admin,
            granted=payload.permissions,
            share_downloads=payload.share_downloads,
        )
    return _read(user)


@router.patch("/{user_id}", response_model=UserRead)
def update_user(
    user_id: int,
    payload: UserUpdate,
    request: Request,
    session: Session = Depends(get_session),
    admin: AuthUser = Depends(require_admin),
):
    changes = payload.model_fields_set
    sets_password = payload.password is not None
    if sets_password and user_id == admin.id:
        # Setting your own password needs the current one (and signs your other
        # browsers out): a stolen session must not be able to choose it.
        raise CodedHTTPException(
            400,
            "Change your own password in Account settings; it asks for the current one.",
            "use_change_password",
        )
    target = accounts.get_user(session, user_id)
    if (
        sets_password  # another account's
        or (payload.is_admin is True and target is not None and not target.is_admin)
    ):
        ensure_recent_auth(request, session)
    # Another admin has to take away an admin's access, so nobody locks
    # themselves out (and a lone admin can never leave the server ownerless).
    if user_id == admin.id and (payload.is_admin is False or payload.disabled):
        raise accounts.SelfLockout(
            "You can't remove your own administrator access or disable your own "
            "account. Ask another administrator to do it."
        )
    with _hashing(request):
        user = accounts.update_user(
            session,
            user_id,
            is_admin=payload.is_admin if "is_admin" in changes else None,
            disabled=payload.disabled if "disabled" in changes else None,
            password=payload.password,
            granted=payload.permissions if "permissions" in changes else None,
            share_downloads=payload.share_downloads,
        )
    return _read(user)


@router.delete(
    "/{user_id}", status_code=204, dependencies=[Depends(require_recent_auth)]
)
def delete_user(
    user_id: int,
    session: Session = Depends(get_session),
    admin: AuthUser = Depends(require_admin),
):
    accounts.delete_user(session, user_id, successor_id=admin.id)
    avatars.unlink_avatars(user_id)
    return Response(status_code=204)


@router.delete(
    "/{user_id}/two-factor",
    status_code=204,
    dependencies=[Depends(require_recent_auth)],
)
def reset_user_two_factor(
    user_id: int,
    session: Session = Depends(get_session),
    admin: AuthUser = Depends(require_admin),
):
    """Take two-step sign-in off an account (a lost phone and recovery codes).

    Signs the account out everywhere; their next sign-in is password only (or the
    enrollment screen, if two-step sign-in is required). Not for your own account:
    turn that off in Account settings, which asks for your password and a code.
    """
    if user_id == admin.id:
        raise accounts.SelfLockout(
            "Turn off your own two-step sign-in in Account settings."
        )
    _require_user(session, user_id)
    two_factor.reset(session, user_id)
    logger.warning(
        "administrator %r reset two-step sign-in of user %d", admin.username, user_id
    )
    return Response(status_code=204)


def _require_user(session: Session, user_id: int) -> None:
    if accounts.get_user(session, user_id) is None:
        raise accounts.UserNotFound("No such user")


@router.get("/{user_id}/sessions", response_model=SessionList)
def list_user_sessions(
    user_id: int,
    request: Request,
    session: Session = Depends(get_session),
):
    """A member's signed-in devices (for an administrator ending one)."""
    _require_user(session, user_id)
    token = request.cookies.get(accounts.SESSION_COOKIE)
    rows = sessions.list_sessions(session, user_id, current_token=token)
    return SessionList(items=[SessionRead(**asdict(row)) for row in rows])


@router.delete("/{user_id}/sessions", status_code=204)
def revoke_user_sessions(
    user_id: int,
    request: Request,
    session: Session = Depends(get_session),
    admin: AuthUser = Depends(require_admin),
):
    """Sign a user out of every device. For another account this needs a recent password check."""
    _require_user(session, user_id)
    if user_id != admin.id:
        ensure_recent_auth(request, session)
    sessions.revoke_others(session, user_id, None)
    return Response(status_code=204)


@router.delete("/{user_id}/sessions/{session_id}", status_code=204)
def revoke_user_session(
    user_id: int, session_id: int, session: Session = Depends(get_session)
):
    """Sign one of a user's devices out."""
    _require_user(session, user_id)
    sessions.revoke(session, user_id, session_id)
    return Response(status_code=204)

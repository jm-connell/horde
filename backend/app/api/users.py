"""User management. Administrators only."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from sqlmodel import Session

from ..auth import require_admin
from ..context import get_session
from ..models import User, as_utc
from ..schemas import PermissionInfo, UserCreate, UserRead, UserUpdate
from ..services.auth import accounts, permissions
from ..services.auth.accounts import AuthUser

router = APIRouter(
    prefix="/api/users", tags=["users"], dependencies=[Depends(require_admin)]
)


def _read(user: User) -> UserRead:
    return UserRead(
        id=user.id,  # type: ignore[arg-type]
        username=user.username,
        is_admin=user.is_admin,
        disabled=user.disabled,
        permissions=sorted(accounts.effective_permissions(user)),
        created_at=as_utc(user.created_at) or user.created_at,
        last_login_at=as_utc(user.last_login_at),
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


@router.post("", response_model=UserRead, status_code=201)
def create_user(payload: UserCreate, session: Session = Depends(get_session)):
    user = accounts.create_user(
        session,
        payload.username,
        payload.password,
        is_admin=payload.is_admin,
        granted=payload.permissions,
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
    # Resetting your own password must not sign you out of this browser.
    token = request.cookies.get(accounts.SESSION_COOKIE)
    keep = accounts.hash_token(token) if token and user_id == admin.id else None
    user = accounts.update_user(
        session,
        user_id,
        is_admin=payload.is_admin if "is_admin" in changes else None,
        disabled=payload.disabled if "disabled" in changes else None,
        password=payload.password if "password" in changes else None,
        granted=payload.permissions if "permissions" in changes else None,
        keep_token_hash=keep,
    )
    return _read(user)


@router.delete("/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    session: Session = Depends(get_session),
    _admin: AuthUser = Depends(require_admin),
):
    accounts.delete_user(session, user_id)
    return Response(status_code=204)

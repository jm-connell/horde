"""Sign-in, sign-out, first-run bootstrap and the caller's own account."""

from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from sqlmodel import Session

from ..auth import CodedHTTPException, current_user
from ..database import get_session
from ..schemas import (
    AuthLoginResult,
    AuthState,
    AuthUserRead,
    BootstrapRequest,
    LoginRequest,
    PasswordChange,
)
from ..services import app_settings
from ..services.auth import accounts, passwords
from ..services.auth.accounts import AuthUser
from ..services.auth.runtime import AuthRuntime

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _runtime(request: Request) -> AuthRuntime:
    return request.app.state.auth


def user_read(user: AuthUser) -> AuthUserRead:
    return AuthUserRead(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        permissions=sorted(user.permissions),
    )


def _set_session_cookie(
    response: Response, request: Request, runtime: AuthRuntime, token: str
) -> None:
    response.set_cookie(
        accounts.SESSION_COOKIE,
        token,
        max_age=int(accounts.SESSION_TTL / timedelta(seconds=1)),
        httponly=True,
        samesite="lax",
        secure=runtime.is_https(request),
        path="/",
    )


def _open_session(
    session: Session,
    request: Request,
    response: Response,
    runtime: AuthRuntime,
    user,
) -> None:
    token = accounts.start_session(
        session,
        user,
        user_agent=request.headers.get("user-agent"),
        ip=runtime.client_address(request),
    )
    _set_session_cookie(response, request, runtime, token)


@router.get("/state", response_model=AuthState)
def auth_state(request: Request, session: Session = Depends(get_session)):
    """What the SPA needs to decide between setup, sign-in and the app."""
    user: AuthUser | None = getattr(request.state, "user", None)
    return AuthState(
        users_exist=accounts.count_users(session) > 0,
        authenticated=user is not None,
        user=user_read(user) if user else None,
        setup_completed=bool(app_settings.load().get("setup_completed")),
    )


@router.post("/bootstrap", response_model=AuthLoginResult)
def bootstrap(
    payload: BootstrapRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    """Create the first (administrator) account. Refused once any user exists."""
    runtime = _runtime(request)
    with runtime.bootstrap_lock:
        if accounts.count_users(session) > 0:
            raise accounts.AlreadyBootstrapped("An account already exists")
        user = accounts.create_user(
            session, payload.username, payload.password, is_admin=True
        )
    _open_session(session, request, response, runtime, user)
    return AuthLoginResult(user=user_read(AuthUser.of(user)))


@router.post("/login", response_model=AuthLoginResult)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    runtime = _runtime(request)
    if runtime.config.disabled:
        raise CodedHTTPException(
            400, "Sign-in is disabled on this server", "auth_disabled"
        )
    address = runtime.client_address(request)
    norm = payload.username.strip().lower()
    wait = runtime.limiter.retry_after(address, norm)
    if wait:
        raise CodedHTTPException(
            429,
            f"Too many failed attempts. Try again in {wait} seconds.",
            "rate_limited",
            headers={"Retry-After": str(wait)},
        )
    user = accounts.authenticate(
        session, payload.username, payload.password, dummy_hash=runtime.dummy_hash()
    )
    if user is None:
        runtime.limiter.record_failure(address, norm)
        logger.warning("Failed sign-in for %r from %s", norm[:64], address)
        raise CodedHTTPException(
            401, "Invalid username or password", "invalid_credentials"
        )
    runtime.limiter.record_success(address, norm)
    _open_session(session, request, response, runtime, user)
    return AuthLoginResult(user=user_read(AuthUser.of(user)))


@router.post("/logout", status_code=204)
def logout(
    request: Request,
    session: Session = Depends(get_session),
    _user: AuthUser = Depends(current_user),
):
    token = request.cookies.get(accounts.SESSION_COOKIE)
    if token:
        accounts.end_session(session, token)
    response = Response(status_code=204)
    response.delete_cookie(accounts.SESSION_COOKIE, path="/")
    return response


@router.post("/password", status_code=204)
def change_password(
    payload: PasswordChange,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Change your own password. Your other browsers are signed out."""
    runtime = _runtime(request)
    address = runtime.client_address(request)
    # Guessing the current password is guessing the password: same throttle as
    # sign-in, counted separately so it cannot lock the account out of signing in.
    throttle_key = f"password:{user.username.lower()}"
    wait = runtime.limiter.retry_after(address, throttle_key)
    if wait:
        raise CodedHTTPException(
            429,
            f"Too many failed attempts. Try again in {wait} seconds.",
            "rate_limited",
            headers={"Retry-After": str(wait)},
        )
    row = accounts.get_user(session, user.id)
    if row is None or not passwords.verify_password(
        payload.current_password, row.password_hash
    ):
        runtime.limiter.record_failure(address, throttle_key)
        raise CodedHTTPException(400, "Current password is incorrect", "wrong_password")
    runtime.limiter.record_success(address, throttle_key)
    token = request.cookies.get(accounts.SESSION_COOKIE)
    accounts.set_password(
        session,
        row,
        payload.new_password,
        keep_token_hash=accounts.hash_token(token) if token else None,
    )
    return Response(status_code=204)

"""Sign-in, sign-out, first-run bootstrap and the caller's own account."""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import timedelta
from typing import cast

from fastapi import APIRouter, Depends, Request, Response, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session

from ..auth import CodedHTTPException, current_user
from ..context import get_session
from ..models import User, require_id
from ..openapi_responses import IMAGE_JPEG, RAW
from ..schemas import (
    AuthLoginResult,
    AuthState,
    AuthUserRead,
    BootstrapRequest,
    ForgotPasswordRequest,
    LoginRequest,
    PasswordChange,
    PasswordResetRequest,
    SessionList,
    SessionRead,
)
from ..services import app_settings, uploads
from ..services.auth import accounts, avatars, passwords, reset_codes, sessions
from ..services.auth.accounts import AuthUser
from ..services.auth.runtime import AuthRuntime

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _runtime(request: Request) -> AuthRuntime:
    return cast(AuthRuntime, request.app.state.auth)


def user_read(user: AuthUser) -> AuthUserRead:
    return AuthUserRead(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        permissions=sorted(user.permissions),
        avatar_version=user.avatar_version,
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
    # The password was remembered after all: pending reset codes go.
    runtime.reset_codes.discard(user.username_norm)
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


def _refuse_when_auth_disabled(runtime: AuthRuntime) -> None:
    if runtime.config.disabled:
        raise CodedHTTPException(
            400, "Sign-in is disabled on this server", "auth_disabled"
        )


@router.post("/forgot", status_code=204)
def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Write a one-time reset code for ``username`` to the server log.

    The answer is the same whether or not the account exists, so the form does
    not reveal usernames. The code reaches only whoever can read the log.
    """
    runtime = _runtime(request)
    _refuse_when_auth_disabled(runtime)
    user = accounts.get_by_username(session, payload.username)
    if user is None or user.disabled:
        return Response(status_code=204)
    code = runtime.reset_codes.issue(
        user.username_norm,
        reset_codes.account_binding(require_id(user), user.password_hash),
    )
    if code is None:
        return Response(status_code=204)  # asked again within the cooldown
    minutes = int(reset_codes.CODE_TTL_SEC // 60)
    logger.warning(
        "PASSWORD RESET CODE for %r: %s  (asked from %s; valid %d minutes, "
        "single use). Enter it on the sign-in page under 'Forgot password?'.",
        user.username,
        code,
        runtime.client_address(request),
        minutes,
    )
    return Response(status_code=204)


@router.post("/reset", response_model=AuthLoginResult)
def reset_password(
    payload: PasswordResetRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    """Set a new password with a code from the server log, and sign in.

    Every other session of the account is signed out.
    """
    runtime = _runtime(request)
    _refuse_when_auth_disabled(runtime)
    address = runtime.client_address(request)
    norm = payload.username.strip().lower()
    throttle_key = f"reset:{norm}"
    wait = runtime.limiter.retry_after(address, throttle_key)
    if wait:
        raise CodedHTTPException(
            429,
            f"Too many failed attempts. Try again in {wait} seconds.",
            "rate_limited",
            headers={"Retry-After": str(wait)},
        )
    # Refuse a weak password before using the code, so it can be retried. Run
    # for every name, known or not, so the answer does not reveal accounts.
    accounts.check_password_policy(payload.new_password, payload.username.strip())
    user = accounts.get_by_username(session, payload.username)
    # One step under a lock: a code works for exactly one request.
    if (
        user is None
        or user.disabled
        or not runtime.reset_codes.redeem(
            user.username_norm,
            payload.code,
            reset_codes.account_binding(require_id(user), user.password_hash),
        )
    ):
        runtime.limiter.record_failure(address, throttle_key)
        raise CodedHTTPException(
            400,
            "That reset code is wrong or has expired. Ask for a new one.",
            "invalid_reset_code",
        )
    runtime.limiter.record_success(address, throttle_key)
    accounts.set_password(session, user, payload.new_password)
    logger.info("password reset with a log code for %r", user.username)
    _open_session(session, request, response, runtime, user)
    return AuthLoginResult(user=user_read(AuthUser.of(user)))


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


@router.get("/sessions", response_model=SessionList)
def list_my_sessions(
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Your signed-in devices, most recently active first."""
    token = request.cookies.get(accounts.SESSION_COOKIE)
    rows = sessions.list_sessions(session, user.id, current_token=token)
    return SessionList(items=[SessionRead(**asdict(row)) for row in rows])


# Declared before ``/sessions/{session_id}`` so the literal path wins.
@router.post("/sessions/revoke-others", status_code=204)
def revoke_other_sessions(
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Sign out everywhere except this browser."""
    token = request.cookies.get(accounts.SESSION_COOKIE)
    sessions.revoke_others(session, user.id, token)
    return Response(status_code=204)


@router.delete("/sessions/{session_id}", status_code=204)
def revoke_my_session(
    session_id: int,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Sign one of your devices out. Ending this browser's own session signs you out."""
    revoked = sessions.revoke(session, user.id, session_id)
    response = Response(status_code=204)
    token = request.cookies.get(accounts.SESSION_COOKIE)
    if token and accounts.hash_token(token) == revoked:
        response.delete_cookie(accounts.SESSION_COOKIE, path="/")
    return response


@router.post("/avatar", response_model=AuthUserRead)
def upload_avatar(
    file: UploadFile,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Set your own profile picture (any image; stored as a square JPEG)."""
    data = uploads.read_upload_bytes(file, uploads.IMAGE_MAX_BYTES)
    if not data:
        raise CodedHTTPException(400, "Empty file", "empty_file")
    try:
        row = avatars.set_avatar(session, user.id, data)
    except ValueError as exc:
        raise CodedHTTPException(400, "Could not read image", "bad_image") from exc
    return user_read(AuthUser.of(row))


@router.delete("/avatar", response_model=AuthUserRead)
def remove_avatar(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Remove your own profile picture."""
    return user_read(AuthUser.of(avatars.clear_avatar(session, user.id)))


@router.get("/avatar/{user_id}", response_class=RAW, responses=IMAGE_JPEG)
def get_avatar(
    user_id: int,
    session: Session = Depends(get_session),
    _user: AuthUser = Depends(current_user),
):
    """Any account's profile picture, for any signed-in user (it is shown to others)."""
    row = session.get(User, user_id)
    path = avatars.existing_avatar(row) if row is not None else None
    if path is None:
        raise CodedHTTPException(404, "No profile picture", "no_avatar")
    # The URL carries ?v=avatar_version, so a new upload is a new URL.
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )

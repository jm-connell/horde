"""Sign-in, sign-out, first-run bootstrap and the caller's own account."""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import timedelta
from typing import cast

from fastapi import APIRouter, Depends, Request, Response, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session

from ..auth import (
    CodedHTTPException,
    current_user,
    flag_enrollment,
    two_factor_requirement,
)
from ..context import get_ctx, get_session
from ..models import User, as_utc, require_id
from ..openapi_responses import IMAGE_JPEG, RAW
from ..schemas import (
    AuthLoginResult,
    AuthState,
    AuthUserRead,
    BootstrapRequest,
    ForgotPasswordRequest,
    LoginRequest,
    MeUpdate,
    PasswordChange,
    PasswordResetRequest,
    PasswordVerify,
    SessionList,
    SessionRead,
    TotpLoginRequest,
    TwoFactorConfirm,
    TwoFactorProof,
    TwoFactorRecoveryCodes,
    TwoFactorSetup,
    TwoFactorSetupRequest,
    TwoFactorStatus,
)
from ..services import app_settings, uploads
from ..services.auth import (
    accounts,
    alerts,
    avatars,
    login_tickets,
    passwords,
    reset_codes,
    sessions,
    totp,
    two_factor,
    user_agent,
)
from ..services.auth.accounts import AuthUser
from ..services.auth.runtime import AuthRuntime
from ..services.notifications import events

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
        share_downloads=user.share_downloads,
        two_factor_enabled=user.two_factor_enabled,
        two_factor_enrollment_required=user.must_enroll_two_factor,
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


def _announce_new_device(
    request: Request, session: Session, runtime: AuthRuntime, user: User
) -> None:
    """Notify (if anyone subscribed) when no live session of ``user`` looks like this one."""
    device = user_agent.describe(request.headers.get("user-agent"))
    known = {s.device for s in sessions.list_sessions(session, require_id(user))}
    if device in known:
        return
    get_ctx(request).notifier.emit(
        events.NEW_DEVICE_SIGN_IN,
        {
            "username": user.username,
            "device": device,
            "address": runtime.client_address(request),
        },
        dedupe_key=f"new-device:{user.id}:{device}",
        dedupe_ttl=300,
    )


def _open_session(
    session: Session,
    request: Request,
    response: Response,
    runtime: AuthRuntime,
    user,
    *,
    announce: bool = True,
) -> None:
    if announce:
        _announce_new_device(request, session, runtime, user)
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
            session,
            payload.username,
            payload.password,
            is_admin=True,
            share_downloads=payload.share_downloads,
        )
    _open_session(session, request, response, runtime, user, announce=False)
    return AuthLoginResult(user=user_read(AuthUser.of(user)))


def _check_throttle(runtime: AuthRuntime, address: str, key: str) -> None:
    """429 while ``key`` (a username, or ``reset:``/``password:`` + name) must wait."""
    wait = runtime.limiter.retry_after(address, key)
    if wait:
        raise CodedHTTPException(
            429,
            f"Too many failed attempts. Try again in {wait} seconds.",
            "rate_limited",
            headers={"Retry-After": str(wait)},
        )


def _note_failed_sign_in(
    request: Request, session: Session, runtime: AuthRuntime, username: str
) -> None:
    """Count a failed sign-in for the "someone is guessing" notification.

    Only names that belong to an account are counted, so spraying made-up names
    neither fills the table nor hides an attack on a real one.
    """
    user = accounts.get_by_username(session, username)
    if user is None:
        return
    payload = runtime.failure_watch.note(
        user.username_norm, runtime.client_address(request)
    )
    if payload is not None:
        payload["username"] = user.username
        get_ctx(request).notifier.emit(
            events.LOGIN_FAILURES,
            payload,
            dedupe_key=f"login-failures:{user.username_norm}",
            dedupe_ttl=alerts.COOLDOWN_SEC,
        )


def _complete_sign_in(
    session: Session,
    request: Request,
    response: Response,
    runtime: AuthRuntime,
    user: User,
    address: str,
) -> AuthLoginResult:
    """The last step of every way in: forget the failures, start the session."""
    runtime.limiter.record_success(address, user.username_norm)
    # The password was remembered after all: pending reset codes go.
    runtime.reset_codes.discard(user.username_norm)
    _open_session(session, request, response, runtime, user)
    return AuthLoginResult(user=user_read(flag_enrollment(runtime, AuthUser.of(user))))


def _totp_required(runtime: AuthRuntime, user: User) -> CodedHTTPException:
    """The answer to a correct password when the account has a second step."""
    ticket = runtime.pending_logins.issue(runtime.secret(), user)
    return CodedHTTPException(
        401,
        "Enter the code from your authenticator app",
        "totp_required",
        extra={"pending_token": ticket},
    )


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
    _check_throttle(runtime, address, norm)
    user = accounts.authenticate(
        session, payload.username, payload.password, dummy_hash=runtime.dummy_hash()
    )
    if user is None:
        runtime.limiter.record_failure(address, norm)
        logger.warning("Failed sign-in for %r from %s", norm[:64], address)
        _note_failed_sign_in(request, session, runtime, norm)
        raise CodedHTTPException(
            401, "Invalid username or password", "invalid_credentials"
        )
    if two_factor.is_enabled(user):
        # A right password proves nothing about the second factor: the failure
        # counters stay as they are until the code step succeeds, so alternating
        # right passwords with wrong codes cannot reset the throttle.
        raise _totp_required(runtime, user)
    return _complete_sign_in(session, request, response, runtime, user, address)


@router.post("/login/totp", response_model=AuthLoginResult)
def login_totp(
    payload: TotpLoginRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    """Second step: trade the ticket from ``totp_required`` and a code for the session.

    The code is an authenticator code or an unused recovery code. Wrong codes
    count in the same throttle as wrong passwords; five wrong tries burn the ticket.
    """
    runtime = _runtime(request)
    _refuse_when_auth_disabled(runtime)
    expired = CodedHTTPException(
        401, "That sign-in expired. Enter your password again.", "totp_ticket_invalid"
    )
    ticket = login_tickets.parse(payload.pending_token)
    if ticket is None:
        raise expired
    user = accounts.get_user(session, ticket.user_id)
    if (
        user is None
        or user.disabled
        or not two_factor.is_enabled(user)
        or not login_tickets.verify(
            runtime.secret(), ticket, login_tickets.ticket_epoch(user)
        )
    ):
        raise expired
    address = runtime.client_address(request)
    _check_throttle(runtime, address, user.username_norm)
    if not runtime.pending_logins.attempt(ticket):
        raise expired
    if two_factor.check_code(session, user, payload.code, key=runtime.secret()) is None:
        runtime.limiter.record_failure(address, user.username_norm)
        logger.warning(
            "Failed second step for %r from %s", user.username_norm[:64], address
        )
        _note_failed_sign_in(request, session, runtime, user.username_norm)
        raise CodedHTTPException(
            401, "That code is wrong or has already been used", "invalid_totp"
        )
    if not runtime.pending_logins.finish(ticket):
        raise expired  # a parallel request used this ticket first
    accounts.mark_login(session, user)
    return _complete_sign_in(session, request, response, runtime, user, address)


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
    _check_throttle(runtime, address, throttle_key)
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
    if two_factor.is_enabled(user):
        # The log proves the password may change, not who is typing: the second
        # step is still due. The password is already new; the ticket is for it.
        raise _totp_required(runtime, user)
    _open_session(session, request, response, runtime, user)
    return AuthLoginResult(user=user_read(flag_enrollment(runtime, AuthUser.of(user))))


def _verify_current_password(
    request: Request,
    session: Session,
    user: AuthUser,
    password: str,
    *,
    forgive: bool = True,
) -> User:
    """The signed-in user's row, once ``password`` is proven to be theirs.

    Guessing the current password is guessing the password: same throttle as
    sign-in, counted separately so it cannot lock the account out of signing in.
    ``forgive=False`` leaves the failure counters alone on success, for a caller
    that still has a second check to make (a right password must not wipe the
    wrong codes counted before it).
    """
    runtime = _runtime(request)
    address = runtime.client_address(request)
    throttle_key = f"password:{user.username.lower()}"
    _check_throttle(runtime, address, throttle_key)
    row = accounts.get_user(session, user.id)
    if row is None or not passwords.verify_password(password, row.password_hash):
        runtime.limiter.record_failure(address, throttle_key)
        raise CodedHTTPException(400, "Current password is incorrect", "wrong_password")
    if forgive:
        runtime.limiter.record_success(address, throttle_key)
    return row


@router.post("/password", status_code=204)
def change_password(
    payload: PasswordChange,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Change your own password. Your other browsers are signed out."""
    row = _verify_current_password(request, session, user, payload.current_password)
    token = request.cookies.get(accounts.SESSION_COOKIE)
    accounts.set_password(
        session,
        row,
        payload.new_password,
        keep_token_hash=accounts.hash_token(token) if token else None,
    )
    return Response(status_code=204)


@router.post("/verify-password", status_code=204)
def verify_password(
    payload: PasswordVerify,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Check your own password (204, or 400 ``wrong_password``) and change nothing.

    A device asks before it keeps a check value of the password for offline
    unlock, so a typo cannot lock the owner out of their own downloads.
    """
    _verify_current_password(request, session, user, payload.password)
    return Response(status_code=204)


@router.patch("/me", response_model=AuthUserRead)
def update_me(
    payload: MeUpdate,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Change your own preferences (whether other accounts see your downloads).

    Stopping sharing needs your password: devices keep a check value derived from
    it, so the downloads can still be unlocked offline.
    """
    if not payload.share_downloads:
        if not payload.current_password:
            raise CodedHTTPException(
                400,
                "Enter your password to stop sharing your downloads",
                "password_required",
            )
        _verify_current_password(request, session, user, payload.current_password)
    row = accounts.set_share_downloads(session, user.id, payload.share_downloads)
    return user_read(AuthUser.of(row))


# --- Two-step sign-in -----------------------------------------------------------

#: Secrets and recovery codes must not be kept by any cache.
_NO_STORE = {"Cache-Control": "no-store"}


def _own_row(session: Session, request: Request, user: AuthUser) -> User:
    """The caller's row, for the two-step routes (which make no sense without sign-in)."""
    _refuse_when_auth_disabled(_runtime(request))
    row = accounts.get_user(session, user.id)
    if row is None:
        raise CodedHTTPException(401, "Sign in to continue", "auth_required")
    return row


def _prove_second_factor(
    request: Request, session: Session, user: AuthUser, password: str, code: str
) -> User:
    """The caller's row once they gave the current password *and* a valid code.

    Turning two-step sign-in off, or replacing its recovery codes, is as sensitive
    as signing in, so both factors are checked, and a wrong guess of either counts
    in the same per-user throttle as a wrong current password.
    """
    row = _verify_current_password(request, session, user, password, forgive=False)
    runtime = _runtime(request)
    address = runtime.client_address(request)
    throttle_key = f"password:{user.username.lower()}"
    if two_factor.check_code(session, row, code, key=runtime.secret()) is None:
        runtime.limiter.record_failure(address, throttle_key)
        raise CodedHTTPException(
            400, "That code is wrong or has already been used", "invalid_totp"
        )
    runtime.limiter.record_success(address, throttle_key)
    return row


@router.get("/2fa", response_model=TwoFactorStatus)
def two_factor_status(
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Whether your account signs in with a second step, and how many recovery codes are left."""
    row = _own_row(session, request, user)
    enabled = two_factor.is_enabled(row)
    return TwoFactorStatus(
        enabled=enabled,
        enabled_at=as_utc(row.totp_enabled_at) if enabled else None,
        recovery_codes_left=two_factor.recovery_codes_left(session, user.id)
        if enabled
        else 0,
        required=two_factor.required_for(
            two_factor_requirement(_runtime(request)), is_admin=user.is_admin
        ),
    )


@router.post("/2fa/setup", response_model=TwoFactorSetup)
def two_factor_setup(
    payload: TwoFactorSetupRequest,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Start setting up two-step sign-in: a new secret, as text and as a QR code.

    Needs your current password (someone holding only a stolen session must not be
    able to attach their own authenticator). Nothing changes at sign-in until
    ``/2fa/confirm`` accepts a code; calling this again starts over with a new secret.
    """
    _own_row(session, request, user)
    row = _verify_current_password(request, session, user, payload.current_password)
    secret = two_factor.begin_enrollment(session, row)
    uri = totp.provisioning_uri(secret, row.username)
    response.headers.update(_NO_STORE)
    return TwoFactorSetup(
        secret=totp.group_secret(secret),
        otpauth_uri=uri,
        qr_svg=two_factor.qr_svg(uri),
    )


@router.post("/2fa/confirm", response_model=TwoFactorRecoveryCodes)
def two_factor_confirm(
    payload: TwoFactorConfirm,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Finish setup with a current code. Turns it on and returns the recovery codes once.

    Your other browsers were signed in without a second step, so they are signed out.
    """
    runtime = _runtime(request)
    row = _own_row(session, request, user)
    address = runtime.client_address(request)
    throttle_key = f"password:{user.username.lower()}"
    _check_throttle(runtime, address, throttle_key)
    try:
        codes = two_factor.confirm_enrollment(
            session, row, payload.code, key=runtime.secret()
        )
    except two_factor.InvalidCode:
        runtime.limiter.record_failure(address, throttle_key)
        raise
    token = request.cookies.get(accounts.SESSION_COOKIE)
    sessions.revoke_others(session, user.id, token)
    response.headers.update(_NO_STORE)
    return TwoFactorRecoveryCodes(recovery_codes=codes)


@router.post("/2fa/disable", status_code=204)
def two_factor_disable(
    payload: TwoFactorProof,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Turn two-step sign-in off. Needs your password and a current (or recovery) code."""
    _own_row(session, request, user)
    row = _prove_second_factor(
        request, session, user, payload.current_password, payload.code
    )
    two_factor.disable(session, row)
    return Response(status_code=204)


@router.post("/2fa/recovery-codes", response_model=TwoFactorRecoveryCodes)
def two_factor_new_recovery_codes(
    payload: TwoFactorProof,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Replace the recovery codes; the old ones stop working. Shown once."""
    _own_row(session, request, user)
    row = _prove_second_factor(
        request, session, user, payload.current_password, payload.code
    )
    codes = two_factor.regenerate_recovery_codes(
        session, row, key=_runtime(request).secret()
    )
    response.headers.update(_NO_STORE)
    return TwoFactorRecoveryCodes(recovery_codes=codes)


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

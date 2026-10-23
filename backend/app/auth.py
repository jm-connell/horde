"""Request-level authentication: the middleware and the FastAPI dependencies.

``AuthMiddleware`` sits in the ``security.py`` stack right after CSRF. It is
**deny by default** for everything under ``/api`` (plus ``/docs``, ``/redoc`` and
``/openapi.json``): a new route is protected the moment it exists, with no
decorator to forget. The exceptions are the exact ``(method, path)`` pairs in
``PUBLIC_ROUTES`` and the signed media URLs (``?mt=``) below. Anything outside
those prefixes is the SPA, its assets and the wiki, which carry no data.

The middleware resolves the caller once and leaves a detached ``AuthUser`` on
``request.state.user`` for handlers. Whether that user may do a particular thing
is the handler's business: ``Depends(current_user)`` to get the user,
``Depends(require_admin)`` for admin-only routes.

Three ways to be a user:

* the ``horde_session`` cookie (normal browsers);
* ``?mt=<token>`` on the stream, subtitle and thumbnail URLs (Cast and AirPlay
  receivers, which send no cookies; see ``services/auth/media_token.py``);
* ``HORDE_AUTH_DISABLED=1``: a reverse proxy in front authenticates, Horde runs as
  the first administrator (or the account named in the trusted header).

When the administrator requires two-step sign-in (``require_two_factor``), an
account that has not set it up is identified like anyone else but marked
``must_enroll_two_factor``; the middleware then refuses every route except the
exact ``ENROLLMENT_ROUTES`` (and the public ones) with 403
``two_factor_enrollment_required``. That is enforced here, once, not per route.
"""

from __future__ import annotations

import dataclasses
import logging
import re
import time
from urllib.parse import parse_qs

import anyio.to_thread
from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from sqlmodel import Session
from starlette.types import ASGIApp, Receive, Scope, Send

from .context import get_ctx
from .errors import CodedHTTPException, error_response
from .services import app_settings
from .services.auth import accounts, media_token, two_factor
from .services.auth.accounts import AuthUser
from .services.auth.permissions import ALL_PERMISSIONS, PERMISSION_TABLE
from .services.auth.runtime import AuthRuntime

logger = logging.getLogger(__name__)

#: Reachable without signing in. Exact method and path; nothing else is public.
PUBLIC_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", "/api/ping"),
        ("GET", "/api/ready"),
        ("GET", "/api/health"),
        ("GET", "/api/auth/state"),
        ("POST", "/api/auth/login"),
        ("POST", "/api/auth/login/totp"),
        ("POST", "/api/auth/bootstrap"),
        ("POST", "/api/auth/forgot"),
        ("POST", "/api/auth/reset"),
    }
)
#: All that an account which must set up two-step sign-in may do until it has:
#: read its state, sign out, and enroll.
ENROLLMENT_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", "/api/auth/state"),
        ("POST", "/api/auth/logout"),
        ("GET", "/api/auth/2fa"),
        ("POST", "/api/auth/2fa/setup"),
        ("POST", "/api/auth/2fa/confirm"),
    }
)
#: Only mounted (and only public) when the Playwright suite runs the app: ``main``
#: passes it to ``install_security(extra_public_routes=...)`` when ``HORDE_E2E`` is set.
E2E_PUBLIC_ROUTES: frozenset[tuple[str, str]] = frozenset({("POST", "/api/e2e/reset")})

_PROTECTED_DOCS = frozenset({"/docs", "/redoc", "/openapi.json"})

#: Routes a Cast/AirPlay receiver fetches; the capture group is the video id.
SIGNED_MEDIA_PATTERNS = (
    re.compile(r"/api/videos/(\d+)/stream"),
    re.compile(r"/api/videos/(\d+)/subtitles/[^/]+"),
    re.compile(r"/api/thumbnails/(\d+)"),
)
MEDIA_TOKEN_PARAM = "mt"  # noqa: S105 - a query parameter name, not a secret
_READ_METHODS = frozenset({"GET", "HEAD"})


def is_protected_path(path: str) -> bool:
    return (
        path == "/api"
        or path in _PROTECTED_DOCS
        or path.startswith(("/api/", "/docs/"))
    )


def signed_media_video_id(path: str) -> int | None:
    for pattern in SIGNED_MEDIA_PATTERNS:
        match = pattern.fullmatch(path)
        if match:
            return int(match.group(1))
    return None


def auth_required_response() -> JSONResponse:
    return error_response(401, "Sign in to continue", "auth_required")


def enrollment_required_response() -> JSONResponse:
    return error_response(
        403,
        "Set up two-step sign-in to continue. An administrator requires it.",
        "two_factor_enrollment_required",
    )


def two_factor_requirement(runtime: AuthRuntime) -> str:
    """The ``require_two_factor`` setting.

    If the settings file cannot be read (damaged and not restorable, or an I/O
    error) the last value this process read stays in force, so a bad file does not
    switch the requirement off mid-run; the stand-in defaults of a damaged file
    are never taken for the administrator's choice. A process that never read it
    starts from "off", which only matters if the file was already damaged at
    start-up, when the Settings screen says so.
    """
    try:
        data = app_settings.load()
        if app_settings.is_degraded():
            return runtime.two_factor_requirement
    except app_settings.SettingsError:
        logger.debug("settings unreadable; keeping the last requirement", exc_info=True)
        return runtime.two_factor_requirement
    runtime.two_factor_requirement = two_factor.normalize_requirement(
        data.get("require_two_factor")
    )
    return runtime.two_factor_requirement


def flag_enrollment(runtime: AuthRuntime, user: AuthUser) -> AuthUser:
    """``user``, marked as having to set up two-step sign-in if the setting says so."""
    if user.two_factor_enabled:
        return user
    if two_factor.required_for(two_factor_requirement(runtime), is_admin=user.is_admin):
        return dataclasses.replace(user, must_enroll_two_factor=True)
    return user


class AuthMiddleware:
    """401 for anonymous callers on protected paths; sets ``request.state.user``."""

    def __init__(
        self, app: ASGIApp, extra_public: frozenset[tuple[str, str]] = frozenset()
    ) -> None:
        self.app = app
        self.public = PUBLIC_ROUTES | extra_public

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket" and is_protected_path(scope["path"]):
            # Nothing here speaks WebSocket; deny by default like everything else.
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] != "http" or not is_protected_path(scope["path"]):
            await self.app(scope, receive, send)
            return

        runtime: AuthRuntime = scope["app"].state.auth
        request = Request(scope)
        user = await anyio.to_thread.run_sync(self.identify, runtime, request)
        method, path = scope["method"], scope["path"]
        if user is not None:
            scope.setdefault("state", {})["user"] = user
            if user.must_enroll_two_factor and not self._open_to_enrollment(
                method, path
            ):
                await enrollment_required_response()(scope, receive, send)
                return
        elif not self._is_public(method, path):
            await auth_required_response()(scope, receive, send)
            return
        await self.app(scope, receive, send)

    def _is_public(self, method: str, path: str) -> bool:
        return (method, path) in self.public or (
            method == "HEAD" and ("GET", path) in self.public
        )

    def _open_to_enrollment(self, method: str, path: str) -> bool:
        if self._is_public(method, path):
            return True
        read = "GET" if method == "HEAD" else method
        return (read, path) in ENROLLMENT_ROUTES

    # --- Identification (runs in a worker thread: it touches SQLite) -------

    @staticmethod
    def identify(
        runtime: AuthRuntime, request: Request, *, touch: bool = True
    ) -> AuthUser | None:
        """The caller, or ``None``. ``touch=False`` leaves the session expiry alone."""
        with get_ctx(request).session() as session:
            if runtime.config.disabled:
                return AuthMiddleware._proxy_user(runtime, request, session)
            user: AuthUser | None = None
            token = request.cookies.get(accounts.SESSION_COOKIE)
            if token:
                user = accounts.resolve_session(session, token, touch=touch)
            if user is None:
                user = AuthMiddleware._media_token_user(runtime, request, session)
        return flag_enrollment(runtime, user) if user is not None else None

    @staticmethod
    def _media_token_user(
        runtime: AuthRuntime, request: Request, session: Session
    ) -> AuthUser | None:
        path = request.url.path
        video_id = signed_media_video_id(path)
        if video_id is None or request.method not in _READ_METHODS:
            return None
        values = parse_qs(request.url.query).get(MEDIA_TOKEN_PARAM)
        if not values:
            return None
        parsed = media_token.parse(values[0])
        if parsed is None:
            return None
        user = accounts.get_user(session, parsed.user_id)
        if user is None or user.disabled:
            return None
        epoch = media_token.token_epoch(user.password_hash)
        if not media_token.verify(runtime.secret(), parsed, video_id, epoch):
            return None
        return AuthUser.of(user)

    @staticmethod
    def _proxy_user(
        runtime: AuthRuntime, request: Request, session: Session
    ) -> AuthUser | None:
        """Sign-in disabled: the proxy vouches for the caller."""
        header = runtime.config.trusted_user_header
        if header and runtime.config.trust_proxy:
            name = request.headers.get(header, "").strip()
            user = accounts.get_by_username(session, name) if name else None
            if user is None or user.disabled:
                # The proxy is expected to always send a known name; anything else
                # means it was bypassed or misconfigured. Do not fall back to admin.
                return None
            return AuthUser.of(user)
        return ensure_default_admin(runtime, session)


#: SSE comment line: ignored by EventSource, keeps proxies from idling the stream out.
STREAM_KEEPALIVE = ": keepalive\n\n"


class StreamAuthGuard:
    """Keeps a long-lived stream (SSE) honest about who is on the other end.

    The middleware authenticates a request once, but an event stream can run for
    hours. The guard re-runs the same identification (cookie session, signed media
    URL or proxy user) every ``AuthRuntime.stream_recheck_seconds``; the stream
    ends once the session is gone, the account is disabled or deleted, or its
    password was reset. It never slides the session expiry: an open tab is not
    activity. Build one per stream with ``StreamAuthGuard.of(request)``.
    """

    def __init__(self, request: Request, user_id: int, interval: float) -> None:
        self._request = request
        self._user_id = user_id
        self.interval = interval
        self._next_check = time.monotonic() + interval

    @classmethod
    def of(cls, request: Request) -> StreamAuthGuard:
        user: AuthUser = current_user(request)
        runtime: AuthRuntime = request.app.state.auth
        return cls(request, user.id, runtime.stream_recheck_seconds)

    def due(self) -> bool:
        return time.monotonic() >= self._next_check

    def valid_now(self) -> bool:
        """Re-identify the caller now (blocking: call off the event loop)."""
        self._next_check = time.monotonic() + self.interval
        runtime: AuthRuntime = self._request.app.state.auth
        user = AuthMiddleware.identify(runtime, self._request, touch=False)
        return user is not None and user.id == self._user_id

    def still_valid(self, *, force: bool = False) -> bool:
        """Blocking and throttled: cheap ``True`` until the next check is due."""
        return self.valid_now() if force or self.due() else True

    async def tick(self) -> bool | None:
        """``None`` when no check is due; else whether the caller is still valid."""
        if not self.due():
            return None
        return await anyio.to_thread.run_sync(self.valid_now)


def ensure_default_admin(runtime: AuthRuntime, session: Session) -> AuthUser | None:
    """The identity used when sign-in is disabled; created on first use.

    Nobody knows the generated password, so the account can only be reached
    through the proxy (or reset with ``python -m app.cli reset-password``).
    """
    with runtime.bootstrap_lock:
        admin = accounts.first_admin(session)
        if admin is None and accounts.count_users(session) == 0:
            import secrets

            admin = accounts.create_user(
                session, "admin", secrets.token_urlsafe(24), is_admin=True
            )
    return AuthUser.of(admin) if admin is not None else None


# --- Dependencies ------------------------------------------------------------


def current_user(request: Request) -> AuthUser:
    """The signed-in user. The middleware already refused anonymous callers."""
    user: AuthUser | None = getattr(request.state, "user", None)
    if user is None:
        raise CodedHTTPException(401, "Sign in to continue", "auth_required")
    return user


def ensure_admin(user: AuthUser) -> None:
    """For a check that depends on the request (use ``require_admin`` otherwise)."""
    if not user.is_admin:
        raise CodedHTTPException(403, "Administrator access required", "admin_required")


def require_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    """Dependency for routes that change server-wide state or settings."""
    ensure_admin(user)
    return user


require_admin.admin_only = True  # type: ignore[attr-defined]  # marker read by tests


def ensure_permission(user: AuthUser, permission: str) -> None:
    """403 ``permission_denied`` unless the user holds ``permission`` (admins do)."""
    if not user.can(permission):
        label = next(
            (p.label for p in PERMISSION_TABLE if p.name == permission), permission
        )
        raise CodedHTTPException(
            403,
            f"Your account is not allowed to do this ({label}). Ask an administrator.",
            "permission_denied",
        )


def require_permission(permission: str):
    """Dependency factory: ``dependencies=[Depends(require_permission("download"))]``."""
    if permission not in ALL_PERMISSIONS:
        raise ValueError(f"unknown permission {permission!r}")

    def dependency(user: AuthUser = Depends(current_user)) -> AuthUser:
        ensure_permission(user, permission)
        return user

    dependency.permission = permission  # type: ignore[attr-defined]  # marker read by tests
    return dependency

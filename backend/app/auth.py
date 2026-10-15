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
"""

from __future__ import annotations

import logging
import re
from typing import cast
from urllib.parse import parse_qs

import anyio.to_thread
from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlmodel import Session
from starlette.types import ASGIApp, Receive, Scope, Send

from . import database
from .e2e_mode import enabled as e2e_enabled
from .services.auth import accounts, media_token
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
        ("POST", "/api/auth/bootstrap"),
    }
)
#: Only mounted (and only public) when the Playwright suite runs the app.
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
    return JSONResponse(
        {"detail": "Sign in to continue", "code": "auth_required"}, status_code=401
    )


class AuthMiddleware:
    """401 for anonymous callers on protected paths; sets ``request.state.user``."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        public = set(PUBLIC_ROUTES)
        if e2e_enabled():
            public |= E2E_PUBLIC_ROUTES
        self.public = frozenset(public)

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
        user = await anyio.to_thread.run_sync(self._identify, runtime, request)
        if user is not None:
            scope.setdefault("state", {})["user"] = user
        elif (scope["method"], scope["path"]) not in self.public and not (
            scope["method"] == "HEAD" and ("GET", scope["path"]) in self.public
        ):
            await auth_required_response()(scope, receive, send)
            return
        await self.app(scope, receive, send)

    # --- Identification (runs in a worker thread: it touches SQLite) -------

    def _identify(self, runtime: AuthRuntime, request: Request) -> AuthUser | None:
        with Session(database.engine) as session:
            if runtime.config.disabled:
                return self._proxy_user(runtime, request, session)
            token = request.cookies.get(accounts.SESSION_COOKIE)
            if token:
                user = accounts.resolve_session(session, token)
                if user is not None:
                    return user
            return self._media_token_user(runtime, request, session)

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


class CodedHTTPException(HTTPException):
    """An HTTP error whose body also carries a machine-readable ``code``."""

    def __init__(self, status_code: int, detail: str, code: str, **kwargs) -> None:
        super().__init__(status_code=status_code, detail=detail, **kwargs)
        self.code = code


async def coded_http_exception_handler(
    _request: Request, exc: Exception
) -> JSONResponse:
    coded = cast(CodedHTTPException, exc)
    return JSONResponse(
        {"detail": coded.detail, "code": coded.code},
        status_code=coded.status_code,
        headers=coded.headers,
    )


async def account_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    error = cast(accounts.AccountError, exc)
    return JSONResponse(
        {"detail": error.message, "code": error.code}, status_code=error.status_code
    )


def current_user(request: Request) -> AuthUser:
    """The signed-in user. The middleware already refused anonymous callers."""
    user = getattr(request.state, "user", None)
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

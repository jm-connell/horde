"""Request-level security for the whole app, as one ordered middleware stack.

Horde has accounts (see ``app/auth.py``), but a browser on the network will
happily send requests on behalf of any web page the user visits, and will resolve
any DNS name an attacker controls to the server's LAN address. This module closes
those two doors before a request is ever looked at by the login layer:

1. ``HostAllowlistMiddleware``: refuses requests for a Host the operator did not
   expect. Defeats DNS rebinding (an attacker's name pointing at the LAN IP).
2. ``BodyLimitMiddleware``: refuses oversized request bodies before they are parsed.
3. ``MediaCorsMiddleware``: the only CORS in the app. Cast receivers fetch media from
   a different origin, so the media routes (and only those) send CORS headers.
4. ``CsrfMiddleware``: every state-changing request must carry ``X-Horde-Request``.
   A custom header forces a CORS preflight, which no route grants, so a web page on
   another site cannot send one. ``Sec-Fetch-Site`` and ``Origin`` are checked too.
5. ``AuthMiddleware``: deny by default for ``/api``; innermost of the checks, so it
   only ever sees requests that came from this app's own pages.
6. ``SecurityHeadersMiddleware`` (outermost, so it also covers rejections): CSP,
   ``nosniff``, referrer policy, framing policy.

``build_stack`` below is the single place the order is defined.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI
from fastapi.responses import Response
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import AuthMiddleware
from .errors import error_response, install_error_handlers
from .request_context import RequestIdMiddleware
from .services import limits, uploads
from .services.auth.runtime import TRUST_PROXY_ENV, AuthConfig, AuthRuntime
from .services.log_redaction import install_log_redaction
from .services.metrics import RequestStats

logger = logging.getLogger(__name__)

ALLOWED_HOSTS_ENV = "HORDE_ALLOWED_HOSTS"
CSRF_HEADER = "x-horde-request"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# --- Host allowlist ----------------------------------------------------------

#: Name suffixes that only ever resolve inside a private network.
_PRIVATE_SUFFIXES = (".local", ".lan", ".home.arpa", ".internal", ".ts.net")


_HOSTNAME_RE = re.compile(r"[a-z0-9_]([a-z0-9_.\-]*[a-z0-9_])?")


@dataclass(frozen=True)
class HostPolicy:
    """Which ``Host`` header values are accepted.

    The defaults cover how people actually reach a homelab service: ``localhost``,
    any address that is not publicly routable (private, loopback, link-local and
    CGNAT such as Tailscale's 100.64.0.0/10), single-label names such as ``truenas``
    and the private-network suffixes. Public names must be listed explicitly in
    ``HORDE_ALLOWED_HOSTS``; that is what stops DNS rebinding.
    """

    extra: tuple[str, ...] = ()
    allow_any: bool = False

    @classmethod
    def from_env(cls, raw: str | None) -> HostPolicy:
        entries: list[str] = []
        for part in (raw or "").split(","):
            entry = part.strip().lower()
            if not entry:
                continue
            # Accept "host:port" too: the port is not part of the identity.
            entries.append((cls._hostname(entry) or entry).rstrip("."))
        return cls(extra=tuple(entries), allow_any="*" in entries)

    @staticmethod
    def _hostname(header: str) -> str | None:
        try:
            return urlsplit(f"//{header}").hostname
        except ValueError:
            return None

    def allows(self, host_header: str) -> bool:
        if self.allow_any:
            return True
        host = self._hostname(host_header)
        if not host:
            return False
        host = host.rstrip(".")
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return self._name_allowed(host)
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        return not ip.is_global or host in self.extra

    def _name_allowed(self, host: str) -> bool:
        if not _HOSTNAME_RE.fullmatch(host):
            return False
        if host == "localhost" or host.endswith(".localhost"):
            return True
        if "." not in host or host.endswith(_PRIVATE_SUFFIXES):
            return True
        for entry in self.extra:
            if entry.startswith("*."):
                if host.endswith(entry[1:]):
                    return True
            elif host == entry:
                return True
        return False


# --- Content-Security-Policy -------------------------------------------------

#: The SPA. Everything it loads is listed here:
#:  * scripts: its own bundle, the Google Cast sender SDK (gstatic; Chrome's cast
#:    shim also loads from a chrome-extension: URL). The SDK loads its framework
#:    and the ``eureka`` sender with the page's own scheme, so a plain-HTTP LAN
#:    page fetches them over http://; an HTTPS page never does (mixed content).
#:  * styles: Tailwind output, Google Fonts (a user-selectable UI font), plus inline
#:    styles (React ``style=`` attributes and the user's custom CSS <style> tag)
#:  * images: own thumbnails, and remote thumbnails from whichever site yt-dlp read
#:    (YouTube's i.ytimg.com, Vimeo, ...), so any https host
#:  * connect: own API, SponsorBlock, Cast SDK
#:  * media/worker: own streams, blob: for DASH (MediaSource) and the service worker
APP_CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' https://www.gstatic.com http://www.gstatic.com chrome-extension:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: data:",
        "connect-src 'self' https://sponsor.ajay.app https://www.gstatic.com http://www.gstatic.com",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ]
)

#: The MkDocs wiki served under /wiki. The Material theme emits small inline
#: scripts (palette and search bootstrap) and starts its search worker from a blob,
#: and the repo widgets read GitHub (raw.githubusercontent.com, api.github.com).
WIKI_CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: https:",
        "connect-src 'self' https://raw.githubusercontent.com https://api.github.com",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ]
)

WIKI_PREFIX = "/wiki"


def content_security_policy(path: str) -> str:
    if path == WIKI_PREFIX or path.startswith(f"{WIKI_PREFIX}/"):
        return WIKI_CSP
    return APP_CSP


def security_headers(path: str) -> dict[str, str]:
    """The response headers every reply carries (the one source of truth)."""
    return {
        "Content-Security-Policy": content_security_policy(path),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "SAMEORIGIN",
    }


# --- ASGI helpers ------------------------------------------------------------


def _header(scope: Scope, name: str) -> str | None:
    key = name.encode("latin-1")
    for k, v in scope["headers"]:
        if k == key:
            value: str = v.decode("latin-1")
            return value
    return None


async def _reject(
    scope: Scope, receive: Receive, send: Send, status: int, detail: str, code: str
) -> None:
    response = error_response(status, detail, code)
    await response(scope, receive, send)


# --- Middleware --------------------------------------------------------------


class SecurityHeadersMiddleware:
    """Adds CSP, nosniff, referrer and framing headers to every response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        extra = security_headers(scope["path"])

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in extra.items():
                    headers.setdefault(name, value)
            await send(message)

        await self.app(scope, receive, send_with_headers)


class HostAllowlistMiddleware:
    """400 for a Host header that is not allowed (DNS rebinding defence)."""

    #: Distinct rejected names remembered for the once-per-host warning.
    MAX_REMEMBERED_HOSTS = 64

    def __init__(self, app: ASGIApp, *, policy: HostPolicy) -> None:
        self.app = app
        self.policy = policy
        self._warned: set[str] = set()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        host = _header(scope, "host") or ""
        if self.policy.allows(host):
            await self.app(scope, receive, send)
            return
        self._log_rejection(host)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await _reject(
            scope,
            receive,
            send,
            400,
            f"Host {host!r} is not allowed. If you reach Horde under this name "
            f"(for example through a reverse proxy), add it to the "
            f"{ALLOWED_HOSTS_ENV} environment variable.",
            "host_not_allowed",
        )

    def _log_rejection(self, host: str) -> None:
        """A WARNING the first time a name is refused, then debug (it repeats per request)."""
        if host in self._warned or len(self._warned) >= self.MAX_REMEMBERED_HOSTS:
            # Seen already, or too many distinct names (a scanner sending random
            # Host headers) to keep warning about each of them.
            logger.debug("Rejected request for unexpected Host %r", host)
            return
        self._warned.add(host)
        logger.warning(
            "Rejected a request for Host %r. If you reach Horde under this name "
            "(a reverse proxy or tunnel), add it to %s; see docs/ops/security.md.",
            host,
            ALLOWED_HOSTS_ENV,
        )


#: Slack added to upload limits for multipart framing around the file bytes.
_MULTIPART_OVERHEAD = 1024 * 1024
#: Largest body of any ordinary JSON request.
DEFAULT_BODY_LIMIT = 8 * 1024 * 1024

# (path pattern, limit in bytes as a callable so env overrides apply per request)
_UPLOAD_LIMITS: tuple[tuple[re.Pattern[str], Callable[[], int]], ...] = (
    (re.compile(r"/api/fonts"), lambda: uploads.FONT_MAX_BYTES),
    (re.compile(r"/api/backgrounds"), lambda: uploads.BACKGROUND_MAX_BYTES),
    (re.compile(r"/api/videos/\d+/thumbnail"), lambda: uploads.IMAGE_MAX_BYTES),
    (re.compile(r"/api/playlists/\d+/thumbnail"), lambda: uploads.IMAGE_MAX_BYTES),
    (re.compile(r"/api/review/upload"), uploads.max_video_upload_bytes),
)


def body_limit_for(method: str, path: str) -> int | None:
    """Maximum request body in bytes, or ``None`` when no body is expected."""
    if method in SAFE_METHODS:
        return None
    for pattern, limit in _UPLOAD_LIMITS:
        if pattern.fullmatch(path):
            return limit() + _MULTIPART_OVERHEAD
    return DEFAULT_BODY_LIMIT


class BodyLimitMiddleware:
    """413 for a request body over its route's cap, before anything parses it."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = body_limit_for(scope["method"], scope["path"])
        if limit is None:
            await self.app(scope, receive, send)
            return
        declared = _header(scope, "content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            await _reject(
                scope,
                receive,
                send,
                413,
                "Request body is too large",
                "payload_too_large",
            )
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # Raised inside the app, so FastAPI renders it as a 413.
                    raise StarletteHTTPException(
                        status_code=413, detail="Request body is too large"
                    )
            return message

        await self.app(scope, limited_receive, send)


#: Routes a Cast receiver or AirPlay target fetches from another origin.
MEDIA_ROUTE_PATTERNS = (
    re.compile(r"/api/videos/\d+/stream"),  # original and ?rendition=compat
    re.compile(r"/api/videos/\d+/subtitles/[^/]+"),
    re.compile(r"/api/thumbnails/\d+"),  # poster image
)
_MEDIA_METHODS = "GET, HEAD, OPTIONS"
_MEDIA_EXPOSE = "Content-Range, Accept-Ranges, Content-Length"


def is_media_route(path: str) -> bool:
    return any(p.fullmatch(path) for p in MEDIA_ROUTE_PATTERNS)


class MediaCorsMiddleware:
    """CORS for the media routes only; every other route sends no CORS headers."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] not in SAFE_METHODS
            or not is_media_route(scope["path"])
        ):
            await self.app(scope, receive, send)
            return

        if scope["method"] == "OPTIONS" and _header(
            scope, "access-control-request-method"
        ):
            response = Response(
                status_code=204,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": _MEDIA_METHODS,
                    "Access-Control-Allow-Headers": "Range, Content-Type",
                    "Access-Control-Max-Age": "600",
                },
            )
            await response(scope, receive, send)
            return

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Access-Control-Allow-Origin"] = "*"
                headers["Access-Control-Expose-Headers"] = _MEDIA_EXPOSE
            await send(message)

        await self.app(scope, receive, send_with_cors)


class CsrfMiddleware:
    """Refuse state-changing requests that did not come from this app's own pages.

    * ``X-Horde-Request: 1`` is required. Cross-site JavaScript cannot add a custom
      header without a CORS preflight, and no route answers one.
    * ``Sec-Fetch-Site: cross-site`` is refused outright.
    * An ``Origin`` header, when sent, must name the host that was requested.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in SAFE_METHODS:
            await self.app(scope, receive, send)
            return
        problem = self._problem(scope)
        if problem is None:
            await self.app(scope, receive, send)
            return
        await _reject(scope, receive, send, 403, problem, "csrf_rejected")

    @staticmethod
    def _problem(scope: Scope) -> str | None:
        if _header(scope, CSRF_HEADER) != "1":
            return "Missing X-Horde-Request header"
        if (_header(scope, "sec-fetch-site") or "").lower() == "cross-site":
            return "Cross-site requests are not allowed"
        origin = _header(scope, "origin")
        if origin is not None:
            try:
                origin_host = urlsplit(origin).netloc.lower()
            except ValueError:
                origin_host = ""
            # Proxies may send a comma-joined chain; the first entry is the client's.
            forwarded = (_header(scope, "x-forwarded-host") or "").split(",")[0]
            hosts = {
                (_header(scope, "host") or "").strip().lower(),
                forwarded.strip().lower(),
            } - {""}
            if origin_host not in hosts:
                return "Origin does not match this server"
        return None


# --- Assembly ----------------------------------------------------------------


@dataclass(frozen=True)
class MiddlewareSpec:
    cls: Callable[..., ASGIApp]
    kwargs: dict[str, Any] = field(default_factory=dict)


def build_stack(
    policy: HostPolicy, extra_public: frozenset[tuple[str, str]] = frozenset()
) -> list[MiddlewareSpec]:
    """The security middleware, outermost first. This list *is* the order."""
    return [
        MiddlewareSpec(SecurityHeadersMiddleware),
        MiddlewareSpec(RequestIdMiddleware),
        MiddlewareSpec(HostAllowlistMiddleware, {"policy": policy}),
        MiddlewareSpec(BodyLimitMiddleware),
        MiddlewareSpec(MediaCorsMiddleware),
        MiddlewareSpec(CsrfMiddleware),
        # After every check above, before routing: deny by default for /api.
        MiddlewareSpec(AuthMiddleware, {"extra_public": extra_public}),
    ]


def host_policy_warning(policy: HostPolicy, auth_config: AuthConfig) -> str | None:
    """A startup warning for the setup that most often ends in "400 host_not_allowed".

    Behind a reverse proxy or tunnel (``HORDE_TRUST_PROXY=1``) browsers arrive with
    the public hostname, which the LAN-only defaults reject until it is listed.
    """
    if not auth_config.trust_proxy or policy.extra or policy.allow_any:
        return None
    return (
        f"{TRUST_PROXY_ENV} is set but {ALLOWED_HOSTS_ENV} is empty. Browsers that "
        "reach Horde through the proxy under a public hostname get HTTP 400 "
        f"(host_not_allowed) until it is listed. Set {ALLOWED_HOSTS_ENV}="
        "horde.example.com (comma separated; see docs/ops/security.md)."
    )


def install_security(
    app: FastAPI,
    *,
    allowed_hosts: str | None = None,
    auth_config: AuthConfig | None = None,
    extra_public_routes: frozenset[tuple[str, str]] = frozenset(),
) -> None:
    """Install the middleware stack, the error mappings, the limits and auth state.

    ``allowed_hosts`` overrides ``HORDE_ALLOWED_HOSTS`` and ``auth_config`` the
    ``HORDE_AUTH_DISABLED`` / ``HORDE_TRUST_PROXY`` environment (used by tests).
    ``extra_public_routes`` are (method, path) pairs reachable without signing in,
    for the e2e reset route only.
    """
    policy = HostPolicy.from_env(
        os.environ.get(ALLOWED_HOSTS_ENV) if allowed_hosts is None else allowed_hosts
    )
    for spec in reversed(
        build_stack(policy, extra_public_routes)
    ):  # add_middleware wraps: last is outermost
        app.add_middleware(spec.cls, **spec.kwargs)
    install_error_handlers(app)
    install_log_redaction()
    app.state.host_policy = policy
    app.state.auth = AuthRuntime(config=auth_config or AuthConfig.from_env())
    app.state.extraction_gate = limits.new_extraction_gate()
    app.state.ytdlp_slots = limits.new_ytdlp_slots()
    app.state.request_stats = RequestStats()
    app.state.thumbnail_grab_limit = limits.new_thumbnail_grab_limit()

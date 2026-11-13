"""Outbound URL safety (SSRF defence) shared by every user-supplied URL.

Horde fetches URLs on behalf of the browser: thumbnails, yt-dlp extraction,
stream previews. Without a gate, anyone who can reach the API can make the
server read loopback services, the LAN or a cloud metadata endpoint and (for
thumbnails) read the answer back.

Policy:

* ``http`` and ``https`` only, no embedded credentials.
* The host is resolved and **every** address must be public (not loopback,
  private, link-local, CGNAT, multicast, reserved or unspecified). This also
  covers the cloud metadata addresses (169.254.169.254, fd00:ec2::254,
  100.100.100.200).
* ``HORDE_ALLOW_PRIVATE_URLS=1`` switches the address check off for people who
  download from LAN sources (a NAS, a local media server). The scheme check
  stays.

Two entry points:

* :func:`validate_public_url` is a pre-flight check for code that hands the URL
  to another tool (yt-dlp). It cannot pin the connection, so a hostile DNS
  server that answers differently the second time is not covered there.
* :func:`fetch_bytes` fetches with httpx and is airtight: redirects are followed
  by hand with a fresh check per hop, and the connection is pinned to the
  address that was validated. Cookie and authorization headers are dropped once
  a redirect leaves the first URL's origin.

The AI provider URLs (``base_url``, ``embed_base_url``) are deliberately not
routed through this module: they are often LAN hosts by design and are
administrator-only settings.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import socket
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import anyio
import httpcore
import httpx

logger = logging.getLogger(__name__)

ALLOWED_SCHEMES = frozenset({"http", "https"})
MAX_REDIRECTS = 5
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_TRUTHY = frozenset({"1", "true", "yes", "on"})

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class UnsafeUrlError(ValueError):
    """The URL is not allowed (bad scheme, or it points at a non-public host)."""


class UrlFetchError(RuntimeError):
    """The URL was allowed but the fetch failed (size cap, HTTP error, network).

    ``status`` is the HTTP status when the server answered with an error.
    """

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def allow_private_urls() -> bool:
    return os.environ.get("HORDE_ALLOW_PRIVATE_URLS", "").strip().lower() in _TRUTHY


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """The IPv4 address an IPv6 address smuggles: mapped, compatible or NAT64."""
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    packed = ip.packed
    if packed[:12] == bytes(12):  # ::a.b.c.d (IPv4-compatible, deprecated)
        return ipaddress.IPv4Address(packed[12:])
    if packed[:12] == bytes.fromhex("0064ff9b0000000000000000"):  # 64:ff9b::/96
        return ipaddress.IPv4Address(packed[12:])
    return None


def is_blocked_address(ip: IPAddress) -> bool:
    """True for anything that is not a globally routable unicast address."""
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded is not None:
            ip = embedded
    # ``is_global`` is False for loopback, private, link-local, CGNAT
    # (100.64/10), reserved, documentation and unspecified ranges.
    return not ip.is_global or ip.is_multicast


def _resolve(host: str, port: int) -> list[IPAddress]:
    """Resolve ``host`` to addresses. Kept as one function so tests can stub DNS."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    out: list[IPAddress] = []
    for info in infos:
        addr = ipaddress.ip_address(str(info[4][0]).split("%")[0])
        if addr not in out:
            out.append(addr)
    return out


#: Headers that carry credentials for one origin, never sent to another.
CREDENTIAL_HEADERS = frozenset({"cookie", "authorization", "proxy-authorization"})


@dataclass(frozen=True)
class CheckedUrl:
    url: str
    scheme: str
    host: str
    port: int
    #: Validated addresses to connect to. Empty when the name did not resolve.
    addresses: tuple[IPAddress, ...]

    @property
    def origin(self) -> tuple[str, str, int]:
        return self.scheme, self.host.lower(), self.port


def without_credentials(headers: dict[str, str]) -> dict[str, str]:
    """``headers`` minus the credential headers: for a redirect to another origin,
    as browsers and httpx do."""
    return {k: v for k, v in headers.items() if k.lower() not in CREDENTIAL_HEADERS}


def _checked_addresses(host: str, port: int) -> tuple[IPAddress, ...]:
    """The addresses ``host`` resolves to, all public (else UnsafeUrlError).

    Empty when the name does not resolve.
    """
    try:
        literal: IPAddress | None = ipaddress.ip_address(host)
    except ValueError:
        literal = None

    if literal is not None:
        addresses: tuple[IPAddress, ...] = (literal,)
    else:
        try:
            addresses = tuple(_resolve(host, port))
        except socket.gaierror:
            # A name that does not resolve cannot reach anything. Letting it
            # through keeps offline use and unreachable placeholder hosts working;
            # the actual fetch then fails on its own.
            addresses = ()
    if not allow_private_urls():
        for addr in addresses:
            if is_blocked_address(addr):
                raise UnsafeUrlError(
                    "That address points at this machine or a private network. "
                    "Set HORDE_ALLOW_PRIVATE_URLS=1 to allow LAN sources."
                )
    return addresses


class PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Opens TCP connections only to addresses that pass the public-address check.

    The name is resolved once, here, and the connection goes to one of those
    checked addresses, so a DNS answer cannot change between the check and the
    connect. httpx keeps working by name above it: connections pool per host,
    TLS sends the host as SNI and verifies its certificate, cookies stay per host.
    """

    def __init__(self) -> None:
        self._inner = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        addresses = await anyio.to_thread.run_sync(_checked_addresses, host, port)
        if not addresses:
            raise UnsafeUrlError("Could not resolve that host")
        last_error: Exception | None = None
        for ip in addresses:  # an IPv6-first host still works from an IPv4-only box
            try:
                return await self._inner.connect_tcp(
                    str(ip),
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc
        assert last_error is not None  # noqa: S101 - addresses is never empty here
        raise last_error

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("Unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


def pinned_async_transport(limits: httpx.Limits) -> httpx.AsyncHTTPTransport:
    """An httpx transport that connects through :class:`PinnedNetworkBackend`.

    A client given it ignores ``HTTP(S)_PROXY`` (a proxy would resolve the names).
    """
    transport = httpx.AsyncHTTPTransport(limits=limits)
    # httpx has no network_backend option: rebuild its pool with ours, as it does.
    transport._pool = httpcore.AsyncConnectionPool(
        ssl_context=httpx.create_ssl_context(),
        max_connections=limits.max_connections,
        max_keepalive_connections=limits.max_keepalive_connections,
        keepalive_expiry=limits.keepalive_expiry,
        network_backend=PinnedNetworkBackend(),
    )
    return transport


def check_url(url: str) -> CheckedUrl:
    """Validate ``url`` and return the parts needed to connect safely."""
    raw = (url or "").strip()
    try:
        parts = urlsplit(raw)
        host = parts.hostname
        explicit_port = parts.port
    except ValueError as exc:
        raise UnsafeUrlError("Not a valid URL") from exc
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise UnsafeUrlError("Only http and https URLs are allowed")
    if not host:
        raise UnsafeUrlError("URL has no host")
    if parts.username is not None or parts.password is not None:
        raise UnsafeUrlError("URLs with embedded credentials are not allowed")
    scheme = parts.scheme.lower()
    port = explicit_port or (443 if scheme == "https" else 80)

    addresses = _checked_addresses(host, port)
    return CheckedUrl(url=raw, scheme=scheme, host=host, port=port, addresses=addresses)


def validate_public_url(url: str) -> str:
    """Raise :class:`UnsafeUrlError` unless ``url`` is a public http(s) URL."""
    return check_url(url).url


@dataclass(frozen=True)
class FetchResult:
    body: bytes
    content_type: str
    final_url: str


def _pinned_request(checked: CheckedUrl, ip: IPAddress, headers: dict[str, str]):
    """URL, headers and extensions that connect to the validated address ``ip``."""
    parts = urlsplit(checked.url)
    ip_text = f"[{ip}]" if ip.version == 6 else str(ip)
    default_port = 443 if checked.scheme == "https" else 80
    netloc = ip_text if checked.port == default_port else f"{ip_text}:{checked.port}"
    host_header = checked.host
    if ":" in host_header:  # IPv6 literal
        host_header = f"[{host_header}]"
    if checked.port != default_port:
        host_header = f"{host_header}:{checked.port}"
    pinned = parts._replace(netloc=netloc).geturl()
    extensions = {"sni_hostname": checked.host} if checked.scheme == "https" else {}
    return pinned, {**headers, "Host": host_header}, extensions


def fetch_bytes(
    url: str,
    *,
    max_bytes: int,
    timeout: float = 30.0,
    headers: dict[str, str] | None = None,
    max_redirects: int = MAX_REDIRECTS,
) -> FetchResult:
    """GET ``url`` safely. Raises :class:`UnsafeUrlError` / :class:`UrlFetchError`.

    Unlike :func:`validate_public_url` this refuses a host that does not resolve:
    the connection is pinned to an address we validated, and without one httpx would
    resolve the name again and could be handed a different (internal) answer.
    Validated addresses are tried in order, so an IPv6-first host still works from an
    IPv4-only machine.
    """
    current = url
    base_headers = dict(headers or {})
    first_origin: tuple[str, str, int] | None = None
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        for _hop in range(max_redirects + 1):
            checked = check_url(current)
            if not checked.addresses:
                raise UnsafeUrlError("Could not resolve that host")
            if first_origin is None:
                first_origin = checked.origin
            elif checked.origin != first_origin:
                base_headers = without_credentials(base_headers)
            redirect_to: str | None = None
            last_error: httpx.HTTPError | None = None
            for ip in checked.addresses:
                target, req_headers, extensions = _pinned_request(
                    checked, ip, base_headers
                )
                try:
                    with client.stream(
                        "GET", target, headers=req_headers, extensions=extensions
                    ) as resp:
                        if resp.status_code in REDIRECT_STATUSES:
                            location = resp.headers.get("location")
                            if not location:
                                raise UrlFetchError(
                                    "Redirect without a Location header"
                                )
                            redirect_to = urljoin(checked.url, location)
                            break
                        if resp.status_code >= 400:
                            raise UrlFetchError(
                                f"Server answered {resp.status_code}",
                                status=resp.status_code,
                            )
                        return _read_capped(resp, checked.url, max_bytes)
                except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                    last_error = exc  # try the next validated address
                except httpx.HTTPError as exc:
                    raise UrlFetchError(f"Could not fetch URL: {exc}") from exc
            else:
                raise UrlFetchError(f"Could not connect: {last_error}")
            current = redirect_to or current
    raise UrlFetchError(f"Too many redirects (more than {max_redirects})")


def _read_capped(resp: httpx.Response, final_url: str, max_bytes: int) -> FetchResult:
    declared = resp.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise UrlFetchError("Response is too large")
    chunks: list[bytes] = []
    total = 0
    for chunk in resp.iter_bytes():
        total += len(chunk)
        if total > max_bytes:
            raise UrlFetchError("Response is too large")
        chunks.append(chunk)
    return FetchResult(
        body=b"".join(chunks),
        content_type=resp.headers.get("content-type", ""),
        final_url=final_url,
    )

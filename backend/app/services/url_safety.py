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
  address that was validated.

The Ollama ``base_url`` is deliberately not routed through this module: it is a
LAN host by design and is an administrator-only setting.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

logger = logging.getLogger(__name__)

ALLOWED_SCHEMES = frozenset({"http", "https"})
MAX_REDIRECTS = 5
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_TRUTHY = frozenset({"1", "true", "yes", "on"})

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class UnsafeUrlError(ValueError):
    """The URL is not allowed (bad scheme, or it points at a non-public host)."""


class UrlFetchError(RuntimeError):
    """The URL was allowed but the fetch failed (size cap, HTTP error, network)."""


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
        addr = ipaddress.ip_address(info[4][0].split("%")[0])
        if addr not in out:
            out.append(addr)
    return out


@dataclass(frozen=True)
class CheckedUrl:
    url: str
    scheme: str
    host: str
    port: int
    #: Validated addresses to connect to. Empty when the name did not resolve.
    addresses: tuple[IPAddress, ...]


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
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        for _hop in range(max_redirects + 1):
            checked = check_url(current)
            if not checked.addresses:
                raise UnsafeUrlError("Could not resolve that host")
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
                        if resp.status_code in _REDIRECT_STATUSES:
                            location = resp.headers.get("location")
                            if not location:
                                raise UrlFetchError(
                                    "Redirect without a Location header"
                                )
                            redirect_to = urljoin(checked.url, location)
                            break
                        if resp.status_code >= 400:
                            raise UrlFetchError(f"Server answered {resp.status_code}")
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

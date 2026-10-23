"""Send one message to one target: ntfy, a generic webhook or a Discord webhook.

Targets are addresses an administrator typed in, often on the LAN (a self-hosted
ntfy), so private addresses are fine; what is enforced is http(s), no credentials in
the URL, no redirects followed and no response body kept. Errors that reach the
caller or the Settings screen are short fixed sentences: an exception's own text can
carry the address, and a topic or a Discord token in it is a secret.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from ... import config
from .render import Message, clean

logger = logging.getLogger(__name__)

TIMEOUT_SEC = 10.0
KIND_NTFY = "ntfy"
KIND_WEBHOOK = "webhook"
KIND_DISCORD = "discord"
KINDS = (KIND_NTFY, KIND_WEBHOOK, KIND_DISCORD)
DISCORD_LIMIT = 2000
USER_AGENT = "Horde-Notifications"

#: A function that sends ``message`` to ``target`` or raises ``DeliveryError``.
Sender = Callable[[dict[str, Any], Message], object]


class DeliveryError(Exception):
    """A send failed. ``str(exc)`` is safe to show; ``retryable`` says whether to try again."""

    def __init__(
        self, message: str, *, status_code: int | None = None, retryable: bool = False
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable


@dataclass(frozen=True)
class Request:
    url: str
    headers: dict[str, str]
    content: bytes | None = None
    json: dict[str, Any] | None = None


def absolute_link(path: str | None) -> str | None:
    """``path`` on this Horde's public address; None when no address is configured."""
    if not path or not config.PUBLIC_URL:
        return None
    return config.PUBLIC_URL + path


def _header_text(value: str) -> str:
    """A header value: plain ASCII as it is, anything else as an RFC 2047 word (ntfy decodes it)."""
    text = clean(value, 250)
    if text.isascii():
        return text
    return "=?UTF-8?B?" + base64.b64encode(text.encode("utf-8")).decode("ascii") + "?="


def ntfy_url(target: dict[str, Any]) -> str:
    return f"{str(target['url']).rstrip('/')}/{quote(str(target.get('topic') or ''), safe='')}"


def build_request(target: dict[str, Any], message: Message) -> Request:
    kind = target["kind"]
    token = str(target.get("token") or "")
    link = absolute_link(message.path)
    headers = {"User-Agent": USER_AGENT}
    if kind == KIND_NTFY:
        headers["Title"] = _header_text(message.title)
        headers["Priority"] = "high" if message.urgent else "default"
        tags = ",".join((*message.tags, "horde"))
        headers["Tags"] = tags
        if link:
            headers["Click"] = link
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return Request(ntfy_url(target), headers, content=message.body.encode("utf-8"))
    if kind == KIND_WEBHOOK:
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = {
            "event": message.event,
            "title": message.title,
            "message": message.body,
            "url": link,
            "data": {"path": message.path, **message.data},
            "sent_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
        }
        return Request(str(target["url"]), headers, json=body)
    if kind == KIND_DISCORD:
        text = f"**{message.title}**\n{message.body}"
        if link:
            text += f"\n{link}"
        return Request(
            str(target["url"]),
            headers,
            # Titles come from the internet: never let one ping @everyone.
            json={
                "content": text[:DISCORD_LIMIT],
                "allowed_mentions": {"parse": []},
            },
        )
    raise DeliveryError("Unknown target type")


def explain_failure(exc: Exception) -> DeliveryError:
    """A ``DeliveryError`` with a fixed sentence for a transport failure."""
    if isinstance(exc, httpx.TimeoutException):
        return DeliveryError(
            f"The server did not answer within {TIMEOUT_SEC:.0f} seconds",
            retryable=True,
        )
    if isinstance(exc, httpx.ConnectError):
        if "CERTIFICATE" in str(exc).upper():
            return DeliveryError("The server's TLS certificate was not accepted")
        return DeliveryError("Could not connect to the server", retryable=True)
    if isinstance(exc, httpx.InvalidURL | httpx.UnsupportedProtocol):
        return DeliveryError("The address is not a usable http(s) URL")
    return DeliveryError("The request failed", retryable=True)


def explain_status(code: int) -> DeliveryError:
    if code in (401, 403):
        return DeliveryError(
            f"The server rejected the credentials (HTTP {code})", status_code=code
        )
    if code == 404:
        return DeliveryError(
            "Not found (HTTP 404). Check the address and topic", status_code=code
        )
    if 300 <= code < 400:
        return DeliveryError(
            f"The server redirected the request (HTTP {code}). Redirects are not "
            "followed; use the final address",
            status_code=code,
        )
    if code == 429:
        return DeliveryError(
            "The server is rate limiting requests (HTTP 429)",
            status_code=code,
            retryable=True,
        )
    return DeliveryError(
        f"The server answered HTTP {code}", status_code=code, retryable=code >= 500
    )


def send(
    target: dict[str, Any],
    message: Message,
    *,
    transport: httpx.BaseTransport | None = None,
) -> int:
    """Deliver ``message``; returns the HTTP status. Raises ``DeliveryError``."""
    request = build_request(target, message)
    try:
        with httpx.Client(
            timeout=TIMEOUT_SEC, follow_redirects=False, transport=transport
        ) as client:
            response = client.post(
                request.url,
                headers=request.headers,
                content=request.content,
                json=request.json,
            )
    except httpx.HTTPError as exc:
        logger.debug("notification request failed", exc_info=True)
        raise explain_failure(exc) from None
    except ValueError:
        # httpx rejects a header value or URL it cannot encode.
        logger.debug("notification request was malformed", exc_info=True)
        raise DeliveryError("The request could not be built from this target") from None
    if not 200 <= response.status_code < 300:
        raise explain_status(response.status_code)
    return response.status_code


def validate_address(url: str) -> str:
    """The URL if it is http(s) with a host and no embedded credentials; else ValueError."""
    text = url.strip()
    try:
        parts = urlsplit(text)
        host = parts.hostname
        _ = parts.port  # reading it raises ValueError for a bad port
    except ValueError as exc:
        raise ValueError("Not a valid URL") from exc
    if parts.scheme.lower() not in ("http", "https") or not host:
        raise ValueError("Must be an http:// or https:// URL")
    if parts.username is not None or parts.password is not None:
        raise ValueError("Put credentials in the access token field, not in the URL")
    return text

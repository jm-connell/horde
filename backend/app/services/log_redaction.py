"""Keep secrets that travel in URLs and headers out of the logs.

Signed media links carry their token in ``?mt=``. The token is only good for one
video for 12 hours, but it should not sit in a log file (or a pasted log) at all.
Notification targets add two more: the token of a Discord webhook is part of its
path, and an ntfy / webhook token travels as a bearer token.
"""

from __future__ import annotations

import logging
import re

import httpx

_MT = re.compile(r"([?&]mt=)[^&\s\"]*")
_DISCORD_WEBHOOK = re.compile(r"(/api/webhooks/\d+/)[^/?\s\"]+")
_BEARER = re.compile(r"(Bearer\s+)[^\s\"',;]+", re.IGNORECASE)
REDACTED = "[redacted]"


def redact_query_secrets(text: str) -> str:
    text = _MT.sub(rf"\1{REDACTED}", text)
    text = _DISCORD_WEBHOOK.sub(rf"\1{REDACTED}", text)
    return _BEARER.sub(rf"\1{REDACTED}", text)


def _redact_arg(arg: object) -> object:
    if isinstance(arg, str):
        return redact_query_secrets(arg)
    if isinstance(arg, httpx.URL):  # httpx logs ``request.url`` as an object
        return redact_query_secrets(str(arg))
    return arg


class RedactQuerySecrets(logging.Filter):
    """Rewrites ``?mt=...`` in log records (uvicorn's access log passes the path as an arg)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_query_secrets(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_redact_arg(a) for a in record.args)
        return True


ACCESS_LOGGERS = ("uvicorn.access", "uvicorn.error", "httpx", "httpcore")


def install_log_redaction() -> None:
    """Attach the filter to the loggers that print request URLs (idempotent)."""
    for name in ACCESS_LOGGERS:
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactQuerySecrets) for f in logger.filters):
            logger.addFilter(RedactQuerySecrets())

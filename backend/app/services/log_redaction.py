"""Keep secrets that travel in URLs out of the access log.

Signed media links carry their token in ``?mt=``. The token is only good for one
video for 12 hours, but it should not sit in a log file (or a pasted log) at all.
"""

from __future__ import annotations

import logging
import re

_MT = re.compile(r"([?&]mt=)[^&\s\"]*")
REDACTED = "[redacted]"


def redact_query_secrets(text: str) -> str:
    return _MT.sub(rf"\1{REDACTED}", text)


class RedactQuerySecrets(logging.Filter):
    """Rewrites ``?mt=...`` in log records (uvicorn's access log passes the path as an arg)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_query_secrets(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(
                redact_query_secrets(a) if isinstance(a, str) else a
                for a in record.args
            )
        return True


ACCESS_LOGGERS = ("uvicorn.access", "uvicorn.error", "httpx", "httpcore")


def install_log_redaction() -> None:
    """Attach the filter to the loggers that print request URLs (idempotent)."""
    for name in ACCESS_LOGGERS:
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactQuerySecrets) for f in logger.filters):
            logger.addFilter(RedactQuerySecrets())

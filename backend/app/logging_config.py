"""Process-wide logging setup: level, format and correlation IDs.

``configure_logging()`` is called when ``app.main`` is imported. Uvicorn has already
installed its own handlers by then, so the config here replaces the handlers of the
``uvicorn`` loggers too and the access log shares the application format.

Environment:

* ``HORDE_LOG_LEVEL``  DEBUG / INFO / WARNING / ERROR (default INFO).
* ``HORDE_LOG_FORMAT`` ``text`` (default) or ``json`` (one object per line).

Two context variables tag every record emitted while they are set: ``request_id``
(set by the request middleware, one per HTTP request) and ``job_id`` (set by the
download / AI / catalog workers around one job). ``anyio`` and ``asyncio`` copy the
context into worker threads, so handlers declared with plain ``def`` keep the ID.
"""

from __future__ import annotations

import contextvars
import json
import logging
import logging.config
import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

LOG_LEVEL_ENV = "HORDE_LOG_LEVEL"
LOG_FORMAT_ENV = "HORDE_LOG_FORMAT"

#: Name of the stream handler installed on the root logger by ``build_config``.
HANDLER_NAME = "horde-console"

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "horde_request_id", default=None
)
job_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "horde_job_id", default=None
)

#: An incoming ``X-Request-ID`` is only trusted when it is short and printable, so a
#: client cannot inject newlines or megabytes into the log.
_SANE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")

_TEXT_FORMAT = (
    "%(asctime)s %(levelname)-7s %(name)s [%(threadName)s]%(context)s %(message)s"
)


def sane_request_id(value: str | None) -> str | None:
    if value and _SANE_REQUEST_ID.fullmatch(value):
        return value
    return None


@contextmanager
def job_context(job_id: object) -> Iterator[None]:
    """Tag every log record emitted inside the block with ``job_id``."""
    token = job_id_var.set(str(job_id))
    try:
        yield
    finally:
        job_id_var.reset(token)


class ContextFilter(logging.Filter):
    """Copies the correlation IDs onto each record (``context`` is the text suffix)."""

    def filter(self, record: logging.LogRecord) -> bool:
        request_id = request_id_var.get()
        job_id = job_id_var.get()
        record.request_id = request_id
        record.job_id = job_id
        parts = []
        if request_id:
            parts.append(f"request_id={request_id}")
        if job_id:
            parts.append(f"job_id={job_id}")
        record.context = f" ({' '.join(parts)})" if parts else ""
        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line; no dependency."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(
                timespec="milliseconds"
            ),
            "level": record.levelname,
            "logger": record.name,
            "thread": record.threadName,
            "message": record.getMessage(),
        }
        request_id = getattr(record, "request_id", None)
        job_id = getattr(record, "job_id", None)
        if request_id:
            payload["request_id"] = request_id
        if job_id:
            payload["job_id"] = job_id
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)
        return json.dumps(payload, default=str)


def resolve_level(raw: str | None) -> str:
    value = (raw or "").strip().upper()
    return value if value in logging.getLevelNamesMapping() else "INFO"


def resolve_format(raw: str | None) -> str:
    return "json" if (raw or "").strip().lower() == "json" else "text"


def build_config(level: str = "INFO", fmt: str = "text") -> dict[str, Any]:
    """The ``dictConfig`` for the app and for uvicorn's loggers."""
    formatter = (
        {"()": "app.logging_config.JsonFormatter"}
        if fmt == "json"
        else {"format": _TEXT_FORMAT, "datefmt": "%Y-%m-%d %H:%M:%S"}
    )
    return {
        "version": 1,
        # Keep loggers that modules created at import time (before this ran).
        "disable_existing_loggers": False,
        "filters": {"context": {"()": "app.logging_config.ContextFilter"}},
        "formatters": {"horde": formatter},
        "handlers": {
            HANDLER_NAME: {
                "class": "logging.StreamHandler",
                "formatter": "horde",
                "filters": ["context"],
                "stream": "ext://sys.stderr",
            }
        },
        "root": {"handlers": [HANDLER_NAME], "level": level},
        "loggers": {
            # Uvicorn installs its own handlers; route them through ours.
            "uvicorn": {"handlers": [], "level": level, "propagate": True},
            "uvicorn.error": {"handlers": [], "level": level, "propagate": True},
            "uvicorn.access": {"handlers": [], "level": level, "propagate": True},
        },
    }


def is_configured() -> bool:
    return any(h.get_name() == HANDLER_NAME for h in logging.getLogger().handlers)


def configure_logging(*, force: bool = False) -> None:
    """Apply the env-derived configuration.

    A second call is a no-op unless ``force`` is set, so importing ``app.main`` late
    (as the test-suite does) never throws away handlers added since.
    """
    if is_configured() and not force:
        return
    level = resolve_level(os.environ.get(LOG_LEVEL_ENV))
    fmt = resolve_format(os.environ.get(LOG_FORMAT_ENV))
    logging.config.dictConfig(build_config(level, fmt))

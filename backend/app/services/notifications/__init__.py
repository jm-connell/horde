"""Outgoing notifications (ntfy, webhook, Discord) for things the administrator wants to hear about.

Callers use the functions here; they never block and never raise, so a hook point can sit
in the middle of the download pipeline. Declared events: ``events.py``. Targets: ``targets.py``.
Delivery and its worker: ``notifier.py`` (held on ``AppContext.notifier``).
"""

from __future__ import annotations

import logging
from typing import Any

from ...context import current
from ...models import JobStatus
from . import events

logger = logging.getLogger(__name__)


def emit(
    event: str,
    payload: dict[str, Any],
    *,
    dedupe_key: str | None = None,
    dedupe_ttl: float = 600.0,
) -> None:
    """Queue ``event`` on the active context's notifier (see ``Notifier.emit``)."""
    try:
        notifier = current().notifier
    except RuntimeError:
        logger.debug("no active context; dropping %s notification", event)
        return
    notifier.emit(event, payload, dedupe_key=dedupe_key, dedupe_ttl=dedupe_ttl)


def job_finished(job: dict[str, Any]) -> None:
    """A download job ended in ``error`` or ``completed``; ``job`` is a snapshot of its row."""
    job_id = job["job_id"]
    if job["status"] == JobStatus.error.value:
        emit(
            events.DOWNLOAD_FAILED,
            job,
            dedupe_key=f"job-failed:{job_id}",
            dedupe_ttl=300,
        )
    elif job["status"] == JobStatus.completed.value and job["destination"] == "library":
        emit(
            events.DOWNLOAD_COMPLETED,
            job,
            dedupe_key=f"job-done:{job_id}",
            dedupe_ttl=300,
        )

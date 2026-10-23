"""Events nobody emits: the notifier's worker looks for them every few minutes.

A new release and the outcome of "Update now" are not things Horde does; they show up
in a GitHub lookup and in files the host's update script writes. Each is reported once:
what was already reported is remembered in the settings (``notification_state``), so a
restart (the update itself restarts Horde) does not repeat it.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from ...context import current
from .. import app_settings, update_control, updates
from . import events, targets

if TYPE_CHECKING:
    from .notifier import Notifier

logger = logging.getLogger(__name__)

FAILED_STATES = frozenset({"failed", "rolled_back", "interrupted"})
#: An update that failed longer ago than this is history, not news.
FAILURE_MAX_AGE = timedelta(hours=24)


def _remember(key: str, value: str) -> None:
    app_settings.edit(
        lambda current_settings: {
            "notification_state": {
                **(current_settings.get("notification_state") or {}),
                key: value,
            }
        }
    )


def _reported(key: str) -> str:
    state = app_settings.load().get("notification_state") or {}
    return str(state.get(key) or "")


def _finished_recently(finished_at: str | None) -> bool:
    try:
        stamp = datetime.fromisoformat(finished_at or "")
    except ValueError:
        return False
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=UTC)
    return datetime.now(UTC) - stamp <= FAILURE_MAX_AGE


def check_updates(notifier: Notifier) -> None:
    ctx = current()
    if targets.subscribers(events.UPDATE_FAILED, {}):
        status = update_control.read_status(ctx.paths.data)
        request_id = status.get("request_id")
        if (
            status["state"] in FAILED_STATES
            and request_id
            and request_id != _reported("update_failed")
            and _finished_recently(status.get("finished_at"))
        ):
            _remember("update_failed", request_id)
            notifier.emit(
                events.UPDATE_FAILED,
                {
                    "state": status["state"],
                    "exit_code": status.get("exit_code"),
                    "request_id": request_id,
                },
            )
    if targets.subscribers(events.UPDATE_AVAILABLE, {}):
        found: dict[str, Any] = updates.check_for_updates(offline=ctx.e2e)
        latest = found.get("latest_sha")
        if (
            found.get("update_available")
            and latest
            and latest != _reported("update_available")
        ):
            _remember("update_available", str(latest))
            notifier.emit(
                events.UPDATE_AVAILABLE,
                {
                    "latest": found.get("latest_short") or latest,
                    "current": found.get("current_short"),
                    "html_url": found.get("latest_html_url"),
                },
            )

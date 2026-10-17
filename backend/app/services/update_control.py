"""The "Update now" button: hand an update request to the host and report back.

Horde cannot rebuild its own container. The button writes
``DATA_DIR/update/request.env``; ``scripts/update_watch.sh``, run every minute
on the Docker host by cron, picks it up, runs ``update.sh`` and writes
``status.env`` and ``update.log`` next to it. It also stamps ``watcher.env`` on
every run, which is how Horde knows the button is set up. All files are
``KEY=value`` lines (see the watcher script). Horde never touches Docker.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..errors import CodedHTTPException

logger = logging.getLogger(__name__)

#: The cron job runs every minute; allow for a few missed runs.
WATCHER_STALE_SEC = 5 * 60
LOG_TAIL_LINES = 60
_LOG_TAIL_BYTES = 64 * 1024
_FINISHED_STATES = {"updated", "up_to_date", "rolled_back", "failed", "interrupted"}
_USERNAME_SAFE = re.compile(r"[^A-Za-z0-9_.@-]")
_REQUEST_ID = re.compile(r"[0-9a-f]{32}")


def control_dir(data: Path) -> Path:
    return data / "update"


def _read_env(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return {}
    except OSError:
        logger.warning("could not read %s", path, exc_info=True)
        return {}
    out: dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip():
            out[key.strip()] = value.strip()
    return out


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _log_tail(path: Path) -> list[str]:
    try:
        with path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - _LOG_TAIL_BYTES))
            data = fh.read()
    except FileNotFoundError:
        return []
    except OSError:
        logger.warning("could not read %s", path, exc_info=True)
        return []
    lines = data.decode("utf-8", errors="replace").splitlines()
    if len(data) == _LOG_TAIL_BYTES and lines:
        lines = lines[1:]  # first line was cut by the byte window
    return lines[-LOG_TAIL_LINES:]


def read_status(data: Path, *, now: datetime | None = None) -> dict[str, Any]:
    """What the System tab shows: is the watcher set up, and what is happening."""
    now = now or datetime.now(UTC)
    root = control_dir(data)
    last_seen = _parse_time(_read_env(root / "watcher.env").get("LAST_SEEN"))
    connected = (
        last_seen is not None and (now - last_seen).total_seconds() <= WATCHER_STALE_SEC
    )

    pending = _read_env(root / "request.env")
    status = _read_env(root / "status.env")
    current = _read_env(root / "current.env")
    taken = current.get("REQUEST_ID", "")
    if pending:
        state = "requested"
        request = pending
        status = {}
    elif _REQUEST_ID.fullmatch(taken) and taken != status.get("REQUEST_ID"):
        # The watcher has taken the request but not written status.env yet
        # (or died in between; its next run marks that interrupted).
        state = "running" if connected else "interrupted"
        request = current
        status = {}
    elif status:
        state = status.get("STATE", "")
        if state == "running" and not connected:
            # The watcher stopped checking in mid-update (host rebooted, cron
            # removed); it marks this itself on its next run.
            state = "interrupted"
        elif state != "running" and state not in _FINISHED_STATES:
            state = "failed"
        request = (
            current if current.get("REQUEST_ID") == status.get("REQUEST_ID") else {}
        )
    else:
        state = "idle"
        request = {}

    exit_code = status.get("EXIT_CODE")
    return {
        "watcher_connected": connected,
        "watcher_last_seen": last_seen.isoformat() if last_seen else None,
        "state": state,
        "request_id": request.get("REQUEST_ID") or status.get("REQUEST_ID") or None,
        "requested_at": request.get("REQUESTED_AT") or None,
        "requested_by": request.get("REQUESTED_BY") or None,
        "started_at": status.get("STARTED_AT") or None,
        "finished_at": status.get("FINISHED_AT") or None,
        "exit_code": int(exit_code) if exit_code and exit_code.isdigit() else None,
        "log_tail": _log_tail(root / "update.log") if status else [],
    }


def request_update(data: Path, username: str) -> dict[str, Any]:
    """Leave a request for the watcher. Refuses when it is not set up or busy."""
    current = read_status(data)
    if current["state"] in ("requested", "running"):
        raise CodedHTTPException(
            409, "An update is already requested or running.", "update_in_progress"
        )
    if not current["watcher_connected"]:
        raise CodedHTTPException(
            409,
            "The update button is not set up on the server yet.",
            "update_watcher_missing",
        )
    root = control_dir(data)
    stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    who = _USERNAME_SAFE.sub("_", username)[:64] or "admin"
    body = f"REQUEST_ID={uuid.uuid4().hex}\nREQUESTED_AT={stamp}\nREQUESTED_BY={who}\n"
    tmp = root / f".request.{uuid.uuid4().hex}.tmp"
    try:
        root.mkdir(parents=True, exist_ok=True)
        tmp.write_text(body, encoding="utf-8")
        os.replace(tmp, root / "request.env")
    except OSError:
        logger.warning("could not write the update request in %s", root, exc_info=True)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            logger.debug("could not remove %s", tmp, exc_info=True)
        raise CodedHTTPException(
            500,
            "Horde could not write the update request to its data folder "
            "(check the owner of DATA_PATH/update).",
            "update_request_failed",
        ) from None
    logger.info("update requested by %s", who)
    return read_status(data)


def cancel_request(data: Path) -> dict[str, Any]:
    """Withdraw a request the watcher has not picked up yet."""
    try:
        (control_dir(data) / "request.env").unlink()
    except FileNotFoundError:
        raise CodedHTTPException(
            409,
            "There is no waiting update to cancel (it may have started already).",
            "update_not_pending",
        ) from None
    return read_status(data)

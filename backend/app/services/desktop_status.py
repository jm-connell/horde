"""The status file the desktop shell reads: ``DATA_DIR/desktop/status.json``.

The shell decides when an update may install (nothing running, nothing queued, no
video served for a while) from this file instead of a new HTTP route. The server
rewrites it every few seconds and once at shutdown, only in the desktop runtime.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from ..context import current
from . import activity
from . import app_settings as app_settings_svc
from .auth import accounts
from .workers import BackgroundWorker

if TYPE_CHECKING:
    from ..context import AppContext

logger = logging.getLogger(__name__)

WRITE_INTERVAL_SEC = 5.0


@dataclass
class DesktopRuntime:
    """What the status file needs that nothing else keeps."""

    #: When video bytes (library, preview or live) were last being served.
    last_media_at: datetime | None = None
    #: Media responses being sent right now. A film can be one response that
    #: lasts hours, so "last served" alone would call a viewer idle.
    media_active: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def begin_media(self) -> None:
        with self._lock:
            self.media_active += 1
            self.last_media_at = datetime.now(UTC)

    def end_media(self) -> None:
        with self._lock:
            self.media_active = max(0, self.media_active - 1)
            self.last_media_at = datetime.now(UTC)


def track_media() -> Iterator[None]:
    """Route dependency for the endpoints that send video bytes.

    Counts the response as in flight until it has been sent in full (FastAPI
    runs the part after ``yield`` once the response is finished, also when the
    client goes away), so the desktop app never calls Horde idle while someone
    is watching or saving a video.
    """
    runtime = current().desktop
    runtime.begin_media()
    try:
        yield
    finally:
        runtime.end_media()


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def build_status(ctx: AppContext) -> dict[str, Any]:
    snap = activity.snapshot()
    running = dict(Counter(task["kind"] for task in snap["running"]))
    queued = sum(snap["queued"].values())
    with ctx.session() as session:
        users = accounts.count_users(session)
    last_media = ctx.desktop.last_media_at
    media_active = ctx.desktop.media_active
    return {
        "written_at": _iso(datetime.now(UTC)),
        "pid": os.getpid(),
        "version": os.environ.get("HORDE_VERSION", "").strip() or None,
        "setup_required": users == 0
        or not app_settings_svc.load().get("setup_completed"),
        "busy": bool(running) or queued > 0 or media_active > 0,
        "running": running,
        "queued": queued,
        "media_active": media_active,
        "last_media_at": _iso(last_media) if last_media else None,
    }


def write_status(ctx: AppContext) -> None:
    """Replace the file atomically; a failure is retried on the next tick."""
    folder = ctx.paths.data / "desktop"
    try:
        text = json.dumps(build_status(ctx))
    except Exception:
        logger.warning("could not build the desktop status", exc_info=True)
        return
    try:
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / "status.json.tmp"
        tmp.write_text(text, encoding="utf-8")
        # On Windows this fails while the shell has the file open.
        os.replace(tmp, folder / "status.json")
    except OSError:
        logger.debug("could not write the desktop status file", exc_info=True)


def create_worker(ctx: AppContext) -> BackgroundWorker:
    def run(worker: BackgroundWorker) -> None:
        write_status(ctx)
        while not worker.sleep(WRITE_INTERVAL_SEC):
            write_status(ctx)
        write_status(ctx)

    return BackgroundWorker("desktop-status", run)

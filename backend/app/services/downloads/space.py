"""Disk limits for downloads: the library size limit and the free-space floor.

``SpaceGate.check`` says whether a job may start now. The queue asks before it
dispatches a job and keeps the job queued, with the returned ``Hold`` as its
reason, when the answer is no. Nothing here fails a job.
"""

import logging
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from sqlmodel import Session

from ... import config
from ...context import get_engine, get_paths
from ...models import DownloadDestination
from ..library_usage import library_usage

logger = logging.getLogger(__name__)

GB = 1024**3

#: How long a measured library size is reused (it costs two SUM queries and a
#: stat of every thumbnail). Finished imports and deletions invalidate it sooner.
USAGE_CACHE_SECONDS = 5.0

#: After a write failed with "no space left on device", no job starts for this
#: long even if the volume reports room (quotas and overlay filesystems do that).
DISK_FULL_COOLDOWN_SECONDS = 300.0

HOLD_LIBRARY_FULL = "library_full"
HOLD_WOULD_EXCEED = "would_exceed"
HOLD_LOW_DISK = "low_disk"
HOLD_DISK_FULL = "disk_full"


@dataclass(frozen=True)
class Hold:
    """Why a job is waiting: a stable ``code`` and the sentence the UI shows."""

    code: str
    reason: str


def format_gb(size_bytes: float) -> str:
    """``55`` or ``2.5``: whole numbers without a decimal point."""
    return f"{size_bytes / GB:.1f}".removesuffix(".0")


class SpaceGate:
    """Decides whether a download may start, from settings and the free space."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._usage: tuple[float, int] | None = None
        self._disk_full_at: float | None = None

    def invalidate(self) -> None:
        """Forget the measured library size (a video was added or removed)."""
        with self._lock:
            self._usage = None

    def note_disk_full(self) -> None:
        with self._lock:
            self._disk_full_at = self._clock()

    def clear_disk_full(self) -> None:
        with self._lock:
            self._disk_full_at = None

    def library_bytes(self) -> int:
        now = self._clock()
        with self._lock:
            if self._usage is not None and now - self._usage[0] < USAGE_CACHE_SECONDS:
                return self._usage[1]
        with Session(get_engine()) as session:
            total = library_usage(session).total_bytes
        with self._lock:
            self._usage = (now, total)
        return total

    def check(self, destination: str, estimate: int | None = None) -> Hold | None:
        """None when a job to ``destination`` may start; otherwise why it must wait.

        ``estimate`` is the job's expected size when it is known.
        """
        floor = int(config.MIN_FREE_GB * GB)
        if floor > 0:
            free = self._free_bytes()
            if free is not None and free < floor:
                return Hold(
                    HOLD_LOW_DISK,
                    f"Paused: less than {format_gb(floor)} GB free on disk",
                )
        if self._disk_full_recently():
            return Hold(HOLD_DISK_FULL, "Paused: the disk ran out of space")
        if destination == DownloadDestination.device.value:
            return None
        return self._check_library_limit(estimate)

    def limit_bytes(self) -> int | None:
        """The library size limit in bytes, or None when there is none."""
        from .. import app_settings

        try:
            cap = app_settings.load().get("max_library_bytes")
        except app_settings.SettingsError:
            logger.warning(
                "settings unreadable; not applying the size limit", exc_info=True
            )
            return None
        return int(cap) if cap else None

    def _check_library_limit(self, estimate: int | None) -> Hold | None:
        cap = self.limit_bytes()
        if cap is None:
            return None
        used = self.library_bytes()
        limit = format_gb(cap)
        if used >= cap:
            return Hold(
                HOLD_LIBRARY_FULL, f"Paused: library is at its {limit} GB limit"
            )
        if estimate and used + estimate > cap:
            return Hold(
                HOLD_WOULD_EXCEED,
                f"Paused: this video would not fit in the {limit} GB library limit",
            )
        return None

    def _free_bytes(self) -> int | None:
        try:
            return shutil.disk_usage(get_paths().downloads).free
        except OSError:
            logger.debug("free disk space unavailable", exc_info=True)
            return None

    def _disk_full_recently(self) -> bool:
        with self._lock:
            at = self._disk_full_at
            if at is None:
                return False
            if self._clock() - at < DISK_FULL_COOLDOWN_SECONDS:
                return True
            self._disk_full_at = None
            return False

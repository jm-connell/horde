"""The live feature's per-app state (``AppContext.live``)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from ...config import LIVE_DVR_WINDOW_SEC
from .directory import LiveDirectory
from .sessions import LiveSessionManager

if TYPE_CHECKING:
    from ..workers import BackgroundWorker


@dataclass
class LiveRuntime:
    directory: LiveDirectory = field(default_factory=LiveDirectory)
    sessions: LiveSessionManager = field(
        default_factory=lambda: LiveSessionManager(dvr_window_sec=LIVE_DVR_WINDOW_SEC)
    )
    #: The live-check worker once started (None in tests and the browser suite).
    poller: BackgroundWorker | None = None

    def wake_poller(self) -> None:
        """Check newly followed channels now instead of at the next pass."""
        if self.poller is not None:
            self.poller.wake()

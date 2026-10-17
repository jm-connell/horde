"""Mutable state the AI worker shares with the rest of the app.

One instance lives on the ``AppContext`` (``ctx.ai``), so a test or a second app
instance starts with a fresh wake event and no stale "blocked" reason.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field


@dataclass
class AiRuntimeState:
    #: Set to nudge the AI worker out of its idle wait (a job was queued).
    wake: threading.Event = field(default_factory=threading.Event)
    #: Why queued work is not running right now (shown on /api/health), or None.
    blocked_reason: str | None = None

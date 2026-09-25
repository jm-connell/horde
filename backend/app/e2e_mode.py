"""Gate for the Playwright browser suite.

Set ``HORDE_E2E=1`` only from ``e2e/serve.py``. Production and pytest leave it unset.
"""

from __future__ import annotations

import os


def enabled() -> bool:
    return os.environ.get("HORDE_E2E", "").strip().lower() in {"1", "true", "yes"}

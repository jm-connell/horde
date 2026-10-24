"""Ask a ``LoginLimiter`` questions the way the app does: through ``begin()``.

The limiter has one way in, so a test cannot count a failure or read a wait
without reserving a try. These helpers do that in one line each.
"""

from __future__ import annotations

from typing import Any

from app.services.auth.limiter import LoginLimiter, Throttled


def retry_after(limiter: LoginLimiter, address: str, name: str, **kwargs: Any) -> int:
    """Seconds a try from ``address`` for ``name`` must wait (0: it would be judged)."""
    try:
        limiter.begin(address, name, **kwargs).release()
    except Throttled as exc:
        return exc.wait
    return 0


def record_failure(
    limiter: LoginLimiter, address: str, name: str, **kwargs: Any
) -> None:
    """A wrong guess (a wrong code too when ``code_name`` is given)."""
    limiter.begin(address, name, **kwargs).failure(
        code_step=kwargs.get("code_name") is not None
    )


def record_success(
    limiter: LoginLimiter, address: str, name: str, **kwargs: Any
) -> None:
    """A right guess (a right code, clearing the code counter, when ``code_name`` is given)."""
    limiter.begin(address, name, **kwargs).success(
        code_step=kwargs.get("code_name") is not None
    )

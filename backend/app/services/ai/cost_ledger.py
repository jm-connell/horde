"""Persist OpenRouter usage costs for Settings totals and per-response tags."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.exc import OperationalError
from sqlmodel import Session, col, select

from ...database import engine
from ...models import OpenRouterUsage, as_utc, utcnow
from ...services import app_settings

logger = logging.getLogger(__name__)


class OpenRouterBudgetExceeded(RuntimeError):
    """Raised when a hard weekly OpenRouter spend limit is exceeded."""


def _is_sqlite_lock_error(exc: BaseException) -> bool:
    cur: BaseException | None = exc
    for _ in range(6):
        if cur is None:
            break
        msg = str(cur).lower()
        if "database is locked" in msg or "database is busy" in msg:
            return True
        cur = cur.__cause__ or cur.__context__
    return False


def record_cost(
    *,
    cost: Optional[float],
    kind: str,
    model: Optional[str] = None,
    video_id: Optional[int] = None,
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
) -> Optional[float]:
    """Store a usage row when cost is a finite non-negative number. Returns cost.

    Ledger failures are logged and swallowed so a locked SQLite file cannot
    fail the OpenRouter call that already succeeded.
    """
    if cost is None:
        return None
    try:
        value = float(cost)
    except (TypeError, ValueError):
        return None
    if value < 0 or value != value:  # NaN
        return None
    kind_clean = (kind or "other").strip()[:40] or "other"
    persisted = False
    try:
        with Session(engine) as session:
            session.add(
                OpenRouterUsage(
                    kind=kind_clean,
                    cost=value,
                    model=(model or "").strip()[:120] or None,
                    video_id=video_id,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    created_at=utcnow(),
                )
            )
            session.commit()
        persisted = True
    except OperationalError as exc:
        if _is_sqlite_lock_error(exc):
            logger.warning("OpenRouter usage not recorded (database locked)")
        else:
            logger.warning("OpenRouter usage not recorded: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("OpenRouter usage not recorded: %s", exc)
    if persisted:
        try:
            _maybe_pause_on_hard_budget()
        except Exception:  # noqa: BLE001
            logger.warning("OpenRouter budget pause check failed", exc_info=True)
    return value


def cost_from_usage_payload(usage: Any) -> Optional[float]:
    if not isinstance(usage, dict):
        return None
    raw = usage.get("cost")
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def tokens_from_usage_payload(usage: Any) -> tuple[Optional[int], Optional[int]]:
    if not isinstance(usage, dict):
        return None, None
    prompt = usage.get("prompt_tokens")
    completion = usage.get("completion_tokens")
    try:
        p = int(prompt) if prompt is not None else None
    except (TypeError, ValueError):
        p = None
    try:
        c = int(completion) if completion is not None else None
    except (TypeError, ValueError):
        c = None
    return p, c


def record_from_response(
    data: Any,
    *,
    kind: str,
    model: Optional[str] = None,
    video_id: Optional[int] = None,
) -> Optional[float]:
    if not isinstance(data, dict):
        return None
    usage = data.get("usage")
    cost = cost_from_usage_payload(usage)
    prompt_tokens, completion_tokens = tokens_from_usage_payload(usage)
    return record_cost(
        cost=cost,
        kind=kind,
        model=model,
        video_id=video_id,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


def sum_since(cutoff: datetime) -> float:
    """Sum OpenRouter costs with created_at >= cutoff."""
    with Session(engine) as session:
        rows = session.exec(
            select(OpenRouterUsage).where(col(OpenRouterUsage.created_at) >= cutoff)
        ).all()
        total = sum(float(row.cost or 0.0) for row in rows)
    return round(total, 8)


def totals() -> dict[str, float]:
    """Sum costs for rolling windows (UTC-ish via stored timestamps)."""
    now = utcnow()
    windows = {
        "h24": now - timedelta(hours=24),
        "d7": now - timedelta(days=7),
        "d30": now - timedelta(days=30),
        "y1": now - timedelta(days=365),
        "all": None,
    }
    out: dict[str, float] = {k: 0.0 for k in windows}
    with Session(engine) as session:
        rows = session.exec(select(OpenRouterUsage)).all()
        for row in rows:
            c = float(row.cost or 0.0)
            created = as_utc(row.created_at)
            out["all"] += c
            if created is None:
                continue
            for key, cutoff in windows.items():
                if key == "all" or cutoff is None:
                    continue
                if created >= cutoff:
                    out[key] += c
    return {k: round(v, 8) for k, v in out.items()}


def budget_status(
    *,
    window_totals: Optional[dict[str, float]] = None,
) -> dict[str, Any]:
    """Return weekly budget config vs rolling 7-day spend."""
    ai = app_settings.ai_settings()
    budget = app_settings.clamp_weekly_budget_usd(
        ai.get("openrouter_weekly_budget_usd")
    )
    hard = bool(ai.get("openrouter_budget_hard_limit"))
    if window_totals is None:
        d7 = sum_since(utcnow() - timedelta(days=7))
    else:
        d7 = float(window_totals.get("d7") or 0.0)
    over = budget is not None and d7 >= budget
    return {
        "weekly_budget_usd": budget,
        "hard_limit": hard,
        "d7": d7,
        "over_budget": over,
        "blocked": bool(over and hard and budget is not None),
    }


def assert_budget_allows() -> None:
    """Raise OpenRouterBudgetExceeded when hard weekly limit is hit."""
    status = budget_status()
    if not status["blocked"]:
        return
    budget = float(status["weekly_budget_usd"] or 0.0)
    spent = float(status["d7"] or 0.0)
    raise OpenRouterBudgetExceeded(
        f"OpenRouter weekly budget of ${budget:g} exceeded "
        f"(${spent:.4f} in the last 7 days). "
        "Raise the limit in Settings → AI, or turn off 'Stop when exceeded'."
    )


def _maybe_pause_on_hard_budget() -> None:
    """Auto-pause the AI queue once a hard weekly budget is crossed."""
    status = budget_status()
    if not status["blocked"]:
        return
    ai = app_settings.ai_settings()
    if ai.get("paused"):
        return
    app_settings.save({"ai": {"paused": True}})
    try:
        from . import worker as ai_worker

        ai_worker.wake_worker()
    except Exception:  # noqa: BLE001
        pass

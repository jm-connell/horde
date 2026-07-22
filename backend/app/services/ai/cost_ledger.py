"""Persist OpenRouter usage costs for Settings totals and per-response tags."""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Optional

from sqlmodel import Session, select

from ...database import engine
from ...models import OpenRouterUsage, utcnow


def record_cost(
    *,
    cost: Optional[float],
    kind: str,
    model: Optional[str] = None,
    video_id: Optional[int] = None,
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
) -> Optional[float]:
    """Store a usage row when cost is a finite non-negative number. Returns cost."""
    if cost is None:
        return None
    try:
        value = float(cost)
    except (TypeError, ValueError):
        return None
    if value < 0 or value != value:  # NaN
        return None
    kind_clean = (kind or "other").strip()[:40] or "other"
    with Session(engine) as session:
        row = OpenRouterUsage(
            kind=kind_clean,
            cost=value,
            model=(model or "").strip()[:120] or None,
            video_id=video_id,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            created_at=utcnow(),
        )
        session.add(row)
        session.commit()
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
            created = row.created_at
            out["all"] += c
            if created is None:
                continue
            for key, cutoff in windows.items():
                if key == "all" or cutoff is None:
                    continue
                if created >= cutoff:
                    out[key] += c
    return {k: round(v, 8) for k, v in out.items()}

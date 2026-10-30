"""The signed-in user's watch statistics (``services/watch_stats.py``)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session

from ..auth import current_user
from ..context import get_session
from ..errors import CodedHTTPException
from ..schemas import HistoryStats, HistoryStatsRange
from ..services import watch_stats
from ..services.auth.accounts import AuthUser

router = APIRouter(prefix="/api/history", tags=["history"])


@router.get("/stats", response_model=HistoryStats)
def history_stats(
    range_: HistoryStatsRange = Query("30d", alias="range"),
    tz: str | None = Query(
        None,
        max_length=64,
        description=(
            "IANA time zone the days and hours are counted in (the browser's). "
            "Omitted: the server's."
        ),
    ),
    include_youtube: bool = Query(
        False,
        description="Count the imported YouTube history too (views, never time).",
    ),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
) -> HistoryStats:
    """Watch time, streaks, top channels and tags of the signed-in user only."""
    try:
        tz_name, zone = watch_stats.resolve_tz(tz)
    except watch_stats.UnknownTimeZone:
        raise CodedHTTPException(
            422, f"Unknown time zone: {tz}", "invalid_timezone"
        ) from None
    return watch_stats.compute(
        session, user.id, range_, tz_name, zone, include_youtube=include_youtube
    )

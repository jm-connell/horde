"""The signed-in user's history: watch statistics (``services/watch_stats.py``)
and the one timeline of what they watched (``services/watch_history.py``)."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, col, select

from ..auth import current_user
from ..context import AppContext, get_ctx, get_session
from ..errors import CodedHTTPException
from ..models import Video
from ..response_schemas import (
    ContinueYoutubeRead,
    HistoryRemovedRead,
    HistoryTasteRead,
    HistoryWatchListRead,
    HistoryWatchRead,
)
from ..schemas import (
    ChannelFeedEntry,
    HistoryKeysWrite,
    HistoryStats,
    HistoryStatsRange,
    HistoryTasteWrite,
)
from ..services import app_settings, watch_history, watch_stats
from ..services.auth.accounts import AuthUser
from ..services.library import CONTINUE_WATCHING_DAYS
from ..services.pagination import InvalidCursor, offset_cursor, parse_cursor
from ..services.url_clean import youtube_thumbnail_url
from .video_serialize import to_read_many

router = APIRouter(prefix="/api/history", tags=["history"])

_SORT = "last_watched_at"


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


def _stream(entry: watch_history.Entry) -> ChannelFeedEntry:
    yt_id = entry.yt_id or ""
    return ChannelFeedEntry(
        id=yt_id,
        url=f"https://www.youtube.com/watch?v={yt_id}",
        title=entry.title,
        duration=entry.duration,
        thumbnail_url=youtube_thumbnail_url(yt_id),
        channel=entry.channel,
        channel_url=entry.channel_url,
    )


@router.get("/watches", response_model=HistoryWatchListRead)
def list_watches(
    limit: int = Query(48, ge=1, le=200),
    cursor: str | None = None,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Everything the user watched, newest first, one entry per video: library
    videos, videos played without downloading and the imported YouTube history."""
    try:
        page = parse_cursor(
            cursor, limit=limit, sort=_SORT, order="desc", kind="offset"
        )
    except InvalidCursor as exc:
        raise CodedHTTPException(400, str(exc), "invalid_cursor") from exc
    entries, more = watch_history.page(
        session, user.id, offset=page.offset, limit=limit
    )
    ids = [e.video_id for e in entries if e.video_id is not None]
    videos = session.exec(select(Video).where(col(Video.id).in_(ids))).all()
    reads = {r.id: r for r in to_read_many(videos, session, viewer=user, compact=True)}
    items = []
    for e in entries:
        video = reads.get(e.video_id) if e.video_id is not None else None
        items.append(
            HistoryWatchRead(
                key=e.key,
                watched_at=e.watched_at.isoformat(),
                sources=e.sources,  # type: ignore[arg-type]  # values come from watch_history's three literals
                video=video,
                stream=None if video is not None or not e.yt_id else _stream(e),
                fraction=e.fraction,
                youtube_views=e.youtube_views,
                excluded=e.excluded,
            )
        )
    return HistoryWatchListRead(
        items=items,
        next_cursor=offset_cursor(sort=_SORT, order="desc", offset=page.offset + limit)
        if more
        else None,
        total=watch_history.count(session, user.id) if not cursor else None,
    )


@router.post("/watches/remove", response_model=HistoryRemovedRead)
def remove_watches(
    payload: HistoryKeysWrite,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Forget these videos from your history: they count as unwatched again.

    Removes every record of each one (library progress, the streamed watch and
    imported YouTube views); your watch time totals stay.
    """
    removed = watch_history.remove(session, user.id, payload.keys)
    ctx.discovery.forget_feeds(user.id)
    return HistoryRemovedRead(
        videos=removed.videos,
        library=removed.library,
        streams=removed.streams,
        youtube_views=removed.youtube_views,
    )


@router.post("/watches/taste", response_model=HistoryTasteRead)
def set_watch_taste(
    payload: HistoryTasteWrite,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Stop these watches shaping your recommendations (``use`` false), or let
    them again. They stay in your history and still count as watched."""
    watch_history.set_taste(session, user.id, payload.keys, use=payload.use)
    ctx.discovery.forget_feeds(user.id)
    return HistoryTasteRead(keys=payload.keys, excluded=not payload.use)


@router.get("/continue-youtube", response_model=ContinueYoutubeRead)
def continue_youtube(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """The newest videos watched on YouTube (imported history) within the
    Continue watching window, at most five, not in the library."""
    days = int(
        app_settings.load().get("continue_watching_days", CONTINUE_WATCHING_DAYS)
    )
    views = watch_history.recent_youtube(
        session, user.id, days=days, now=datetime.now(UTC)
    )
    return ContinueYoutubeRead(
        items=[
            ChannelFeedEntry(
                id=v.yt_id,
                url=f"https://www.youtube.com/watch?v={v.yt_id}",
                title=v.title,
                thumbnail_url=youtube_thumbnail_url(v.yt_id),
                channel=v.channel,
                channel_url=v.channel_url,
            )
            for v in views
            if user.allowed is None or user.allowed.allows(v.channel_url, v.channel)
        ]
    )

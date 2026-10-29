"""Recommended+: the feed, channel suggestions, feedback, and stream history."""

from __future__ import annotations

import time
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlmodel import Session, col, select

from ..auth import current_user
from ..context import AppContext, get_ctx, get_session
from ..errors import CodedHTTPException
from ..models import DiscoveryHit, DiscoveryState, RecFeedback, Video, as_utc
from ..response_schemas import (
    DiscoverFeedRead,
    DiscoverItemRead,
    DiscoverReasonRead,
    DiscoverRefreshRead,
    DiscoverStatusRead,
    RecFeedbackListRead,
    RecFeedbackRead,
    StreamWatchRead,
    SuggestedChannelRead,
    SuggestedChannelsRead,
)
from ..schemas import ChannelFeedEntry, RecFeedbackWrite, StreamWatchWrite
from ..services.auth.accounts import AuthUser
from ..services.discovery import feedback, gather, history, suggest
from ..services.discovery.candidates import Candidate
from ..services.discovery.feed import ranked_feed
from ..services.pagination import (
    SEED_RANGE,
    InvalidCursor,
    offset_cursor,
    parse_cursor,
)
from ..services.url_clean import youtube_thumbnail_url
from .video_serialize import to_read_many

router = APIRouter(prefix="/api/discover", tags=["discover"])

_SORT = "discover"


def _today_seed() -> int:
    """The default ordering seed: the same all day, so a plain reload is stable."""
    return date.today().toordinal() % SEED_RANGE


def _entry(c: Candidate) -> ChannelFeedEntry:
    yt_id = c.yt_id or ""
    return ChannelFeedEntry(
        id=yt_id,
        url=c.url,
        title=c.title or None,
        duration=c.duration,
        thumbnail_url=c.thumbnail_url or youtube_thumbnail_url(yt_id),
        view_count=c.view_count,
        published_at=c.published_raw,
        published_label=c.published_label,
        channel=c.channel or None,
        channel_url=c.source_channel_url,
        live_status=c.live_status,
    )


def _status(
    session: Session, ctx: AppContext, user_id: int, *, cold: bool
) -> DiscoverStatusRead:
    state = session.get(DiscoveryState, user_id)
    found = session.exec(
        select(func.count(col(DiscoveryHit.id))).where(DiscoveryHit.user_id == user_id)
    ).one()
    enabled = gather.enabled()
    last = as_utc(state.last_run_at) if state else None
    requested = as_utc(state.requested_at) if state else None
    pending = requested is not None and (last is None or requested > last)
    backing_off = time.monotonic() < ctx.discovery.paused_until
    working = ctx.discovery.worker is not None and ctx.discovery.worker.is_alive
    return DiscoverStatusRead(
        enabled=enabled,
        gathering=enabled
        and (
            ctx.discovery.gathering_for == user_id
            or (pending and working and not backing_off)
        ),
        last_run_at=last.isoformat() if last else None,
        found=int(found or 0),
        cold=cold,
        backing_off=backing_off,
    )


@router.get("/feed", response_model=DiscoverFeedRead)
def discover_feed(
    limit: int = Query(24, ge=1, le=60),
    cursor: str | None = None,
    seed: int | None = Query(
        None,
        ge=0,
        lt=SEED_RANGE,
        description="Ordering seed; a new one reshuffles the less certain picks.",
    ),
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """One page of the Recommended+ feed.

    The first page also tells the gatherer this user is active (it starts at once
    the first time). Each page counts as shown for its videos.
    """
    try:
        page = parse_cursor(
            cursor, limit=limit, sort=_SORT, order="desc", kind="offset"
        )
    except InvalidCursor as exc:
        raise CodedHTTPException(400, str(exc), "invalid_cursor") from exc
    use_seed = page.seed if page.seed is not None else seed
    if use_seed is None:
        use_seed = _today_seed()
    if not cursor:
        gather.note_viewed(session, ctx.discovery, user.id)
    feed = ranked_feed(session, ctx.discovery, user.id, use_seed, fresh=not cursor)
    window = feed.items[page.offset : page.offset + page.fetch]
    more = len(window) > limit
    window = window[:limit]

    videos = {
        v.id: v
        for v in session.exec(
            select(Video).where(
                col(Video.id).in_(
                    [i.candidate.video_id for i in window if i.candidate.video_id]
                )
            )
        ).all()
    }
    reads = {
        r.id: r
        for r in to_read_many(videos.values(), session, viewer=user, compact=True)
    }
    items: list[DiscoverItemRead] = []
    for item in window:
        c = item.candidate
        reason = DiscoverReasonRead(
            kind=item.reason.kind, text=item.reason.text, detail=item.reason.detail
        )
        if c.video_id is not None:
            read = reads.get(c.video_id)
            if read is None:
                continue  # Deleted since the feed was ranked.
            items.append(
                DiscoverItemRead(key=c.key, video=read, reason=reason, source="library")
            )
        else:
            items.append(
                DiscoverItemRead(
                    key=c.key,
                    stream=_entry(c),
                    reason=reason,
                    source="followed" if item.followed else "unfollowed",
                )
            )
    feedback.record_shown(session, user.id, (i.key for i in items))
    return DiscoverFeedRead(
        items=items,
        next_cursor=offset_cursor(
            sort=_SORT, order="desc", offset=page.offset + limit, seed=use_seed
        )
        if more
        else None,
        status=_status(session, ctx, user.id, cold=feed.cold),
    )


@router.get("/status", response_model=DiscoverStatusRead)
def discover_status(
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Whether the gatherer is working for this user (the page polls this)."""
    cold = len(history.watches(session, user.id, limit=3)) < 3
    return _status(session, ctx, user.id, cold=cold)


@router.get("/channels", response_model=SuggestedChannelsRead)
def discover_channels(
    seed: int | None = Query(None, ge=0, lt=SEED_RANGE),
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Channels new to the user that their Recommended+ feed leans on most."""
    # Loaded beside the feed's first page: share its ranking when it exists.
    feed = ranked_feed(
        session,
        ctx.discovery,
        user.id,
        _today_seed() if seed is None else seed,
        fresh=False,
    )
    picks = suggest.suggestions(feed, feedback.exclusions(session, user.id))
    return SuggestedChannelsRead(
        items=[
            SuggestedChannelRead(
                name=s.name,
                url=s.url,
                reason=s.reason,
                videos=[_entry(c) for c in s.videos if c.video_id is None],
                indexed=s.indexed,
            )
            for s in picks
        ]
    )


@router.post("/refresh", response_model=DiscoverRefreshRead)
def discover_refresh(
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Look for new videos on YouTube soon (at most every 20 minutes per user)."""
    if not gather.enabled():
        return DiscoverRefreshRead(
            queued=False, detail="Looking on YouTube is turned off in Settings"
        )
    if gather.request_refresh(session, ctx.discovery, user.id):
        return DiscoverRefreshRead(queued=True, detail="Looking for new videos")
    return DiscoverRefreshRead(
        queued=False, detail="Looked for new videos a few minutes ago"
    )


def _feedback_read(row: RecFeedback) -> RecFeedbackRead:
    assert row.id is not None  # noqa: S101 - read back after commit
    return RecFeedbackRead(
        id=row.id,
        kind=row.kind,
        key=row.key,
        label=row.label,
        created_at=as_utc(row.created_at).isoformat(),
    )


@router.get("/feedback", response_model=RecFeedbackListRead)
def list_feedback(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """What the user asked recommendations to leave out, newest first."""
    return RecFeedbackListRead(
        items=[_feedback_read(r) for r in feedback.listed(session, user.id)]
    )


@router.post("/feedback", response_model=RecFeedbackRead)
def add_feedback(
    payload: RecFeedbackWrite,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Not interested in a video, don't recommend a channel, or hide a suggestion.

    For the channel kinds ``key`` is the channel URL (may be empty) and ``label``
    its name; they are stored in normalized form.
    """
    key = payload.key.strip()
    if payload.kind != "video":
        key = feedback.channel_key(key, payload.label)
    if not key:
        raise CodedHTTPException(400, "Nothing to leave out", "missing_key")
    row = feedback.add(
        session, user.id, kind=payload.kind, key=key, label=payload.label
    )
    ctx.discovery.forget_feeds(user.id)
    return _feedback_read(row)


@router.delete("/feedback/{feedback_id}", response_model=RecFeedbackRead)
def remove_feedback(
    feedback_id: int,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Undo one piece of feedback."""
    row = session.get(RecFeedback, feedback_id)
    if row is None or row.user_id != user.id:
        raise CodedHTTPException(404, "Not found", "not_found")
    read = _feedback_read(row)
    feedback.remove(session, user.id, feedback_id)
    ctx.discovery.forget_feeds(user.id)
    return read


@router.post("/history", response_model=StreamWatchRead)
def record_stream_watch(
    payload: StreamWatchWrite,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Note how far the user got in a video they streamed without downloading."""
    try:
        row = history.record_stream_watch(
            session,
            user.id,
            url=payload.url,
            title=payload.title,
            channel=payload.channel,
            channel_url=payload.channel_url,
            position_sec=payload.position_sec,
            duration_sec=payload.duration_sec,
            finished=payload.finished,
        )
    except history.NotAYoutubeVideo as exc:
        raise CodedHTTPException(
            400, "Not a YouTube video URL", "not_youtube_video"
        ) from exc
    return StreamWatchRead(
        yt_id=row.yt_id,
        watched_sec=row.watched_sec,
        finished=row.finished_at is not None,
    )

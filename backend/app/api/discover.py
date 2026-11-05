"""Recommended+: the feed, channel suggestions, feedback, and stream history."""

from __future__ import annotations

import time
from datetime import date, datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlmodel import Session, col, select

from ..auth import current_user
from ..context import AppContext, get_ctx, get_session
from ..errors import CodedHTTPException
from ..models import (
    DiscoveryHit,
    DiscoveryState,
    RecAlgorithm,
    RecFeedback,
    RecTopic,
    Video,
    as_utc,
    require_id,
    utcnow,
)
from ..response_schemas import (
    DiscoverBlockedRead,
    DiscoverFeedRead,
    DiscoverItemRead,
    DiscoverMixRead,
    DiscoverReasonRead,
    DiscoverRefreshRead,
    DiscoverScorePartRead,
    DiscoverStatusRead,
    DiscoverWhyRead,
    RecAlgorithmListRead,
    RecAlgorithmRead,
    RecFeedbackListRead,
    RecFeedbackRead,
    RecTopicListRead,
    RecTopicRead,
    RecTuningPresetRead,
    RecTuningRead,
    StreamWatchRead,
    SuggestedChannelRead,
    SuggestedChannelsRead,
)
from ..schemas import (
    ChannelFeedEntry,
    RecAlgorithmUpdate,
    RecAlgorithmWrite,
    RecFeedbackWrite,
    RecTopicUpdate,
    RecTopicWrite,
    RecTuningWrite,
    StreamWatchWrite,
)
from ..services.auth.accounts import AuthUser
from ..services.discovery import (
    algorithms,
    feedback,
    gather,
    history,
    suggest,
    topics,
    tuning,
)
from ..services.discovery.candidates import Candidate
from ..services.discovery.feed import FeedItem, ranked_feed
from ..services.live import picks as live_picks
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


def _why(item: FeedItem) -> DiscoverWhyRead:
    return DiscoverWhyRead(
        bucket=item.bucket,
        score=round(item.score, 4),
        parts=[
            DiscoverScorePartRead(label=label, value=round(value, 4))
            for label, value in item.parts
        ],
        found_by=item.found_by,
        eligible=item.eligible,
    )


def _live_item(pick: live_picks.LivePick) -> DiscoverItemRead:
    channel = pick.channel_name or "this channel"
    return DiscoverItemRead(
        key=pick.broadcast.video_id,
        stream=live_picks.feed_entry(pick),
        reason=DiscoverReasonRead(
            kind="live",
            text="Live now",
            detail=f"Live now on {channel}, which you watched lately"
            if pick.recent
            else f"Live now on {channel}, which you follow",
        ),
        source="channels",
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
    prefetch: bool = Query(
        False,
        description="Loaded ahead of time, not shown yet: its videos do not "
        "count as shown.",
    ),
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """One page of the Recommended+ feed.

    The first page also tells the gatherer this user is active (it starts at once
    the first time). It also carries followed channels' live broadcasts, the
    ones from channels watched lately first. Each page counts as shown for its
    videos, unless it is a ``prefetch`` (the home page loading it before the
    user opens the tab; opening it asks again and counts then).
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
                DiscoverItemRead(
                    key=c.key,
                    video=read,
                    reason=reason,
                    source="library",
                    why=_why(item),
                )
            )
        else:
            items.append(
                DiscoverItemRead(
                    key=c.key,
                    stream=_entry(c),
                    reason=reason,
                    source="channels"
                    if item.followed or c.pool in ("catalog", "history")
                    else "new",
                    why=_why(item),
                )
            )
    if not cursor:
        items = live_picks.merge(
            items,
            live_picks.live_picks(session, ctx.live.directory, user.id),
            _live_item,
            lambda i: i.key,
        )
    if not prefetch:
        feedback.record_shown(session, user.id, (i.key for i in items))
    return DiscoverFeedRead(
        items=items,
        next_cursor=offset_cursor(
            sort=_SORT, order="desc", offset=page.offset + limit, seed=use_seed
        )
        if more
        else None,
        status=_status(session, ctx, user.id, cold=feed.cold),
        mix=[
            DiscoverMixRead(bucket=m.bucket, target=m.target, actual=m.actual)
            for m in feed.mix
        ]
        if not cursor
        else [],
        blocked=[
            DiscoverBlockedRead(topic_id=tid, count=n)
            for tid, n in sorted(feed.blocked.items())
        ]
        if not cursor
        else [],
    )


def _algorithm_read(a: algorithms.Listed) -> RecAlgorithmRead:
    return RecAlgorithmRead(
        id=require_id(a.row),
        name=a.row.name,
        shared=a.row.shared,
        owner=a.owner,
        mine=a.mine,
        values=a.values,
        updated_at=as_utc(a.row.updated_at).isoformat(),
    )


def _listed_one(
    session: Session, user_id: int, algo_id: int | None
) -> RecAlgorithmRead | None:
    if algo_id is None:
        return None
    for a in algorithms.listed(session, user_id):
        if a.row.id == algo_id:
            return _algorithm_read(a)
    return None


def _tuning_read(session: Session, user_id: int) -> RecTuningRead:
    selection, values = algorithms.current(session, user_id)
    based_on = _listed_one(session, user_id, selection.based_on)
    return RecTuningRead(
        active=selection.active,
        values=values,
        algorithm=_listed_one(session, user_id, tuning.algorithm_id(selection.active)),
        based_on=based_on if based_on is not None and based_on.mine else None,
        custom=selection.custom,
        presets=[
            RecTuningPresetRead(
                id=p.id, name=p.name, description=p.description, values=p.tuning
            )
            for p in tuning.PRESETS
        ],
        defaults=tuning.DEFAULTS,
    )


@router.get("/tuning", response_model=RecTuningRead)
def get_tuning(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """How this user ranks Recommended+: a preset, a saved algorithm or their
    own values."""
    return _tuning_read(session, user.id)


@router.put("/tuning", response_model=RecTuningRead)
def put_tuning(
    payload: RecTuningWrite,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Pick a preset, a saved algorithm (``algo:<id>``, yours or shared), or
    rank with your own values (``active`` "custom").

    Your own values are kept when you pick something else, so you can switch
    back; moving a slider on a saved algorithm makes your own values from it.
    """
    current = tuning.load(session, user.id)
    custom = payload.custom if payload.custom is not None else current.custom
    selection = tuning.Selection(active=payload.active, custom=custom)
    algo_id = tuning.algorithm_id(payload.active)
    if payload.active == "custom":
        if custom is None:
            raise CodedHTTPException(
                400, "Custom settings need their values", "missing_values"
            )
        # Remember which of your algorithms these values came from.
        selection.based_on = tuning.algorithm_id(current.active) or (
            current.based_on if current.active == "custom" else None
        )
    elif algo_id is not None:
        row = algorithms.available(session, user.id, algo_id)
        if row is None:
            raise CodedHTTPException(404, "No such algorithm", "unknown_algorithm")
        selection.snapshot = algorithms.values_of(row)
    elif payload.active not in tuning.PRESET_IDS:
        raise CodedHTTPException(400, "No such preset", "unknown_preset")
    tuning.save(session, user.id, selection)
    ctx.discovery.forget_feeds(user.id)
    return _tuning_read(session, user.id)


@router.get("/algorithms", response_model=RecAlgorithmListRead)
def list_algorithms(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Your saved algorithms, then the ones other accounts share."""
    return RecAlgorithmListRead(
        items=[_algorithm_read(a) for a in algorithms.listed(session, user.id)]
    )


@router.post("/algorithms", response_model=RecAlgorithmRead)
def save_algorithm(
    payload: RecAlgorithmWrite,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Save values under a name (shared with every account if ``shared``) and
    rank with it."""
    try:
        row = algorithms.create(
            session,
            user.id,
            name=payload.name,
            shared=payload.shared,
            values=payload.values,
        )
    except algorithms.NameTaken as exc:
        raise CodedHTTPException(409, str(exc), "name_taken") from exc
    except algorithms.TooMany as exc:
        raise CodedHTTPException(409, str(exc), "too_many_algorithms") from exc
    current = tuning.load(session, user.id)
    tuning.save(
        session,
        user.id,
        tuning.Selection(
            active=f"{tuning.ALGORITHM_PREFIX}{require_id(row)}",
            custom=current.custom,
            snapshot=payload.values,
        ),
    )
    ctx.discovery.forget_feeds(user.id)
    read = _listed_one(session, user.id, row.id)
    assert read is not None  # noqa: S101 - just created, and it is the user's own
    return read


def _own_algorithm(session: Session, user_id: int, algo_id: int) -> RecAlgorithm:
    row = session.get(RecAlgorithm, algo_id)
    if row is None or row.owner_id != user_id:
        raise CodedHTTPException(404, "Not found", "not_found")
    return row


@router.patch("/algorithms/{algo_id}", response_model=RecAlgorithmRead)
def update_algorithm(
    algo_id: int,
    payload: RecAlgorithmUpdate,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Rename, share or stop sharing, or overwrite one of your algorithms.

    New ``values`` also put you back on it. Stopping sharing leaves everyone
    else who used it on their own copy of its values.
    """
    row = _own_algorithm(session, user.id, algo_id)
    try:
        row = algorithms.update(
            session,
            row,
            name=payload.name,
            shared=payload.shared,
            values=payload.values,
        )
    except algorithms.NameTaken as exc:
        raise CodedHTTPException(409, str(exc), "name_taken") from exc
    if payload.values is not None:
        current = tuning.load(session, user.id)
        tuning.save(
            session,
            user.id,
            tuning.Selection(
                active=f"{tuning.ALGORITHM_PREFIX}{algo_id}",
                custom=current.custom,
                snapshot=payload.values,
            ),
        )
    ctx.discovery.forget_feeds(user.id)
    read = _listed_one(session, user.id, algo_id)
    assert read is not None  # noqa: S101 - the user's own, just saved
    return read


@router.delete("/algorithms/{algo_id}", response_model=RecAlgorithmRead)
def delete_algorithm(
    algo_id: int,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Delete one of your algorithms. Anyone ranking with it (you included)
    keeps its values as their own."""
    row = _own_algorithm(session, user.id, algo_id)
    read = _listed_one(session, user.id, algo_id)
    assert read is not None  # noqa: S101 - the user's own
    algorithms.delete(session, row)
    ctx.discovery.forget_feeds(user.id)
    return read


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
                typical_views=s.typical_views,
                typical_minutes=s.typical_minutes,
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


def _topic_read(row: RecTopic) -> RecTopicRead:
    return RecTopicRead(
        id=require_id(row),
        kind=row.kind,  # type: ignore[arg-type]  # stored from the validated write model
        text=row.text,
        match=row.match,  # type: ignore[arg-type]  # stored from the validated write model
        strength=row.strength,  # type: ignore[arg-type]  # stored from the validated write model
        expires_at=as_utc(row.expires_at).isoformat() if row.expires_at else None,
        active=topics.is_active(row, utcnow()),
        created_at=as_utc(row.created_at).isoformat(),
    )


def _topics_changed(
    session: Session, ctx: AppContext, user_id: int, row: RecTopic
) -> None:
    """Re-rank; an interest that is on is searched for soon."""
    ctx.discovery.forget_feeds(user_id)
    if row.kind == "interest" and topics.is_active(row, utcnow()) and gather.enabled():
        gather.request_refresh(session, ctx.discovery, user_id)


@router.get("/topics", response_model=RecTopicListRead)
def list_topics(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Your interests and blocked topics, interests first."""
    return RecTopicListRead(
        items=[_topic_read(r) for r in topics.listed(session, user.id)]
    )


@router.post("/topics", response_model=RecTopicRead)
def add_topic(
    payload: RecTopicWrite,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Add an interest (shown more, searched for on YouTube) or block a topic,
    for good or until ``expires_at``."""
    if payload.expires_at is not None and payload.expires_at <= utcnow():
        raise CodedHTTPException(400, "That time has passed", "expired")
    try:
        row = topics.create(
            session,
            user.id,
            kind=payload.kind,
            text=payload.text,
            match=payload.match,
            strength=payload.strength,
            expires_at=payload.expires_at,
        )
    except topics.TooMany as exc:
        raise CodedHTTPException(409, str(exc), "too_many_topics") from exc
    _topics_changed(session, ctx, user.id, row)
    return _topic_read(row)


@router.patch("/topics/{topic_id}", response_model=RecTopicRead)
def update_topic(
    topic_id: int,
    payload: RecTopicUpdate,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Change a topic; a new ``expires_at`` (or null, never) turns an expired one on."""
    row = session.get(RecTopic, topic_id)
    if row is None or row.user_id != user.id:
        raise CodedHTTPException(404, "Not found", "not_found")
    changes = payload.model_dump(exclude_unset=True)
    if changes.get("text") is None:
        changes.pop("text", None)
    for key in ("match", "strength"):
        if key in changes and changes[key] is None:
            changes.pop(key)
    expires = changes.get("expires_at")
    if isinstance(expires, datetime) and expires <= utcnow():
        raise CodedHTTPException(400, "That time has passed", "expired")
    try:
        row = topics.update(session, row, changes)
    except topics.TooMany as exc:
        session.rollback()
        raise CodedHTTPException(409, str(exc), "too_many_topics") from exc
    _topics_changed(session, ctx, user.id, row)
    return _topic_read(row)


@router.delete("/topics/{topic_id}", response_model=RecTopicRead)
def delete_topic(
    topic_id: int,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
    user: AuthUser = Depends(current_user),
):
    """Delete one of your topics."""
    row = session.get(RecTopic, topic_id)
    if row is None or row.user_id != user.id:
        raise CodedHTTPException(404, "Not found", "not_found")
    read = _topic_read(row)
    session.delete(row)
    session.commit()
    ctx.discovery.forget_feeds(user.id)
    return read

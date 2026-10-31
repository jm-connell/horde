"""Ask: channels whose captions are indexed, and keyword search over them."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlmodel import Session, col, select

from ..auth import StreamAuthGuard, current_user, require_permission
from ..context import get_session
from ..errors import CodedHTTPException
from ..models import KbChannel, KbVideo, Video, require_id
from ..openapi_responses import EVENT_STREAM, RAW
from ..schemas import (
    AskChannelCreate,
    AskChannelList,
    AskChannelPreview,
    AskChannelRead,
    AskChannelUpdate,
    AskChatRequest,
    AskSearchHit,
    AskSearchPage,
    AskThreadList,
    AskThreadMessage,
    AskThreadRead,
    AskThreadSummary,
)
from ..services.auth.accounts import AuthUser
from ..services.follows import normalize_channel_url
from ..services.knowledge import ask_chat, chunking, moments, threads
from ..services.knowledge import channels as kb_channels
from ..services.knowledge import search as kb_search
from ..services.pagination import InvalidCursor, offset_cursor, parse_cursor
from . import member_view

router = APIRouter(prefix="/api/ask", tags=["ask"])

_SORT = "relevance"


def _read(
    channel: KbChannel, counts: kb_channels.ChannelCounts, *, is_admin: bool
) -> AskChannelRead:
    error = channel.last_error
    if error and not is_admin:
        error = member_view.CATALOG_ERROR
    return AskChannelRead(
        id=require_id(channel),
        channel_url=channel.channel_url,
        channel_name=channel.channel_name,
        status=channel.status.value,
        include_streams=channel.include_streams,
        videos=counts.videos,
        fetched=counts.fetched,
        pending=counts.pending,
        no_captions=counts.no_captions,
        unavailable=counts.unavailable,
        passages=counts.passages,
        last_listed_at=channel.last_listed_at,
        last_error=error,
        created_at=channel.created_at,
    )


def _require_available(session: Session) -> None:
    if not kb_search.fts_available(session):
        raise CodedHTTPException(
            503, "This server's SQLite has no full-text search (FTS5)", "unavailable"
        )


def _one(session: Session, channel: KbChannel, user: AuthUser) -> AskChannelRead:
    counts = kb_channels.counts(session).get(
        channel.id or 0, kb_channels.ChannelCounts()
    )
    return _read(channel, counts, is_admin=user.is_admin)


@router.get("/channels", response_model=AskChannelList)
def list_channels(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Every Ask channel with its indexing progress."""
    counts = kb_channels.counts(session)
    items = [
        _read(
            c,
            counts.get(c.id or 0, kb_channels.ChannelCounts()),
            is_admin=user.is_admin,
        )
        for c in kb_channels.list_channels(session)
    ]
    return AskChannelList(items=items, available=kb_search.fts_available(session))


@router.get(
    "/channels/preview",
    response_model=AskChannelPreview,
    dependencies=[Depends(require_permission("manage_ask"))],
)
def preview_channel(
    url: str = Query(..., min_length=1, max_length=500),
    session: Session = Depends(get_session),
):
    """Name, upload count and whether the channel has past live streams (reads YouTube)."""
    found = kb_channels.preview(url)
    canonical = normalize_channel_url(found.channel_url)
    existing = session.exec(
        select(KbChannel.id).where(KbChannel.channel_url == canonical)
    ).first()
    return AskChannelPreview(
        channel_url=canonical or found.channel_url,
        channel_name=found.channel_name,
        video_count=found.video_count,
        has_streams=found.has_streams,
        existing_id=existing,
    )


@router.post(
    "/channels",
    response_model=AskChannelRead,
    status_code=201,
    dependencies=[Depends(require_permission("manage_ask"))],
)
def add_channel(
    body: AskChannelCreate,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Turn Ask on for a channel; its captions are indexed in the background."""
    _require_available(session)
    channel = kb_channels.add(
        session, body.url, include_streams=body.include_streams, user_id=user.id
    )
    return _one(session, channel, user)


@router.patch(
    "/channels/{channel_id}",
    response_model=AskChannelRead,
    dependencies=[Depends(require_permission("manage_ask"))],
)
def update_channel(
    channel_id: int,
    body: AskChannelUpdate,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    channel = kb_channels.get_or_404(session, channel_id)
    kb_channels.set_streams(session, channel, body.include_streams)
    session.refresh(channel)
    return _one(session, channel, user)


@router.post(
    "/channels/{channel_id}/pause",
    response_model=AskChannelRead,
    dependencies=[Depends(require_permission("manage_ask"))],
)
def pause_channel(
    channel_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    channel = kb_channels.get_or_404(session, channel_id)
    kb_channels.pause(session, channel)
    return _one(session, channel, user)


@router.post(
    "/channels/{channel_id}/resume",
    response_model=AskChannelRead,
    dependencies=[Depends(require_permission("manage_ask"))],
)
def resume_channel(
    channel_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    channel = kb_channels.get_or_404(session, channel_id)
    kb_channels.resume(session, channel)
    return _one(session, channel, user)


@router.delete(
    "/channels/{channel_id}",
    status_code=204,
    dependencies=[Depends(require_permission("manage_ask"))],
)
def remove_channel(channel_id: int, session: Session = Depends(get_session)):
    """Turn Ask off for a channel and delete everything indexed for it."""
    channel = kb_channels.get_or_404(session, channel_id)
    kb_channels.remove(session, channel)


@router.get("/search", response_model=AskSearchPage)
def search(
    q: str = Query(..., min_length=1, max_length=300),
    channel_id: list[int] | None = Query(default=None),
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=500),
    session: Session = Depends(get_session),
):
    """Passages that mention the query's words, best match first."""
    try:
        page = parse_cursor(
            cursor, limit=limit, sort=_SORT, order="desc", kind="offset"
        )
    except InvalidCursor as exc:
        raise CodedHTTPException(400, str(exc), "invalid_cursor") from exc
    if not kb_search.fts_available(session):
        return AskSearchPage(items=[])
    hits = kb_search.search(
        session,
        kb_search.query_terms(q),
        channel_ids=channel_id,
        limit=limit + 1,
        offset=page.offset,
    )
    more = len(hits) > limit
    hits = hits[:limit]
    videos = {
        v.id: v
        for v in session.exec(
            select(KbVideo).where(col(KbVideo.id).in_({h.kb_video_id for h in hits}))
        ).all()
    }
    names = {
        c.id: c.channel_name
        for c in session.exec(
            select(KbChannel).where(
                col(KbChannel.id).in_({h.kb_channel_id for h in hits})
            )
        ).all()
    }
    yt_ids = {v.yt_id for v in videos.values()}
    library_ids = {
        yt: vid
        for vid, yt in session.exec(
            select(Video.id, Video.youtube_id).where(col(Video.youtube_id).in_(yt_ids))
        ).all()
    }
    wanted = moments.words(q)
    items = []
    lines_of: dict[int, list[chunking.Line]] = {}
    for hit in hits:
        video = videos.get(hit.kb_video_id)
        if video is None:
            continue
        start = hit.start_sec
        if hit.chunk_index != chunking.META_CHUNK_INDEX and video.id is not None:
            if video.id not in lines_of:
                lines_of[video.id] = chunking.unpack_lines(video.cues)
            start = moments.moment(
                lines_of[video.id], hit.start_sec, hit.end_sec, wanted
            )
        items.append(
            AskSearchHit(
                channel_id=hit.kb_channel_id,
                channel_name=names.get(hit.kb_channel_id),
                yt_id=video.yt_id,
                title=video.title,
                published_at=video.published_at,
                library_video_id=library_ids.get(video.yt_id),
                start_sec=start,
                end_sec=hit.end_sec,
                snippet=hit.snippet,
                in_description=hit.chunk_index == chunking.META_CHUNK_INDEX,
            )
        )
    return AskSearchPage(
        items=items,
        next_cursor=offset_cursor(sort=_SORT, order="desc", offset=page.offset + limit)
        if more
        else None,
    )


_USE_AI = [Depends(require_permission("use_ai"))]


@router.post("/chat", response_class=RAW, responses=EVENT_STREAM, dependencies=_USE_AI)
def chat(
    request: Request,
    payload: AskChatRequest,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """One chat turn (SSE): Ask channels when the question names one, else Ask about Horde."""
    if payload.thread_id is not None:
        threads.owned_or_404(session, payload.thread_id, user.id)
    return StreamingResponse(
        ask_chat.stream_ask_events(
            user,
            payload.message,
            thread_id=payload.thread_id,
            channel_ids=payload.channel_ids,
            page=payload.page,
            data_consent=payload.data_consent,
            authorized=StreamAuthGuard.of(request).still_valid,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/threads", response_model=AskThreadList, dependencies=_USE_AI)
def list_threads(
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=500),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """The user's saved conversations, most recent first."""
    try:
        page = parse_cursor(
            cursor, limit=limit, sort="updated_at", order="desc", kind="offset"
        )
    except InvalidCursor as exc:
        raise CodedHTTPException(400, str(exc), "invalid_cursor") from exc
    rows = threads.list_threads(session, user.id, limit=limit + 1, offset=page.offset)
    return AskThreadList(
        items=[
            AskThreadSummary(id=require_id(t), title=t.title, updated_at=t.updated_at)
            for t in rows[:limit]
        ],
        next_cursor=offset_cursor(
            sort="updated_at", order="desc", offset=page.offset + limit
        )
        if len(rows) > limit
        else None,
    )


@router.get("/threads/{thread_id}", response_model=AskThreadRead, dependencies=_USE_AI)
def get_thread(
    thread_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    thread = threads.owned_or_404(session, thread_id, user.id)
    return AskThreadRead(
        id=thread_id,
        title=thread.title,
        scope=threads.parse_sources(thread.scope) or {},
        messages=[
            AskThreadMessage(
                id=require_id(m),
                role="assistant" if m.role == "assistant" else "user",
                content=m.content,
                sources=threads.parse_sources(m.sources),
                cost=m.cost if user.is_admin else None,
                model=m.model if user.is_admin else None,
                created_at=m.created_at,
            )
            for m in threads.messages(session, thread_id)
        ],
    )


@router.delete("/threads/{thread_id}", status_code=204, dependencies=_USE_AI)
def delete_thread(
    thread_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    threads.delete(session, threads.owned_or_404(session, thread_id, user.id))

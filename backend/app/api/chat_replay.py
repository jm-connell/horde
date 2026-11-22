"""Chat replay of past livestreams, read from YouTube around a position."""

from __future__ import annotations

import re
from dataclasses import asdict

from fastapi import APIRouter, Depends, Query

from ..auth import current_user
from ..errors import CodedHTTPException
from ..parental_guard import stream_guard
from ..schemas import ChatReplayItem, ChatReplayRead
from ..services.chat_replay import service
from ..services.chat_replay.youtube import ChatReplayError
from ..services.comments.fetch import LATER, RETRY
from ..services.limits import ytdlp_slot

router = APIRouter(
    prefix="/api", tags=["chat-replay"], dependencies=[Depends(current_user)]
)

_YT_ID = re.compile(r"[A-Za-z0-9_-]{11}")
#: The longest position asked for (a day; YouTube streams are at most 12 hours).
MAX_AT_MS = 86_400_000


@router.get(
    "/chat-replay/youtube/{youtube_id}",
    response_model=ChatReplayRead,
    dependencies=[Depends(stream_guard), Depends(ytdlp_slot)],
)
def chat_replay(
    youtube_id: str,
    at_ms: int | None = Query(None, ge=0, le=MAX_AT_MS),
    cursor: str | None = None,
):
    """The stretch of a past stream's chat around ``at_ms`` (default 0), or after
    ``cursor`` (an earlier page's ``next_cursor``). Not saved; stretches are kept
    in memory for 30 minutes.
    """
    if not _YT_ID.fullmatch(youtube_id):
        raise CodedHTTPException(422, "Not a YouTube video id", "invalid_youtube_id")
    if at_ms is not None and cursor is not None:
        raise CodedHTTPException(
            422, "Pass at_ms or cursor, not both", "invalid_request"
        )
    if cursor is not None and not service.CURSOR_RE.fullmatch(cursor):
        raise CodedHTTPException(422, "Not a chat replay cursor", "invalid_cursor")
    try:
        page = (
            service.read_next(youtube_id, cursor)
            if cursor is not None
            else service.read_at(youtube_id, at_ms or 0)
        )
    except ChatReplayError as exc:
        if exc.status == RETRY:
            raise CodedHTTPException(
                503,
                "YouTube is limiting requests; try again later",
                "youtube_rate_limited",
            ) from exc
        if exc.status == LATER:
            raise CodedHTTPException(
                503, "Could not reach YouTube; try again later", "youtube_unreachable"
            ) from exc
        raise CodedHTTPException(
            502, "Could not load chat replay from YouTube", "chat_replay_unavailable"
        ) from exc
    return ChatReplayRead(
        status=page.status,
        items=[ChatReplayItem.model_validate(asdict(item)) for item in page.items],
        next_cursor=page.next_cursor,
    )

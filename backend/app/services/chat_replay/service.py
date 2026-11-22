"""Chat replay for the API: a stretch at a position, or the stretch after a cursor.

The first read of a video opens its chat (``youtube.open_chat``) and remembers
it; a position inside the first chunk needs no further request, any other
position is one jump with the seek token, and a cursor (``<end_ms>~<token>``,
handed out with each page) continues with the replay token. Chunks are kept in
memory for a while, keyed by video and position bucket or token, so going back
or a second viewer costs nothing. A rate limit pauses every read for
``PAUSE_ON_LIMIT_SEC`` without asking YouTube again.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import update
from sqlmodel import Session, col

from ...context import current, get_engine
from ...models import Video
from ..comments.fetch import RETRY, UNAVAILABLE
from . import youtube
from .parse import ChatItem
from .runtime import PAUSE_ON_LIMIT_SEC
from .youtube import ChatHandle, ChatReplayError, Chunk, Opened

#: ``<end_ms>~<YouTube replay token>``.
CURSOR_RE = re.compile(r"\d{1,9}~[A-Za-z0-9_%=-]{1,4096}")
#: Jumps within this many milliseconds of each other share a cached chunk.
AT_BUCKET_MS = 5000
#: A continuation asks for a little before the last message, as YouTube's own
#: player and yt-dlp do, so nothing at the seam is skipped.
CONTINUE_OVERLAP_MS = 5000


@dataclass
class ChatPage:
    status: Literal["ok", "none", "unavailable"]
    items: list[ChatItem]
    next_cursor: str | None


def _page(chunk: Chunk) -> ChatPage:
    cursor = (
        f"{chunk.end_ms}~{chunk.replay_token}"
        if chunk.end_ms is not None and chunk.replay_token
        else None
    )
    return ChatPage("ok", chunk.items, cursor)


def _record_live_status(yt_id: str, live_status: str | None) -> None:
    """Tell a library video of unknown ``live_status`` what the page said."""
    if live_status is None:
        return
    with Session(get_engine()) as session:
        session.exec(
            update(Video)
            .where(col(Video.youtube_id) == yt_id, col(Video.live_status).is_(None))
            .values(live_status=live_status)
        )
        session.commit()


def _opened(yt_id: str) -> Opened:
    runtime = current().chat_replay
    opened = runtime.opened_get(yt_id)
    if opened is None:
        opened = youtube.open_chat(yt_id)
        runtime.opened_put(yt_id, opened)
        _record_live_status(yt_id, opened.live_status)
    return opened


def _guarded(
    yt_id: str, read: Callable[[ChatHandle, Chunk | None], ChatPage]
) -> ChatPage:
    runtime = current().chat_replay
    if runtime.seconds_paused() > 0:
        raise ChatReplayError(RETRY)
    try:
        with runtime.video_lock(yt_id):
            opened = _opened(yt_id)
            if opened.handle is None:
                return ChatPage("none", [], None)
            return read(opened.handle, opened.first)
    except ChatReplayError as exc:
        if exc.status == UNAVAILABLE:
            return ChatPage("unavailable", [], None)
        if exc.status == RETRY:
            runtime.pause(PAUSE_ON_LIMIT_SEC)
        raise


def read_at(yt_id: str, at_ms: int) -> ChatPage:
    """The stretch of chat around ``at_ms``. Raises ``ChatReplayError``."""

    def read(handle: ChatHandle, first: Chunk | None) -> ChatPage:
        seek = handle.seek_token
        if first is not None and (
            first.end_ms is None or at_ms <= first.end_ms or seek is None
        ):
            return _page(first)
        if seek is None:
            # No way to jump (YouTube sent no seek token): nothing to show here.
            return ChatPage("ok", [], None)
        runtime = current().chat_replay
        key = (yt_id, f"at:{at_ms // AT_BUCKET_MS}")
        chunk = runtime.chunk_get(key)
        if chunk is None:
            chunk = youtube.fetch_chunk(handle, seek, at_ms)
            runtime.chunk_put(key, chunk)
            if chunk.seek_token:
                handle.seek_token = chunk.seek_token
        return _page(chunk)

    return _guarded(yt_id, read)


def read_next(yt_id: str, cursor: str) -> ChatPage:
    """The stretch after ``cursor`` (from an earlier page). Raises ``ChatReplayError``."""
    if not CURSOR_RE.fullmatch(cursor):
        raise ValueError("not a chat replay cursor")
    end_text, token = cursor.split("~", 1)
    end_ms = int(end_text)

    def read(handle: ChatHandle, first: Chunk | None) -> ChatPage:
        runtime = current().chat_replay
        key = (yt_id, f"next:{token}")
        chunk = runtime.chunk_get(key)
        if chunk is None:
            chunk = youtube.fetch_chunk(
                handle, token, max(end_ms - CONTINUE_OVERLAP_MS, 0)
            )
            runtime.chunk_put(key, chunk)
        return _page(chunk)

    return _guarded(yt_id, read)

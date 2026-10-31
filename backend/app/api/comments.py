"""YouTube comments: the ones saved with a library video, and more read on request."""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Literal

from fastapi import APIRouter, Depends
from sqlmodel import Session

from ..auth import current_user
from ..context import get_session
from ..errors import CodedHTTPException
from ..models import Video, VideoComment, VideoCommentState
from ..schemas import CommentRead, LiveCommentsRead, VideoCommentsRead
from ..services.comments import fetch, live, store
from ..services.comments import worker as comments_worker
from ..services.comments.fetch import FetchedComment
from ..services.limits import ytdlp_slot

router = APIRouter(
    prefix="/api", tags=["comments"], dependencies=[Depends(current_user)]
)

_YT_ID = re.compile(r"[A-Za-z0-9_-]{11}")

_STORED: dict[str, Literal["saved", "disabled", "unavailable", "failed"]] = {
    fetch.SAVED: "saved",
    fetch.DISABLED: "disabled",
    fetch.UNAVAILABLE: "unavailable",
    fetch.FAILED: "failed",
}


def _comment(
    comment: VideoComment | FetchedComment,
    replies: Sequence[VideoComment | FetchedComment] = (),
) -> CommentRead:
    return CommentRead(
        id=comment.comment_id,
        author=comment.author,
        author_is_uploader=comment.author_is_uploader,
        is_pinned=comment.is_pinned,
        is_hearted=comment.is_hearted,
        like_count=comment.like_count,
        text=comment.text,
        published_at=comment.published_at,
        replies=[_comment(r) for r in replies],
    )


def _threads[C: (VideoComment, FetchedComment)](
    comments: Sequence[C],
) -> list[CommentRead]:
    return [_comment(t.comment, t.replies) for t in store.threads(comments)]


@router.get("/videos/{video_id}/comments", response_model=VideoCommentsRead)
def video_comments(video_id: int, session: Session = Depends(get_session)):
    """The comments saved with a library video, top-level in YouTube's order."""
    video = session.get(Video, video_id)
    if video is None:
        raise CodedHTTPException(404, "Video not found", "not_found")
    if video.youtube_id is None:
        return VideoCommentsRead(status="not_youtube")
    state = session.get(VideoCommentState, video_id)
    items = _threads(store.saved_comments(session, video_id))
    read = VideoCommentsRead(
        status="pending",
        youtube_id=video.youtube_id,
        items=items,
    )
    if state is None:
        if not comments_worker.enabled():
            read.status = "off"
        return read
    read.fetched_at = state.fetched_at
    read.total_count = state.total_count
    if state.status != fetch.FAILED or state.next_attempt_at is None:
        read.status = _STORED.get(state.status, "failed")
    # More can be read from YouTube only while it still shows the comments.
    if read.status in ("saved", "pending") and len(items) >= fetch.TOP_COMMENTS:
        read.next_limit = live.next_step(fetch.TOP_COMMENTS)
    return read


@router.get(
    "/comments/youtube/{youtube_id}",
    response_model=LiveCommentsRead,
    dependencies=[Depends(ytdlp_slot)],
)
def live_comments(youtube_id: str, limit: int = fetch.TOP_COMMENTS):
    """The top ``limit`` comments of any YouTube video, read from YouTube now.

    ``limit`` is one of 100, 300 or 1000 (follow ``next_limit``). Not saved; a
    result is kept in memory for 30 minutes.
    """
    if not _YT_ID.fullmatch(youtube_id):
        raise CodedHTTPException(422, "Not a YouTube video id", "invalid_youtube_id")
    if limit not in live.LIVE_STEPS:
        raise CodedHTTPException(
            422,
            f"limit must be one of {', '.join(map(str, live.LIVE_STEPS))}",
            "invalid_limit",
        )
    result = live.fetch_live(youtube_id, limit)
    if result.status == fetch.RETRY:
        raise CodedHTTPException(
            503, "YouTube is limiting requests; try again later", "youtube_rate_limited"
        )
    if result.status == fetch.LATER:
        raise CodedHTTPException(
            503, "Could not reach YouTube; try again later", "youtube_unreachable"
        )
    if result.status == fetch.FAILED:
        raise CodedHTTPException(
            502, "Could not load comments from YouTube", "comments_unavailable"
        )
    if result.status != fetch.SAVED:
        return LiveCommentsRead(
            status="disabled" if result.status == fetch.DISABLED else "unavailable",
            total_count=result.total_count,
        )
    items = _threads(result.comments)
    return LiveCommentsRead(
        status="ok",
        total_count=result.total_count,
        items=items,
        next_limit=live.next_step(limit) if len(items) >= limit else None,
    )

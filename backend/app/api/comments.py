"""YouTube comments: the ones saved with a library video, and more read on request."""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Literal

from fastapi import APIRouter, Depends
from sqlmodel import Session

from ..auth import current_user, require_permission
from ..context import AppContext, get_ctx, get_session
from ..errors import CodedHTTPException
from ..models import Video, VideoComment, VideoCommentState, require_id
from ..schemas import CommentRead, LiveCommentsRead, VideoCommentsRead
from ..services import comments as comments_svc
from ..services.comments import fetch, live, store
from ..services.comments import worker as comments_worker
from ..services.comments.fetch import FetchedComment
from ..services.limits import ytdlp_slot
from ..services.ytdlp_common import EXTRACT_PRIORITY_INTERACTIVE

router = APIRouter(
    prefix="/api", tags=["comments"], dependencies=[Depends(current_user)]
)

_YT_ID = re.compile(r"[A-Za-z0-9_-]{11}")

_STORED: dict[str, Literal["saved", "pending", "disabled", "unavailable", "failed"]] = {
    fetch.SAVED: "saved",
    store.PENDING: "pending",
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


def _video_comments(session: Session, video: Video) -> VideoCommentsRead:
    if not comments_svc.enabled():
        return VideoCommentsRead(status="off")
    if video.youtube_id is None:
        return VideoCommentsRead(status="not_youtube")
    video_id = require_id(video)
    state = session.get(VideoCommentState, video_id)
    items = _threads(store.saved_comments(session, video_id))
    read = VideoCommentsRead(status="pending", youtube_id=video.youtube_id, items=items)
    if state is None:
        return read
    read.fetched_at = state.fetched_at
    read.total_count = state.total_count
    read.status = _STORED.get(state.status, "failed")
    # More can be read from YouTube only while it still shows the comments.
    if read.status in ("saved", "pending") and len(items) >= fetch.TOP_COMMENTS:
        read.next_limit = live.next_step(fetch.TOP_COMMENTS)
    return read


def _video_or_404(session: Session, video_id: int) -> Video:
    video = session.get(Video, video_id)
    if video is None:
        raise CodedHTTPException(404, "Video not found", "not_found")
    return video


@router.get("/videos/{video_id}/comments", response_model=VideoCommentsRead)
def video_comments(video_id: int, session: Session = Depends(get_session)):
    """The comments saved with a library video, top-level in YouTube's order."""
    return _video_comments(session, _video_or_404(session, video_id))


@router.post(
    "/videos/{video_id}/comments/refresh",
    response_model=VideoCommentsRead,
    dependencies=[Depends(require_permission("edit_metadata")), Depends(ytdlp_slot)],
)
def refresh_video_comments(
    video_id: int,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
):
    """Fetch and save a library video's top comments now, then return them.

    The background schedule carries on from here (the next refresh age).
    """
    video = _video_or_404(session, video_id)
    _require_enabled()
    if video.youtube_id is None:
        raise CodedHTTPException(
            409, "This video did not come from YouTube", "not_youtube"
        )
    result = fetch.fetch_comments(
        video.youtube_id, priority=EXTRACT_PRIORITY_INTERACTIVE
    )
    # Only an answer from YouTube is recorded: a failed refresh by hand must not
    # use up the fetcher's retries or move the video's schedule.
    if result.status in (fetch.SAVED, fetch.DISABLED, fetch.UNAVAILABLE):
        store.apply_result(session, video, result)
    if result.status == fetch.RETRY:
        ctx.comments.pause(comments_worker.PAUSE_ON_LIMIT_SEC)
    _raise_for_failure(result)
    session.refresh(video)
    return _video_comments(session, video)


def _require_enabled() -> None:
    if not comments_svc.enabled():
        raise CodedHTTPException(409, "Comments are turned off", "comments_off")


def _raise_for_failure(result: fetch.FetchResult) -> None:
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
    _require_enabled()
    if not _YT_ID.fullmatch(youtube_id):
        raise CodedHTTPException(422, "Not a YouTube video id", "invalid_youtube_id")
    if limit not in live.LIVE_STEPS:
        raise CodedHTTPException(
            422,
            f"limit must be one of {', '.join(map(str, live.LIVE_STEPS))}",
            "invalid_limit",
        )
    result = live.fetch_live(youtube_id, limit)
    _raise_for_failure(result)
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

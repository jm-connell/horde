"""Save a video's fetched comments, record how the fetch went, and read them back."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlmodel import Session, col, select

from ...models import Video, VideoComment, VideoCommentState, as_utc, require_id
from .fetch import (
    DISABLED,
    FAILED,
    RETRY,
    SAVED,
    UNAVAILABLE,
    FetchedComment,
    FetchResult,
)

#: Comments on a new upload keep coming for days: fetch once more a week in.
REFRESH_AGE = timedelta(days=7)
#: A failed fetch is retried this many times (1 h, 4 h, 16 h apart), then left.
MAX_ATTEMPTS = 3
RETRY_BASE = timedelta(hours=1)
#: After a rate limit or bot check, the same video is tried again this much later.
RATE_LIMIT_WAIT = timedelta(hours=1)


@dataclass
class Thread[C: (VideoComment, FetchedComment)]:
    """A top-level comment and the replies that were saved with it."""

    comment: C
    replies: list[C] = field(default_factory=list)


def threads[C: (VideoComment, FetchedComment)](
    comments: Sequence[C],
) -> list[Thread[C]]:
    """Group comments in fetch order into threads (replies follow their parent)."""
    out: list[Thread[C]] = []
    by_id: dict[str, Thread[C]] = {}
    for comment in comments:
        if comment.parent_comment_id is None:
            thread = Thread(comment)
            by_id[comment.comment_id] = thread
            out.append(thread)
        elif comment.parent_comment_id in by_id:
            by_id[comment.parent_comment_id].replies.append(comment)
    return out


def saved_comments(session: Session, video_id: int) -> list[VideoComment]:
    return list(
        session.exec(
            select(VideoComment)
            .where(VideoComment.video_id == video_id)
            .order_by(col(VideoComment.position))
        ).all()
    )


def _refresh_at(video: Video, now: datetime) -> datetime | None:
    published = as_utc(video.published_at)
    if published is None or now - published >= REFRESH_AGE:
        return None
    return published + REFRESH_AGE


def apply_result(session: Session, video: Video, result: FetchResult) -> None:
    """Record a fetch: replace the saved comments when it worked. Commits."""
    video_id = require_id(video)
    now = datetime.now(UTC)
    state = session.get(VideoCommentState, video_id) or VideoCommentState(
        video_id=video_id
    )
    if result.status == SAVED:
        session.exec(delete(VideoComment).where(col(VideoComment.video_id) == video_id))
        session.add_all(
            VideoComment(
                video_id=video_id,
                comment_id=c.comment_id,
                parent_comment_id=c.parent_comment_id,
                position=i,
                author=c.author,
                author_is_uploader=c.author_is_uploader,
                is_pinned=c.is_pinned,
                is_hearted=c.is_hearted,
                like_count=c.like_count,
                text=c.text,
                published_at=c.published_at,
            )
            for i, c in enumerate(result.comments)
        )
        state.status = SAVED
        state.fetched_at = now
        state.total_count = result.total_count
        state.attempts = 0
        state.next_attempt_at = _refresh_at(video, now)
    elif result.status in (DISABLED, UNAVAILABLE):
        # Comments saved earlier stay: they may be all that is left of them.
        state.status = result.status
        state.fetched_at = now
        state.total_count = result.total_count
        state.attempts = 0
        state.next_attempt_at = None
    elif result.status == RETRY:
        if state.fetched_at is None:
            state.status = FAILED
        state.next_attempt_at = now + RATE_LIMIT_WAIT
    else:
        state.attempts += 1
        if state.fetched_at is None:
            state.status = FAILED
        state.next_attempt_at = (
            now + RETRY_BASE * 4 ** (state.attempts - 1)
            if state.attempts < MAX_ATTEMPTS
            else None
        )
    session.add(state)
    session.commit()


#: Room the video chat gives saved comments, and one comment at most.
CHAT_COMMENTS_CHARS = 3_000
_CHAT_COMMENT_CHARS = 400


def _chat_line(comment: VideoComment, *, reply: bool) -> str:
    marks = [
        mark
        for mark, on in (
            ("the creator", comment.author_is_uploader),
            ("pinned", comment.is_pinned),
            ("hearted by the creator", comment.is_hearted),
        )
        if on
    ]
    head = "  - reply" if reply else "-"
    if marks:
        head += f" [{', '.join(marks)}]"
    text = " ".join(comment.text.split())
    if len(text) > _CHAT_COMMENT_CHARS:
        text = text[: _CHAT_COMMENT_CHARS - 1].rstrip() + "…"
    likes = f" ({comment.like_count} likes)" if comment.like_count else ""
    return f"{head} {text}{likes}"


def chat_lines(session: Session, video_id: int) -> list[str]:
    """The top saved comments for the video chat, with the creator's replies."""
    lines: list[str] = []
    used = 0
    for thread in threads(saved_comments(session, video_id)):
        group = [_chat_line(thread.comment, reply=False)] + [
            _chat_line(r, reply=True) for r in thread.replies if r.author_is_uploader
        ]
        size = sum(len(line) + 1 for line in group)
        if used + size > CHAT_COMMENTS_CHARS:
            break
        lines.extend(group)
        used += size
    return lines

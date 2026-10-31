"""Comments fetched when someone asks for them, without saving them.

"Show more comments" past the saved ones, and the comments of a video that is
only being streamed. yt-dlp cannot continue from where an earlier fetch stopped,
so each step reads the top ``limit`` comments from the start; results are kept
in memory for a while (``CommentsRuntime``) so going back costs nothing.
"""

from __future__ import annotations

from ...context import current
from ..ytdlp_common import EXTRACT_PRIORITY_INTERACTIVE
from .fetch import FAILED, LIVE_MAX, RETRY, TOP_COMMENTS, FetchResult, fetch_comments

#: The steps "Show more comments" takes (top-level comments read from YouTube).
LIVE_STEPS = (TOP_COMMENTS, 300, LIVE_MAX)


def next_step(limit: int) -> int | None:
    """The step after one that returned ``limit`` comments, or None at the end."""
    return next((step for step in LIVE_STEPS if step > limit), None)


def fetch_live(yt_id: str, limit: int) -> FetchResult:
    """The top ``limit`` comments, with the top threads' replies on the first step."""
    runtime = current().comments
    cached = runtime.live_get(yt_id, limit)
    if cached is not None:
        return cached
    result = fetch_comments(
        yt_id,
        limit=limit,
        replies=limit <= TOP_COMMENTS,
        priority=EXTRACT_PRIORITY_INTERACTIVE,
    )
    if result.status not in (RETRY, FAILED):
        runtime.live_put(yt_id, limit, result)
    return result

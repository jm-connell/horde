"""Fetch a YouTube video's top comments with yt-dlp, without the video.

YouTube returns comments about 20 at a time in its "top" order, each reply thread
behind a request of its own. yt-dlp's ``max_comments`` caps the top-level count and
the total replies across all threads; threads are read in rank order, so the
reply budget goes to the highest-ranked discussions and later threads cost no
request at all. The info is extracted unprocessed (no format selection) and the
comment pages are read from it inside the extract gate (``call_gated``).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from ..downloads.subtitles import SubtitleYtdlpLogger
from ..ytdlp_common import (
    ERROR_KIND_BOT,
    ERROR_KIND_MEMBERS,
    ERROR_KIND_POT,
    ERROR_KIND_RATE_LIMIT,
    ERROR_KIND_UNAVAILABLE,
    EXTRACT_PRIORITY_BACKGROUND,
    apply_cookie_opts,
    call_gated,
    classify_ytdlp_error,
    should_retry_with_cookies,
    url_cookie_required,
    youtube_extractor_args,
)

logger = logging.getLogger(__name__)

#: Top-level comments saved per video.
TOP_COMMENTS = 100
#: Replies saved per thread, and for all threads of a video together.
REPLIES_PER_THREAD = 10
REPLY_BUDGET = 100
#: The most top-level comments a live (unsaved) fetch reads.
LIVE_MAX = 1000

_MAX_TEXT = 10_000
_MAX_AUTHOR = 200

# Outcomes (``VideoCommentState.status``, except ``retry``).
SAVED = "saved"
DISABLED = "disabled"
UNAVAILABLE = "unavailable"
FAILED = "failed"
RETRY = "retry"  # rate limited or bot check: everyone waits, then tries again

_RETRY_KINDS = frozenset({ERROR_KIND_RATE_LIMIT, ERROR_KIND_BOT, ERROR_KIND_POT})


@dataclass
class FetchedComment:
    comment_id: str
    parent_comment_id: str | None
    author: str | None
    author_is_uploader: bool
    is_pinned: bool
    is_hearted: bool
    like_count: int | None
    text: str
    published_at: datetime | None


@dataclass
class FetchResult:
    status: str
    comments: list[FetchedComment] = field(default_factory=list)
    #: YouTube's count of all the video's comments.
    total_count: int | None = None
    message: str | None = None


def video_url(yt_id: str) -> str:
    return f"https://www.youtube.com/watch?v={yt_id}"


def _ydl_opts(limit: int, *, replies: bool) -> dict[str, Any]:
    args = youtube_extractor_args()
    youtube = dict(args.get("youtube") or {})
    # total, top-level, replies in all, replies per thread, depth
    youtube["max_comments"] = [
        "all",
        str(limit),
        str(REPLY_BUDGET if replies else 0),
        str(REPLIES_PER_THREAD),
        "2" if replies else "1",
    ]
    youtube["comment_sort"] = ["top"]
    # Formats are not wanted: skip the manifests the extractor would download.
    youtube["skip"] = ["hls", "dash", "translated_subs"]
    args["youtube"] = youtube
    return {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "getcomments": True,
        "extractor_args": args,
        "logger": SubtitleYtdlpLogger(),
    }


def _extract(url: str, opts: dict[str, Any]) -> dict[str, Any]:
    import yt_dlp

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = dict(ydl.extract_info(url, download=False, process=False) or {})
        # The real count, before the comment pages replace it with how many were read.
        total = info.get("comment_count")
        post = info.pop("__post_extractor", None)
        extra = post() if callable(post) else {}
    return {"comment_count": total, "comments": (extra or {}).get("comments")}


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return int(value)


def _parse_one(raw: Any) -> FetchedComment | None:
    if not isinstance(raw, dict):
        return None
    comment_id = str(raw.get("id") or "").strip()
    text = str(raw.get("text") or "").strip()
    if not comment_id or not text:
        return None
    parent = raw.get("parent")
    timestamp = _int_or_none(raw.get("timestamp"))
    published_at = None
    if timestamp is not None and timestamp > 0:
        try:
            published_at = datetime.fromtimestamp(timestamp, UTC)
        except OverflowError, OSError, ValueError:
            published_at = None
    author = str(raw.get("author") or "").strip() or None
    likes = _int_or_none(raw.get("like_count"))
    return FetchedComment(
        comment_id=comment_id,
        parent_comment_id=None if parent in (None, "", "root") else str(parent),
        author=author[:_MAX_AUTHOR] if author else None,
        author_is_uploader=raw.get("author_is_uploader") is True,
        is_pinned=raw.get("is_pinned") is True,
        is_hearted=raw.get("is_favorited") is True,
        like_count=likes if likes is not None and likes >= 0 else None,
        text=text[:_MAX_TEXT],
        published_at=published_at,
    )


def parse_comments(raw: Any) -> list[FetchedComment]:
    """yt-dlp's comment dicts, in order, without duplicates or orphaned replies."""
    found: list[FetchedComment] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        comment = _parse_one(item)
        if comment is None or comment.comment_id in seen:
            continue
        if comment.parent_comment_id is not None and (
            comment.parent_comment_id not in seen
        ):
            continue
        seen.add(comment.comment_id)
        found.append(comment)
    return found


def _fetch(url: str, limit: int, replies: bool) -> FetchResult:
    opts = _ydl_opts(limit, replies=replies)
    with_cookies = url_cookie_required(url)
    try:
        data = _extract(url, apply_cookie_opts(opts) if with_cookies else opts)
    except Exception as exc:
        if with_cookies or not should_retry_with_cookies({}, exc):
            raise
        data = _extract(url, apply_cookie_opts(opts))
    total = _int_or_none(data.get("comment_count"))
    if data.get("comments") is None:
        # yt-dlp's answer when the comment section is turned off.
        return FetchResult(DISABLED, total_count=total)
    return FetchResult(SAVED, parse_comments(data["comments"]), total_count=total)


def fetch_comments(
    yt_id: str,
    *,
    limit: int = TOP_COMMENTS,
    replies: bool = True,
    priority: int = EXTRACT_PRIORITY_BACKGROUND,
) -> FetchResult:
    """Up to ``limit`` top comments (and replies to the top threads). Never raises."""
    url = video_url(yt_id)
    try:
        return call_gated(
            lambda: _fetch(url, limit, replies), url=url, priority=priority
        )
    except Exception as exc:
        kind, message = classify_ytdlp_error(exc, url=url)
        logger.info("Comments for %s failed (%s)", yt_id, kind, exc_info=True)
        if kind in (ERROR_KIND_MEMBERS, ERROR_KIND_UNAVAILABLE):
            return FetchResult(UNAVAILABLE, message=message)
        if kind in _RETRY_KINDS:
            return FetchResult(RETRY, message=message)
        return FetchResult(FAILED, message=message)

"""Keyword search over saved comments (``video_comments_fts``), for library search.

Matching is the library's: every query token as a whole word or a light
inflection (``search_text.fts_match_expression``), all within one comment. The
expression is built from the query, never taken from it.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlmodel import Session, select

from ...models import VideoComment
from ..search_text import fts_match_expression, query_in_text, snippet_around

#: Videos found through their comments that a search adds at most.
MAX_VIDEOS = 200


def _available(session: Session) -> bool:
    return (
        session.connection()
        .exec_driver_sql(
            "SELECT 1 FROM sqlite_master WHERE name = 'video_comments_fts'"
        )
        .first()
        is not None
    )


def matching_video_ids(session: Session, query: str) -> list[int]:
    """Videos with a saved comment matching ``query``, most matching comments first."""
    match = fts_match_expression(query)
    if match is None or not _available(session):
        return []
    rows = session.execute(
        text(
            "SELECT c.video_id FROM video_comments_fts "
            "JOIN video_comments c ON c.id = video_comments_fts.rowid "
            "WHERE video_comments_fts MATCH :q "
            "GROUP BY c.video_id "
            "ORDER BY count(*) DESC, max(coalesce(c.like_count, 0)) DESC "
            "LIMIT :limit"
        ),
        {"q": match, "limit": MAX_VIDEOS},
    ).all()
    return [int(r[0]) for r in rows]


def best_snippet(session: Session, video_id: int, query: str) -> str | None:
    """The best-liked comment of a video that matches, shortened around the match.

    Reads the video's own saved comments (a couple of hundred at most) instead of
    every match in the library.
    """
    if fts_match_expression(query) is None:
        return None
    rows = session.exec(
        select(VideoComment.text, VideoComment.like_count).where(
            VideoComment.video_id == video_id
        )
    ).all()
    matching = [
        (likes or 0, body) for body, likes in rows if query_in_text(query, body)
    ]
    if not matching:
        return None
    _, body = max(matching, key=lambda m: m[0])
    return snippet_around(body, query) or None

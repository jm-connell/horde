import json
from typing import Optional

from sqlalchemy import func
from sqlmodel import Session, select

from ..models import Video


SORT_COLUMNS = {
    "added_at": Video.added_at,
    "title": Video.title,
    "duration": Video.duration_sec,
    "published_at": Video.published_at,
}


def parse_tags(raw: str) -> list[str]:
    try:
        value = json.loads(raw)
        return [str(t) for t in value] if isinstance(value, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def dump_tags(tags: list[str]) -> str:
    cleaned = [t.strip() for t in tags if t and t.strip()]
    return json.dumps(cleaned)


def parse_subtitles(raw: Optional[str]) -> list[dict]:
    try:
        value = json.loads(raw or "[]")
        return [t for t in value if isinstance(t, dict)] if isinstance(value, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def dump_subtitles(tracks: list[dict]) -> str:
    return json.dumps(tracks)


def query_videos(
    session: Session,
    q: Optional[str] = None,
    channel: Optional[str] = None,
    tag: Optional[str] = None,
    sort: str = "added_at",
    order: str = "desc",
    needs_review: Optional[bool] = None,
) -> list[Video]:
    statement = select(Video)

    if needs_review is not None:
        statement = statement.where(Video.needs_review == needs_review)
    if channel:
        statement = statement.where(Video.channel == channel)
    if q:
        like = f"%{q}%"
        statement = statement.where(
            Video.title.ilike(like)
            | Video.description.ilike(like)
            | Video.channel.ilike(like)
            | Video.notes.ilike(like)
            | Video.tags.ilike(like)
        )
    if tag:
        # Tags are stored as a JSON list string; match the quoted token.
        statement = statement.where(Video.tags.ilike(f'%"{tag}"%'))

    column = SORT_COLUMNS.get(sort, Video.added_at)
    statement = statement.order_by(column.desc() if order == "desc" else column.asc())

    return list(session.exec(statement).all())


def rename_channel(session: Session, old_name: str, new_name: str) -> int:
    """Rename a channel across all videos. Returns the number of rows updated."""
    rows = session.exec(select(Video).where(Video.channel == old_name)).all()
    for video in rows:
        video.channel = new_name
        session.add(video)
    if rows:
        session.commit()
    return len(rows)


def channel_stats(session: Session) -> list[tuple[str, int]]:
    statement = (
        select(Video.channel, func.count(Video.id))
        .where(Video.channel.is_not(None))
        .group_by(Video.channel)
        .order_by(func.count(Video.id).desc())
    )
    return [(c, n) for c, n in session.exec(statement).all() if c]


def all_tags(session: Session) -> list[str]:
    rows = session.exec(select(Video.tags)).all()
    seen: set[str] = set()
    for raw in rows:
        for tag in parse_tags(raw):
            seen.add(tag)
    return sorted(seen)

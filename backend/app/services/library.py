import json
import random as py_random
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, nullsfirst, nullslast
from sqlmodel import Session, select

from ..models import Video

PROGRESS_EXPIRY_DAYS = 14
CONTINUE_WATCHING_DAYS = 7

SORT_COLUMNS = {
    "added_at": Video.added_at,
    "title": Video.title,
    "duration": Video.duration_sec,
    "published_at": Video.published_at,
    "file_size": Video.file_size,
    "view_count": Video.view_count,
    "last_watched_at": Video.last_watched_at,
}


@dataclass
class ChannelStatRow:
    channel: str
    count: int
    last_download_at: Optional[datetime]
    subscriber_count: Optional[int]
    channel_url: Optional[str]


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


def expire_stale_progress(session: Session) -> None:
    """Reset watch position on videos not watched within the configured expiry period."""
    from .app_settings import load as load_app_settings
    expiry_days = load_app_settings().get("progress_expiry_days", PROGRESS_EXPIRY_DAYS)
    cutoff = datetime.now(timezone.utc) - timedelta(days=expiry_days)
    rows = session.exec(
        select(Video).where(
            Video.last_watched_at.is_not(None),
            Video.last_watched_at < cutoff,
            Video.last_position_sec > 0,
        )
    ).all()
    for video in rows:
        video.last_position_sec = 0.0
        session.add(video)
    if rows:
        session.commit()


def _apply_sort(statement, sort: str, order: str):
    if sort == "random":
        return statement, True

    column = SORT_COLUMNS.get(sort, Video.added_at)
    nullable = sort in ("file_size", "view_count", "last_watched_at")
    if order == "desc":
        ordering = nullslast(column.desc()) if nullable else column.desc()
    else:
        ordering = nullsfirst(column.asc()) if nullable else column.asc()
    return statement.order_by(ordering), False


def query_videos(
    session: Session,
    q: Optional[str] = None,
    channel: Optional[str] = None,
    tag: Optional[str] = None,
    sort: str = "added_at",
    order: str = "desc",
    needs_review: Optional[bool] = None,
    continue_watching: bool = False,
    watched_only: bool = False,
    seed: Optional[int] = None,
) -> list[Video]:
    statement = select(Video)

    if needs_review is not None:
        statement = statement.where(Video.needs_review == needs_review)
    if continue_watching:
        from .app_settings import load as load_app_settings

        settings = load_app_settings()
        cw_days = settings.get("continue_watching_days", CONTINUE_WATCHING_DAYS)
        cw_cutoff = datetime.now(timezone.utc) - timedelta(days=cw_days)
        # Started but not effectively finished (within the last 10% of runtime).
        statement = statement.where(Video.last_position_sec >= 30).where(
            (Video.duration_sec.is_(None))
            | (Video.last_position_sec < Video.duration_sec * 0.9)
        )
        statement = statement.where(Video.last_watched_at.is_not(None))
        statement = statement.where(Video.last_watched_at >= cw_cutoff)
        statement = statement.order_by(Video.last_watched_at.desc()).limit(12)
        return list(session.exec(statement).all())
    if watched_only:
        statement = statement.where(Video.last_watched_at.is_not(None))
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

    statement, is_random = _apply_sort(statement, sort, order)

    results = list(session.exec(statement).all())
    if is_random:
        rng = py_random.Random(seed)
        rng.shuffle(results)
    return results


def rename_channel(session: Session, old_name: str, new_name: str) -> int:
    """Rename a channel across all videos. Returns the number of rows updated."""
    rows = session.exec(select(Video).where(Video.channel == old_name)).all()
    for video in rows:
        video.channel = new_name
        session.add(video)
    if rows:
        session.commit()
    return len(rows)


def channel_stats(
    session: Session,
    sort: str = "recent_download",
    order: str = "desc",
) -> list[ChannelStatRow]:
    statement = (
        select(
            Video.channel,
            func.count(Video.id),
            func.max(Video.added_at),
            func.max(Video.channel_subscriber_count),
            func.max(Video.channel_url),
        )
        .where(Video.channel.is_not(None))
        .where(Video.needs_review == False)  # noqa: E712
        .group_by(Video.channel)
    )
    rows = [
        ChannelStatRow(
            channel=c,
            count=int(n),
            last_download_at=last_dl,
            subscriber_count=int(sub) if sub is not None else None,
            channel_url=url,
        )
        for c, n, last_dl, sub, url in session.exec(statement).all()
        if c
    ]

    def sort_key(row: ChannelStatRow):
        if sort == "video_count":
            return row.count
        if sort == "alphabetical":
            return row.channel.lower()
        if sort == "subscriber_count":
            # Nulls sort last regardless of direction (handled below).
            return row.subscriber_count if row.subscriber_count is not None else -1
        # recent_download (default)
        if row.last_download_at is None:
            return datetime.min.replace(tzinfo=timezone.utc)
        return row.last_download_at

    reverse = order == "desc"
    if sort == "subscriber_count":
        # Put channels without subscriber data at the end.
        with_sub = [r for r in rows if r.subscriber_count is not None]
        without_sub = [r for r in rows if r.subscriber_count is None]
        with_sub.sort(key=lambda r: r.subscriber_count or 0, reverse=reverse)
        without_sub.sort(key=lambda r: r.channel.lower())
        return with_sub + without_sub

    rows.sort(key=sort_key, reverse=reverse)
    return rows


def resolve_channel_url(session: Session, channel_name: str) -> Optional[str]:
    """Return a canonical channel URL for a library channel name, if known."""
    for row in channel_stats(session):
        if row.channel == channel_name and row.channel_url:
            return row.channel_url
    return None


def find_video_by_youtube_id(session: Session, yt_id: str) -> Optional[Video]:
    """Find a library video by YouTube id in source_url or [id] in file_path."""
    if not yt_id:
        return None
    token = f"[{yt_id}]"
    # Prefer path match (works even without source_url).
    by_path = session.exec(
        select(Video).where(Video.file_path.contains(token))  # type: ignore[attr-defined]
    ).first()
    if by_path is not None:
        return by_path
    from urllib.parse import urlparse

    from .url_clean import _youtube_video_id

    rows = session.exec(
        select(Video).where(Video.source_url.is_not(None))  # type: ignore[attr-defined]
    ).all()
    for video in rows:
        if not video.source_url:
            continue
        try:
            parsed = urlparse(video.source_url)
        except ValueError:
            continue
        if _youtube_video_id(parsed) == yt_id:
            return video
    return None


def youtube_library_map(
    session: Session, channel: Optional[str] = None
) -> dict[str, tuple[int, Optional[int], Optional[int]]]:
    """Map YouTube video IDs to local library video IDs, heights, and view counts."""
    from urllib.parse import urlparse

    from .url_clean import _youtube_video_id

    statement = select(
        Video.id, Video.source_url, Video.height_px, Video.view_count, Video.file_path
    )
    if channel:
        statement = statement.where(Video.channel == channel)
    mapping: dict[str, tuple[int, Optional[int], Optional[int]]] = {}
    for video_id, source_url, height_px, views, file_path in session.exec(statement).all():
        yt_id = None
        if source_url:
            try:
                parsed = urlparse(source_url)
                yt_id = _youtube_video_id(parsed)
            except ValueError:
                yt_id = None
        if not yt_id and file_path:
            match = re.search(r"\[([A-Za-z0-9_-]{11})\]", file_path)
            if match:
                yt_id = match.group(1)
        if yt_id:
            mapping[yt_id] = (
                int(video_id),
                int(height_px) if height_px else None,
                int(views) if views is not None else None,
            )
    return mapping


def all_tags(session: Session) -> list[str]:
    rows = session.exec(select(Video.tags)).all()
    seen: set[str] = set()
    for raw in rows:
        for tag in parse_tags(raw):
            seen.add(tag)
    return sorted(seen)


def tag_stats(
    session: Session, channel: Optional[str] = None
) -> list[tuple[str, int]]:
    """Return (tag, count) pairs ordered by most common first.

    When ``channel`` is given, only tags from that channel's videos are counted.
    """
    statement = select(Video.tags).where(Video.needs_review == False)  # noqa: E712
    if channel:
        statement = statement.where(Video.channel == channel)
    rows = session.exec(statement).all()
    counts: dict[str, int] = {}
    for raw in rows:
        for tag in parse_tags(raw):
            counts[tag] = counts.get(tag, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def related_videos(
    session: Session,
    video_id: int,
    limit: int = 6,
    *,
    offset: int = 0,
) -> list[Video]:
    """Return related library videos.

    First page (offset < 8) prefers embedding neighbors when AI is ready.
    Later pages use cheaper same-channel / tag / recency signals to cut GPU load.
    """
    source = session.get(Video, video_id)
    if source is None:
        return []

    offset = max(0, offset)
    limit = max(1, min(limit, 24))
    # Build a larger pool then slice for pagination.
    pool_limit = min(50, offset + limit)
    picked: list[Video] = []
    seen: set[int] = {video_id}
    use_ai = offset < 8

    def add_candidates(candidates: list[Video]) -> None:
        for video in candidates:
            if video.id in seen or video.needs_review:
                continue
            seen.add(video.id)
            picked.append(video)
            if len(picked) >= pool_limit:
                return

    if use_ai:
        # 1) Embedding nearest neighbors (soft-boost same channel / tag overlap).
        try:
            from .ai import embeddings as ai_embeddings
            from .ai.provider import get_provider

            if get_provider() is not None:
                centroid = ai_embeddings.video_centroid(session, video_id)
                if centroid is not None:
                    source_tags = {t.lower() for t in parse_tags(source.tags)}
                    hits = ai_embeddings.similar_video_ids(
                        session,
                        centroid,
                        limit=max(pool_limit * 4, 32),
                        exclude_ids={video_id},
                        min_score=0.2,
                    )
                    scored: list[tuple[float, Video]] = []
                    for vid, score in hits:
                        video = session.get(Video, vid)
                        if video is None or video.needs_review:
                            continue
                        boost = 0.0
                        if source.channel and video.channel == source.channel:
                            boost += 0.05
                        if source_tags:
                            row_tags = {t.lower() for t in parse_tags(video.tags)}
                            boost += 0.02 * len(source_tags & row_tags)
                        scored.append((score + boost, video))
                    scored.sort(key=lambda item: item[0], reverse=True)
                    add_candidates([v for _, v in scored])
        except Exception:  # noqa: BLE001
            pass

    if len(picked) < pool_limit and source.channel:
        channel_rows = query_videos(
            session,
            channel=source.channel,
            sort="added_at",
            order="desc",
            needs_review=False,
        )
        add_candidates(channel_rows)

    if len(picked) < pool_limit:
        source_tags = {t.lower() for t in parse_tags(source.tags)}
        if source_tags:
            scored_tags: list[tuple[int, Video]] = []
            for row in query_videos(
                session, needs_review=False, sort="added_at", order="desc"
            ):
                if row.id in seen or row.needs_review:
                    continue
                row_tags = {t.lower() for t in parse_tags(row.tags)}
                overlap = len(source_tags & row_tags)
                if overlap > 0:
                    scored_tags.append((overlap, row))
            scored_tags.sort(
                key=lambda item: (
                    item[0],
                    item[1].added_at or datetime.min.replace(tzinfo=timezone.utc),
                ),
                reverse=True,
            )
            add_candidates([v for _, v in scored_tags])

    if len(picked) < pool_limit:
        pool = query_videos(
            session,
            needs_review=False,
            sort="random",
            seed=video_id,
        )
        add_candidates(pool)

    return picked[offset : offset + limit]

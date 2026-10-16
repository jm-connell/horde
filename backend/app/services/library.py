import json
import logging
import random as py_random
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, func, nullsfirst, nullslast, or_
from sqlmodel import Session, select

from ..models import UserVideoState, Video
from .pagination import PageRequest
from .search_text import keyword_match_clause

logger = logging.getLogger(__name__)

PROGRESS_EXPIRY_DAYS = 14
CONTINUE_WATCHING_DAYS = 7

SORT_COLUMNS = {
    "added_at": Video.added_at,
    "title": Video.title,
    "duration": Video.duration_sec,
    "published_at": Video.published_at,
    "file_size": Video.file_size,
    "view_count": Video.view_count,
    # Watch state is per user; query_videos joins the caller's rows.
    "last_watched_at": UserVideoState.last_watched_at,
}


@dataclass
class ChannelStatRow:
    channel: str
    count: int
    last_download_at: datetime | None
    subscriber_count: int | None
    channel_url: str | None


def parse_tags(raw: str) -> list[str]:
    try:
        value = json.loads(raw)
        return [str(t) for t in value] if isinstance(value, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def dump_tags(tags: list[str]) -> str:
    cleaned = [t.strip() for t in tags if t and t.strip()]
    return json.dumps(cleaned)


def parse_subtitles(raw: str | None) -> list[dict]:
    try:
        value = json.loads(raw or "[]")
        return (
            [t for t in value if isinstance(t, dict)] if isinstance(value, list) else []
        )
    except (json.JSONDecodeError, TypeError):
        return []


def dump_subtitles(tracks: list[dict]) -> str:
    return json.dumps(tracks)


def expire_stale_progress(session: Session) -> None:
    """Reset every user's watch position on videos not watched within the expiry period."""
    from . import user_state
    from .app_settings import load as load_app_settings

    expiry_days = load_app_settings().get("progress_expiry_days", PROGRESS_EXPIRY_DAYS)
    user_state.expire_stale(session, datetime.now(UTC) - timedelta(days=expiry_days))


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


#: The Video attribute each sort key reads (``last_watched_at`` is per user).
_SORT_ATTRS = {
    "added_at": "added_at",
    "title": "title",
    "duration": "duration_sec",
    "published_at": "published_at",
    "file_size": "file_size",
    "view_count": "view_count",
}


def sort_value(video: Video, sort: str, state: UserVideoState | None = None):
    """The value ``video`` sorts by under ``sort``: what a keyset cursor remembers."""
    if sort == "last_watched_at":
        return state.last_watched_at if state is not None else None
    return getattr(video, _SORT_ATTRS.get(sort, "added_at"))


def _keyset_after(statement, sort: str, order: str, page: PageRequest):
    """Order by (sort key, id) and keep only the rows after the cursor's row.

    SQLite sorts NULL before every value when ascending and after every value when
    descending, which is what ``_apply_sort`` asks for on the nullable columns and
    what the other columns do by default, so NULL is handled the same way for all.
    """
    column = SORT_COLUMNS.get(sort, Video.added_at)
    desc = order == "desc"
    statement = statement.order_by(Video.id.desc() if desc else Video.id.asc())
    if not page.has_position:
        return statement
    after_id = page.after_id
    id_after = Video.id < after_id if desc else Video.id > after_id
    value = page.value
    if value is None:
        if desc:
            clause = and_(column.is_(None), id_after)
        else:
            clause = or_(and_(column.is_(None), id_after), column.is_not(None))
    else:
        past = column < value if desc else column > value
        clause = or_(past, and_(column == value, id_after))
        if desc:
            clause = or_(clause, column.is_(None))
    return statement.where(clause)


_ID_CHUNK = 500


def _load_in_order(session: Session, ids: list[int]) -> list[Video]:
    """The videos with these ids, in this order (missing ids are skipped)."""
    found: dict[int, Video] = {}
    for start in range(0, len(ids), _ID_CHUNK):
        chunk = ids[start : start + _ID_CHUNK]
        for video in session.exec(select(Video).where(Video.id.in_(chunk))):  # type: ignore[attr-defined]
            found[video.id] = video
    return [found[i] for i in ids if i in found]


def query_videos(
    session: Session,
    q: str | None = None,
    channel: str | None = None,
    tag: str | None = None,
    sort: str = "added_at",
    order: str = "desc",
    needs_review: bool | None = None,
    continue_watching: bool = False,
    watched_only: bool = False,
    seed: int | None = None,
    user_id: int | None = None,
    page: PageRequest | None = None,
    count_only: bool = False,
) -> list[Video] | int:
    """Library rows, newest first by default.

    With ``page`` the result is that page plus one extra row (so the caller can tell
    whether another page follows); ``count_only`` returns how many rows match.

    Anything that reads watch state (``continue_watching``, ``watched_only``,
    ``sort="last_watched_at"``) needs ``user_id``: history belongs to one user,
    so their rows are outer-joined onto the shared library.
    """
    statement = select(Video)
    if continue_watching or watched_only or sort == "last_watched_at":
        if user_id is None:
            raise ValueError("watch state needs a user_id")
        statement = statement.outerjoin(
            UserVideoState,
            and_(
                UserVideoState.video_id == Video.id,
                UserVideoState.user_id == user_id,
            ),
        )

    if needs_review is not None:
        statement = statement.where(Video.needs_review == needs_review)
    if continue_watching:
        from .app_settings import load as load_app_settings

        settings = load_app_settings()
        cw_days = settings.get("continue_watching_days", CONTINUE_WATCHING_DAYS)
        cw_cutoff = datetime.now(UTC) - timedelta(days=cw_days)
        # Started but not effectively finished (within the last 10% of runtime).
        statement = statement.where(UserVideoState.position_sec >= 30).where(
            (Video.duration_sec.is_(None))
            | (UserVideoState.position_sec < Video.duration_sec * 0.9)
        )
        statement = statement.where(UserVideoState.last_watched_at.is_not(None))
        statement = statement.where(UserVideoState.last_watched_at >= cw_cutoff)
        statement = statement.order_by(UserVideoState.last_watched_at.desc()).limit(12)
        return list(session.exec(statement).all())
    if watched_only:
        statement = statement.where(UserVideoState.last_watched_at.is_not(None))
    if channel:
        statement = statement.where(Video.channel == channel)
    if q:
        clause = keyword_match_clause(
            q,
            Video.title,
            Video.description,
            Video.channel,
            Video.notes,
            Video.tags,
        )
        if clause is not None:
            statement = statement.where(clause)
    if tag:
        # Tags are stored as a JSON list string; match the quoted token.
        statement = statement.where(Video.tags.ilike(f'%"{tag}"%'))

    if count_only:
        total = session.scalar(select(func.count()).select_from(statement.subquery()))
        return int(total or 0)

    statement, is_random = _apply_sort(statement, sort, order)
    if is_random:
        # Shuffle ids only: a page needs one position in the shuffle, not every row.
        ids = list(
            session.exec(statement.with_only_columns(Video.id).order_by(Video.id))
        )
        rng = py_random.Random(seed)  # noqa: S311 - seeded shuffle for stable UI ordering, not security
        rng.shuffle(ids)
        if page is not None:
            ids = ids[page.offset : page.offset + page.fetch]
        return _load_in_order(session, ids)
    if page is not None:
        statement = _keyset_after(statement, sort, order, page).limit(page.fetch)
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
        .where(Video.needs_review == False)  # noqa: E712 - SQL column comparison, not a Python truth test
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
            return datetime.min.replace(tzinfo=UTC)
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


def resolve_channel_url(session: Session, channel_name: str) -> str | None:
    """Return a canonical channel URL for a library channel name, if known."""
    for row in channel_stats(session):
        if row.channel == channel_name and row.channel_url:
            return row.channel_url
    return None


def find_video_by_youtube_id(session: Session, yt_id: str) -> Video | None:
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


def _iso_published(value: datetime | None) -> str | None:
    if value is None:
        return None
    dt = value if getattr(value, "tzinfo", None) else value.replace(tzinfo=UTC)
    return dt.isoformat() if hasattr(dt, "isoformat") else str(dt)


def youtube_library_map(
    session: Session, channel: str | None = None
) -> dict[str, tuple[int, int | None, int | None, str | None]]:
    """Map YouTube IDs to (library_id, height_px, view_count, published_at ISO)."""
    from urllib.parse import urlparse

    from .url_clean import _youtube_video_id

    statement = select(
        Video.id,
        Video.source_url,
        Video.height_px,
        Video.view_count,
        Video.file_path,
        Video.published_at,
    )
    if channel:
        statement = statement.where(Video.channel == channel)
    mapping: dict[str, tuple[int, int | None, int | None, str | None]] = {}
    for (
        video_id,
        source_url,
        height_px,
        views,
        file_path,
        published_at,
    ) in session.exec(statement).all():
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
                _iso_published(published_at),
            )
    return mapping


def all_tags(session: Session) -> list[str]:
    rows = session.exec(select(Video.tags)).all()
    seen: set[str] = set()
    for raw in rows:
        for tag in parse_tags(raw):
            seen.add(tag)
    return sorted(seen)


def tag_stats(session: Session, channel: str | None = None) -> list[tuple[str, int]]:
    """Return (tag, count) pairs ordered by most common first.

    When ``channel`` is given, only tags from that channel's videos are counted.
    """
    statement = select(Video.tags).where(Video.needs_review == False)  # noqa: E712 - SQL column comparison, not a Python truth test
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
            from .ai.provider import get_embed_provider

            if get_embed_provider() is not None:
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
        except Exception:
            logger.debug(
                "embedding-based related videos unavailable for video %s",
                source.id,
                exc_info=True,
            )

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
                    item[1].added_at or datetime.min.replace(tzinfo=UTC),
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

import bisect
import json
import logging
import math
import random as py_random
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, overload

from sqlalchemy import and_, func, nullsfirst, nullslast, or_, text
from sqlalchemy import select as sa_select
from sqlalchemy.orm import Mapped
from sqlmodel import Session, col, select

from ..models import ChannelRetention, UserVideoState, Video, VideoTag, require_id
from .pagination import PageRequest, random_key
from .search_text import fts_match_expression, keyword_match_clause

logger = logging.getLogger(__name__)

PROGRESS_EXPIRY_DAYS = 14
CONTINUE_WATCHING_DAYS = 7

SORT_COLUMNS: dict[str, Mapped[Any]] = {
    "added_at": col(Video.added_at),
    "title": col(Video.title),
    "duration": col(Video.duration_sec),
    "published_at": col(Video.published_at),
    "file_size": col(Video.file_size),
    "view_count": col(Video.view_count),
    # Watch state is per user; query_videos joins the caller's rows.
    "last_watched_at": col(UserVideoState.last_watched_at),
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
    except json.JSONDecodeError, TypeError:
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
    except json.JSONDecodeError, TypeError:
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

    column = SORT_COLUMNS.get(sort, col(Video.added_at))
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


def sort_value(
    video: Video, sort: str, state: UserVideoState | None = None, seed: int = 0
):
    """The value ``video`` sorts by under ``sort``: what a keyset cursor remembers."""
    if sort == "random":
        return random_key(seed, require_id(video))
    if sort == "last_watched_at":
        return state.last_watched_at if state is not None else None
    return getattr(video, _SORT_ATTRS.get(sort, "added_at"))


def _keyset_after(statement, sort: str, order: str, page: PageRequest):
    """Order by (sort key, id) and keep only the rows after the cursor's row.

    SQLite sorts NULL before every value when ascending and after every value when
    descending, which is what ``_apply_sort`` asks for on the nullable columns and
    what the other columns do by default, so NULL is handled the same way for all.
    """
    column = SORT_COLUMNS.get(sort, col(Video.added_at))
    desc = order == "desc"
    statement = statement.order_by(
        col(Video.id).desc() if desc else col(Video.id).asc()
    )
    if not page.has_position:
        return statement
    after_id = page.after_id
    id_after = col(Video.id) < after_id if desc else col(Video.id) > after_id
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
        for video in session.exec(select(Video).where(col(Video.id).in_(chunk))):
            found[require_id(video)] = video
    return [found[i] for i in ids if i in found]


def has_fts(session: Session) -> bool:
    """True when the ``videos_fts`` index exists (SQLite built with FTS5)."""
    return (
        session.connection()
        .exec_driver_sql("SELECT 1 FROM sqlite_master WHERE name = 'videos_fts'")
        .first()
        is not None
    )


def _keyword_clause(session: Session, query: str):
    """WHERE clause for a keyword search over title, description, notes, channel, tags.

    Uses the FTS5 index when present (each query token is a whole word or one of
    its light inflections, AND across tokens). A query with no word characters
    (``"!!"``) and databases without FTS5 fall back to the REGEXP scan, which
    escapes the query, so ``%`` and ``_`` are never wildcards.
    """
    match = fts_match_expression(query) if has_fts(session) else None
    if match is not None:
        return col(Video.id).in_(
            text(
                "SELECT rowid FROM videos_fts WHERE videos_fts MATCH :fts_q"
            ).bindparams(fts_q=match)
        )
    return keyword_match_clause(
        query,
        Video.title,
        Video.description,
        Video.channel,
        Video.notes,
        Video.tags,
    )


@overload
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
    *,
    count_only: Literal[True],
) -> int: ...


@overload
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
    count_only: Literal[False] = False,
) -> list[Video]: ...


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
                col(UserVideoState.video_id) == col(Video.id),
                col(UserVideoState.user_id) == user_id,
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
            (col(Video.duration_sec).is_(None))
            | (col(UserVideoState.position_sec) < col(Video.duration_sec) * 0.9)
        )
        statement = statement.where(col(UserVideoState.last_watched_at).is_not(None))
        statement = statement.where(col(UserVideoState.last_watched_at) >= cw_cutoff)
        statement = statement.order_by(
            col(UserVideoState.last_watched_at).desc()
        ).limit(12)
        return list(session.exec(statement).all())
    if watched_only:
        statement = statement.where(col(UserVideoState.last_watched_at).is_not(None))
    if channel:
        statement = statement.where(Video.channel == channel)
    if q:
        clause = _keyword_clause(session, q)
        if clause is not None:
            statement = statement.where(clause)
    if tag:
        statement = statement.where(
            col(Video.id).in_(
                select(col(VideoTag.video_id)).where(col(VideoTag.tag) == tag)
            )
        )

    if count_only:
        total = session.scalar(select(func.count()).select_from(statement.subquery()))
        return int(total or 0)

    statement, is_random = _apply_sort(statement, sort, order)
    if is_random:
        # Order ids by a keyed hash: a page needs a position in the shuffle, not
        # every row, and one video's position does not depend on the others.
        ids = list(session.exec(statement.with_only_columns(Video.id)))
        shuffle_seed = (
            seed if seed is not None else py_random.SystemRandom().randrange(2**31)
        )
        keyed = sorted((random_key(shuffle_seed, i), i) for i in ids)
        if page is not None:
            if page.has_position:
                keyed = keyed[bisect.bisect_right(keyed, (page.value, page.after_id)) :]
            keyed = keyed[: page.fetch]
        return _load_in_order(session, [i for _, i in keyed])
    if page is not None:
        statement = _keyset_after(statement, sort, order, page).limit(page.fetch)
    return list(session.exec(statement).all())


@dataclass
class ChannelRenamed:
    """What a channel rename did."""

    updated: int
    # A retention rule that was on was turned off because the rename merged two
    # channels (see ``rename_channel``).
    retention_disabled: bool = False
    # The videos that now carry the new name.
    video_ids: list[int] = field(default_factory=list)


def rename_channel(session: Session, old_name: str, new_name: str) -> ChannelRenamed:
    """Rename a channel across all videos, returning how many rows were updated.

    The retention rule follows the name. A rename onto a name that already has
    videos or a rule merges two channels, and a rule written for one of them
    must not silently apply to the other's videos, so every rule involved
    (the moving one and the target's own) is turned off. When both channels
    have a rule, the target's stays and the old name's is dropped.
    """
    rows = session.exec(select(Video).where(Video.channel == old_name)).all()
    rename = new_name != old_name
    merged = rename and (
        session.exec(select(col(Video.id)).where(Video.channel == new_name)).first()
        is not None
    )
    for video in rows:
        video.channel = new_name
        session.add(video)
    rule = session.exec(
        select(ChannelRetention).where(col(ChannelRetention.channel) == old_name)
    ).first()
    target = session.exec(
        select(ChannelRetention).where(col(ChannelRetention.channel) == new_name)
    ).first()
    disabled = False
    if rename:
        if target is not None:
            merged = True
        if rule is not None:
            if target is None:
                rule.channel = new_name
                session.add(rule)
            else:
                session.delete(rule)
                disabled = rule.enabled
        if merged:
            for involved in (rule if target is None else None, target):
                if involved is not None and involved.enabled:
                    involved.enabled = False
                    session.add(involved)
                    disabled = True
    if rows or rule is not None or disabled:
        session.commit()
    return ChannelRenamed(
        updated=len(rows),
        retention_disabled=disabled,
        video_ids=[require_id(v) for v in rows],
    )


def channel_stats(
    session: Session,
    sort: str = "recent_download",
    order: str = "desc",
) -> list[ChannelStatRow]:
    statement = (
        sa_select(  # sqlmodel's select stops at four columns
            col(Video.channel),
            func.count(col(Video.id)),
            func.max(col(Video.added_at)),
            func.max(col(Video.channel_subscriber_count)),
            func.max(col(Video.channel_url)),
        )
        .where(col(Video.channel).is_not(None))
        .where(col(Video.needs_review) == False)  # noqa: E712 - SQL column comparison, not a Python truth test
        .group_by(col(Video.channel))
    )
    rows = [
        ChannelStatRow(
            channel=c,
            count=int(n),
            last_download_at=last_dl,
            subscriber_count=int(sub) if sub is not None else None,
            channel_url=url,
        )
        for c, n, last_dl, sub, url in session.execute(statement).all()
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
    """Find a library video by YouTube id (indexed ``videos.youtube_id``)."""
    if not yt_id:
        return None
    return session.exec(
        select(Video)
        .where(col(Video.youtube_id) == yt_id)
        .order_by(col(Video.id))
        .limit(1)
    ).first()


def _iso_published(value: datetime | None) -> str | None:
    if value is None:
        return None
    dt = value if getattr(value, "tzinfo", None) else value.replace(tzinfo=UTC)
    return dt.isoformat() if hasattr(dt, "isoformat") else str(dt)


def youtube_library_map(
    session: Session, channel: str | None = None
) -> dict[str, tuple[int, int | None, int | None, str | None]]:
    """Map YouTube IDs to (library_id, height_px, view_count, published_at ISO)."""
    statement = sa_select(  # sqlmodel's select stops at four columns
        col(Video.youtube_id),
        col(Video.id),
        col(Video.height_px),
        col(Video.view_count),
        col(Video.published_at),
    ).where(col(Video.youtube_id).is_not(None))
    if channel:
        statement = statement.where(col(Video.channel) == channel)
    mapping: dict[str, tuple[int, int | None, int | None, str | None]] = {}
    for yt_id, video_id, height_px, views, published_at in session.execute(
        statement.order_by(col(Video.id))
    ).all():
        mapping[yt_id] = (
            int(video_id),
            int(height_px) if height_px else None,
            int(views) if views is not None else None,
            _iso_published(published_at),
        )
    return mapping


def all_tags(session: Session) -> list[str]:
    # Join videos: a tag row whose video is gone (written by code that ran with
    # foreign keys off) must not show up as a library tag.
    rows = session.exec(
        select(VideoTag.tag)
        .join(Video, col(Video.id) == col(VideoTag.video_id))
        .distinct()
    ).all()
    return sorted(rows)


def tag_stats(session: Session, channel: str | None = None) -> list[tuple[str, int]]:
    """Return (tag, count) pairs ordered by most common first.

    Counts videos (a tag held under two sources counts once). When ``channel``
    is given, only tags from that channel's videos are counted.
    """
    count = func.count(func.distinct(VideoTag.video_id))
    statement = (
        select(VideoTag.tag, count)
        .join(Video, col(Video.id) == col(VideoTag.video_id))
        .where(Video.needs_review == False)  # noqa: E712 - SQL column comparison, not a Python truth test
    )
    if channel:
        statement = statement.where(Video.channel == channel)
    rows = session.exec(statement.group_by(VideoTag.tag)).all()
    return sorted(((tag, int(n)) for tag, n in rows), key=lambda kv: (-kv[1], kv[0]))


_RELATED_MIN_SCORE = 0.2
# Nearest neighbours re-ranked with the boosts below. Fixed, so every page
# slices the same ranking (pages reach 48 videos; boosts move items at most 0.18).
_RELATED_CANDIDATES = 200
_RELATED_SAME_CHANNEL_BOOST = 0.05
# Per shared tag, scaled by its rarity in the library (0..1), and capped.
_RELATED_TAG_BOOST = 0.03
_RELATED_TAG_BOOST_MAX = 0.08
_RELATED_WATCHED_PENALTY = 0.05


def _tag_rarity(session: Session, tags: set[str]) -> dict[str, float]:
    """How distinctive each tag is: 1 for a tag on one video, near 0 for one on most."""
    if not tags:
        return {}
    total = session.exec(
        select(func.count(col(Video.id))).where(Video.needs_review == False)  # noqa: E712 - SQL column comparison, not a Python truth test
    ).one()
    rows = session.exec(
        select(VideoTag.tag, func.count(func.distinct(VideoTag.video_id)))
        .where(col(VideoTag.tag).in_(tags))
        .group_by(col(VideoTag.tag))
    ).all()
    scale = math.log(max(int(total), 2))
    return {
        tag.lower(): max(0.0, math.log(max(int(total), 1) / max(int(n), 1)) / scale)
        for tag, n in rows
    }


def _embedding_related(
    session: Session, source: Video, user_id: int | None
) -> list[Video]:
    """Embedding neighbours of ``source``, best first (empty without AI)."""
    from .ai import vector_index
    from .ai.provider import get_embed_provider
    from .user_state import get_states

    source_id = require_id(source)
    if get_embed_provider() is None:
        return []
    profile = vector_index.profile_vectors(session, [source_id]).get(source_id)
    if profile is None:
        return []
    video_ids, sims = vector_index.video_scores(session, [profile])
    best = {
        int(video_ids[i]): float(sims[i, 0])
        for i in sims[:, 0].argsort()[::-1][: _RELATED_CANDIDATES + 1]
        if sims[i, 0] >= _RELATED_MIN_SCORE and int(video_ids[i]) != source_id
    }
    rows = session.exec(
        select(Video).where(
            col(Video.id).in_(list(best)),
            Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
        )
    ).all()
    candidates = sorted(
        ((best[require_id(v)], v) for v in rows),
        key=lambda item: (-item[0], require_id(item[1])),
    )

    source_tags = {t.lower() for t in parse_tags(source.tags)}
    rarity = _tag_rarity(session, source_tags)
    states = (
        get_states(session, user_id, [require_id(v) for _, v in candidates])
        if user_id is not None
        else {}
    )
    scored: list[tuple[float, Video]] = []
    for score, video in candidates:
        boost = 0.0
        if source.channel and video.channel == source.channel:
            boost += _RELATED_SAME_CHANNEL_BOOST
        shared = source_tags & {t.lower() for t in parse_tags(video.tags)}
        if shared:
            weight = sum(rarity.get(t, 0.0) for t in shared)
            boost += min(_RELATED_TAG_BOOST_MAX, _RELATED_TAG_BOOST * weight)
        state = states.get(require_id(video))
        if state is not None and state.last_watched_at is not None:
            boost -= _RELATED_WATCHED_PENALTY
        scored.append((score + boost, video))
    scored.sort(key=lambda item: (-item[0], require_id(item[1])))
    return [v for _, v in scored]


def related_videos(
    session: Session,
    video_id: int,
    limit: int = 6,
    *,
    offset: int = 0,
    user_id: int | None = None,
) -> list[Video]:
    """Return related library videos.

    Ranked by embedding similarity of the whole videos when AI is ready,
    nudged up for the same channel and for shared tags (rare tags count more),
    and down for videos ``user_id`` has already watched. Same-channel, shared-tag
    and random videos fill the rest. Every page slices the same ranking.
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

    def add_candidates(candidates: list[Video]) -> None:
        for video in candidates:
            if video.id is None or video.id in seen or video.needs_review:
                continue
            seen.add(video.id)
            picked.append(video)
            if len(picked) >= pool_limit:
                return

    try:
        add_candidates(_embedding_related(session, source, user_id))
    except Exception:
        logger.warning(
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
        source_tag_names = list(
            session.exec(
                select(VideoTag.tag).where(VideoTag.video_id == video_id).distinct()
            ).all()
        )
        if source_tag_names:
            overlap = func.count(func.distinct(VideoTag.tag))
            tagged = session.exec(
                select(Video)
                .join(VideoTag, col(VideoTag.video_id) == col(Video.id))
                .where(col(VideoTag.tag).in_(source_tag_names))
                .where(Video.needs_review == False)  # noqa: E712 - SQL column comparison, not a Python truth test
                .where(col(Video.id).not_in(seen))
                .group_by(col(Video.id))
                .order_by(overlap.desc(), col(Video.added_at).desc())
                .limit(pool_limit)
            ).all()
            add_candidates(list(tagged))

    if len(picked) < pool_limit:
        pool = query_videos(
            session,
            needs_review=False,
            sort="random",
            seed=video_id,
        )
        add_candidates(pool)

    return picked[offset : offset + limit]

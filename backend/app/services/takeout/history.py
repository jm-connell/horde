"""A user's imported YouTube watch history (``youtube_watch_events``).

Written only by ``store_views`` from a Takeout import (``parse.py``); every row
belongs to one Horde account. Read by recommendations (``profile``), channel
pages (``watched_among``), the Download page (``rewatched_page``) and, when the
user opts in, the History stats (``watch_stats``).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import delete, func
from sqlalchemy import select as sa_select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session, col, select

from ...models import Video, YoutubeWatchEvent, as_utc, utcnow
from .parse import WatchView

_CHUNK = 500
#: A channel's pull halves every this many days since the view (recent taste wins).
RECENT_HALF_LIFE_DAYS = 30.0
#: Views at least this old make up the "throwback" side of the taste.
THROWBACK_MIN_AGE_DAYS = 180
#: Views needed before a video counts as rewatched (Download page suggestions).
REWATCH_MIN_VIEWS = 2


@dataclass(frozen=True)
class StoreResult:
    views_in_file: int
    new_views: int
    total_views: int


def store_views(session: Session, user_id: int, views: list[WatchView]) -> StoreResult:
    """Add ``views`` to the user's history; a view already stored is skipped."""
    before = count_views(session, user_id)
    now = utcnow()
    rows = [
        {
            "user_id": user_id,
            "yt_id": v.yt_id,
            # Always UTC, so the unique key matches the same view on every import.
            "watched_at": v.watched_at.astimezone(UTC),
            "title": v.title,
            "channel": v.channel,
            "channel_url": v.channel_url,
            "imported_at": now,
        }
        for v in views
    ]
    for start in range(0, len(rows), _CHUNK):
        statement = sqlite_insert(YoutubeWatchEvent).values(
            rows[start : start + _CHUNK]
        )
        session.execute(statement.on_conflict_do_nothing())
    session.commit()
    after = count_views(session, user_id)
    return StoreResult(len(views), after - before, after)


def count_views(session: Session, user_id: int) -> int:
    return int(
        session.scalar(
            select(func.count()).where(col(YoutubeWatchEvent.user_id) == user_id)
        )
        or 0
    )


@dataclass(frozen=True)
class Summary:
    total_views: int
    distinct_videos: int
    first_watched_at: datetime | None
    last_watched_at: datetime | None
    last_imported_at: datetime | None


def summary(session: Session, user_id: int) -> Summary:
    total, distinct, first, last, imported = session.execute(
        sa_select(
            func.count(),
            func.count(func.distinct(col(YoutubeWatchEvent.yt_id))),
            func.min(col(YoutubeWatchEvent.watched_at)),
            func.max(col(YoutubeWatchEvent.watched_at)),
            func.max(col(YoutubeWatchEvent.imported_at)),
        ).where(col(YoutubeWatchEvent.user_id) == user_id)
    ).one()
    return Summary(
        total_views=int(total or 0),
        distinct_videos=int(distinct or 0),
        first_watched_at=as_utc(first),
        last_watched_at=as_utc(last),
        last_imported_at=as_utc(imported),
    )


def clear(session: Session, user_id: int) -> int:
    """Forget every imported view of this user; returns how many there were."""
    removed = count_views(session, user_id)
    session.execute(
        delete(YoutubeWatchEvent).where(col(YoutubeWatchEvent.user_id) == user_id)
    )
    session.commit()
    return removed


def watched_among(session: Session, user_id: int, yt_ids: Iterable[str]) -> set[str]:
    """The ids in ``yt_ids`` this user has watched on YouTube."""
    wanted = list({i for i in yt_ids if i})
    found: set[str] = set()
    for start in range(0, len(wanted), _CHUNK):
        found.update(
            session.exec(
                select(YoutubeWatchEvent.yt_id)
                .where(
                    col(YoutubeWatchEvent.user_id) == user_id,
                    col(YoutubeWatchEvent.yt_id).in_(wanted[start : start + _CHUNK]),
                )
                .distinct()
            ).all()
        )
    return found


@dataclass(frozen=True)
class Rewatched:
    yt_id: str
    views: int
    last_watched_at: datetime
    title: str | None
    channel: str | None
    channel_url: str | None


def rewatched_page(
    session: Session, user_id: int, *, offset: int, limit: int
) -> tuple[list[Rewatched], bool]:
    """Videos watched at least ``REWATCH_MIN_VIEWS`` times and not in the library.

    Most views first, then the most recently watched. Returns the page and
    whether more follow.
    """
    views = func.count().label("views")
    last = func.max(col(YoutubeWatchEvent.watched_at)).label("last")
    in_library = select(col(Video.youtube_id)).where(col(Video.youtube_id).is_not(None))
    rows = session.exec(
        select(col(YoutubeWatchEvent.yt_id), views, last)
        .where(
            col(YoutubeWatchEvent.user_id) == user_id,
            col(YoutubeWatchEvent.yt_id).not_in(in_library),
        )
        .group_by(col(YoutubeWatchEvent.yt_id))
        .having(views >= REWATCH_MIN_VIEWS)
        .order_by(views.desc(), last.desc(), col(YoutubeWatchEvent.yt_id))
        .offset(offset)
        .limit(limit + 1)
    ).all()
    more = len(rows) > limit
    rows = rows[:limit]
    details = latest_details(session, user_id, [r[0] for r in rows])
    out = []
    for yt_id, count, when in rows:
        title, channel, channel_url = details.get(yt_id, (None, None, None))
        out.append(
            Rewatched(
                yt_id=yt_id,
                views=int(count),
                last_watched_at=as_utc(when),
                title=title,
                channel=channel,
                channel_url=channel_url,
            )
        )
    return out, more


def latest_details(
    session: Session, user_id: int, yt_ids: list[str]
) -> dict[str, tuple[str | None, str | None, str | None]]:
    """Title and channel of each video, from its most recent view that names them."""
    out: dict[str, tuple[str | None, str | None, str | None]] = {}
    if not yt_ids:
        return out
    for yt_id, title, channel, channel_url in session.exec(
        select(
            YoutubeWatchEvent.yt_id,
            YoutubeWatchEvent.title,
            YoutubeWatchEvent.channel,
            YoutubeWatchEvent.channel_url,
        )
        .where(
            col(YoutubeWatchEvent.user_id) == user_id,
            col(YoutubeWatchEvent.yt_id).in_(yt_ids),
        )
        .order_by(col(YoutubeWatchEvent.watched_at).desc())
    ).all():
        if yt_id not in out or (out[yt_id][0] is None and title):
            out[yt_id] = (title, channel, channel_url)
    return out


# --- what recommendations read ------------------------------------------------


@dataclass
class ChannelTaste:
    """One channel the user watches on YouTube."""

    name: str | None
    url: str | None
    #: Views weighted by age (halving every ``RECENT_HALF_LIFE_DAYS``).
    recent: float = 0.0
    #: Views at least ``THROWBACK_MIN_AGE_DAYS`` old, unweighted.
    old_views: int = 0
    views: int = 0


@dataclass
class Profile:
    """What the imported history says, for "For you"."""

    watched: set[str] = field(default_factory=set)
    #: Channels by key (normalized URL, else ``name:<casefolded name>``).
    channels: dict[str, ChannelTaste] = field(default_factory=dict)
    #: Distinct videos newest first, with when each was last watched.
    recent_videos: list[tuple[str, datetime]] = field(default_factory=list)
    #: Distinct videos last watched at least ``THROWBACK_MIN_AGE_DAYS`` ago.
    old_videos: list[tuple[str, datetime]] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.watched


def channel_key(url: str | None, name: str | None) -> str | None:
    if url:
        return url
    if name and name.strip():
        return f"name:{name.strip().casefold()}"
    return None


def profile(session: Session, user_id: int, now: datetime | None = None) -> Profile:
    """The user's imported history folded into channel taste and seed videos."""
    now = as_utc(now or utcnow())
    out = Profile()
    last_seen: dict[str, datetime] = {}
    rows = session.exec(
        select(
            YoutubeWatchEvent.yt_id,
            YoutubeWatchEvent.watched_at,
            YoutubeWatchEvent.channel,
            YoutubeWatchEvent.channel_url,
        ).where(col(YoutubeWatchEvent.user_id) == user_id)
    ).all()
    tastes: dict[str, ChannelTaste] = defaultdict(lambda: ChannelTaste(None, None))
    for yt_id, watched_at, channel, channel_url in rows:
        when = as_utc(watched_at)
        out.watched.add(yt_id)
        if yt_id not in last_seen or when > last_seen[yt_id]:
            last_seen[yt_id] = when
        key = channel_key(channel_url, channel)
        if key is None:
            continue
        taste = tastes[key]
        taste.name = taste.name or channel
        taste.url = taste.url or channel_url
        days = max(0.0, (now - when).total_seconds() / 86400)
        taste.recent += 0.5 ** (days / RECENT_HALF_LIFE_DAYS)
        taste.views += 1
        if days >= THROWBACK_MIN_AGE_DAYS:
            taste.old_views += 1
    out.channels = dict(tastes)
    ordered = sorted(last_seen.items(), key=lambda kv: kv[1], reverse=True)
    out.recent_videos = ordered
    out.old_videos = [
        (yt_id, when)
        for yt_id, when in ordered
        if (now - when).days >= THROWBACK_MIN_AGE_DAYS
    ]
    return out

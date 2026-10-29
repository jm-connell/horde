"""A user's imported YouTube watch history (``youtube_watch_events``).

Written only by ``store_views`` from a Takeout import (``parse.py``); every row
belongs to one Horde account. Read by recommendations (``profile``), channel
pages (``watched_among``), the Download page (``rewatched_page``) and, when the
user opts in, the History stats (``watch_stats``).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import bindparam, delete, func
from sqlalchemy import select as sa_select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session, col, select

from ... import context as app_context
from ...models import Video, YoutubeWatchEvent, as_utc, utcnow
from .parse import WatchView

_CHUNK = 2000
#: ``IN (...)`` lists stay under SQLite's bound-parameter limit.
_IN_CHUNK = 500
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
    """Add ``views`` to the user's history; a view already stored is skipped.

    Commits every chunk, so a big import never holds SQLite's write lock for
    long (downloads and progress saves keep going meanwhile); a chunk stored
    before a failure is simply skipped by the next import.
    """
    before = count_views(session, user_id)
    now = utcnow()
    statement = (
        sqlite_insert(YoutubeWatchEvent)
        .values(
            user_id=bindparam("user_id"),
            yt_id=bindparam("yt_id"),
            watched_at=bindparam("watched_at"),
            title=bindparam("title"),
            channel=bindparam("channel"),
            channel_url=bindparam("channel_url"),
            imported_at=bindparam("imported_at"),
        )
        .on_conflict_do_nothing()
    )
    rows = [
        {
            "user_id": user_id,
            "yt_id": v.yt_id,
            # Whole seconds in UTC: the JSON export has milliseconds and the
            # HTML one does not, and the unique key must match either way.
            "watched_at": v.watched_at.astimezone(UTC).replace(microsecond=0),
            "title": v.title,
            "channel": v.channel,
            "channel_url": v.channel_url,
            "imported_at": now,
        }
        for v in views
    ]
    for start in range(0, len(rows), _CHUNK):
        session.execute(statement, rows[start : start + _CHUNK])
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
    for start in range(0, len(wanted), _IN_CHUNK):
        found.update(
            session.exec(
                select(YoutubeWatchEvent.yt_id)
                .where(
                    col(YoutubeWatchEvent.user_id) == user_id,
                    col(YoutubeWatchEvent.yt_id).in_(wanted[start : start + _IN_CHUNK]),
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


@dataclass(frozen=True)
class RecentVideo:
    """A video watched on YouTube, its newest view first."""

    yt_id: str
    last_watched_at: datetime
    views: int
    title: str | None
    channel: str | None
    channel_url: str | None


def recent_videos(session: Session, user_id: int, *, limit: int) -> list[RecentVideo]:
    """The ``limit`` videos watched on YouTube most lately, one row each."""
    last = func.max(col(YoutubeWatchEvent.watched_at))
    rows = session.execute(
        sa_select(col(YoutubeWatchEvent.yt_id), last, func.count())
        .where(col(YoutubeWatchEvent.user_id) == user_id)
        .group_by(col(YoutubeWatchEvent.yt_id))
        .order_by(last.desc())
        .limit(limit)
    ).all()
    details = latest_details(session, user_id, [str(r[0]) for r in rows])
    out = []
    for yt_id, when, views in rows:
        title, channel, channel_url = details.get(str(yt_id), (None, None, None))
        out.append(
            RecentVideo(
                str(yt_id), as_utc(when), int(views), title, channel, channel_url
            )
        )
    return out


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
    #: The ``PROFILE_VIDEOS`` videos watched last, newest first, with when.
    recent_videos: list[tuple[str, datetime]] = field(default_factory=list)
    #: The same for videos last watched at least ``THROWBACK_MIN_AGE_DAYS`` ago.
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


#: How long a computed profile is reused while the history stays unchanged
#: (the decay moves by well under 1% in that time).
PROFILE_TTL_SEC = 600.0


class ProfileCache:
    """Each user's last ``profile``, reused while their history is unchanged.

    Held on the ``AppContext`` (``caches``), so tests start from an empty one.
    For you asks for the profile on every page of its infinite scroll.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[int, tuple[tuple[object, ...], float, Profile]] = {}

    def get(self, user_id: int, stamp: tuple[object, ...]) -> Profile | None:
        with self._lock:
            found = self._items.get(user_id)
        if found is None or found[0] != stamp:
            return None
        if time.monotonic() - found[1] > PROFILE_TTL_SEC:
            return None
        return found[2]

    def put(self, user_id: int, stamp: tuple[object, ...], value: Profile) -> None:
        with self._lock:
            self._items[user_id] = (stamp, time.monotonic(), value)


def cached_profile(session: Session, user_id: int) -> Profile:
    """``profile``, reused until an import or a clear changes the history."""
    stamp = tuple(
        session.execute(
            sa_select(func.count(), func.max(col(YoutubeWatchEvent.imported_at))).where(
                col(YoutubeWatchEvent.user_id) == user_id
            )
        ).one()
    )
    cache: ProfileCache = app_context.current().caches.setdefault(
        "takeout_profiles", ProfileCache()
    )
    found = cache.get(user_id, stamp)
    if found is None:
        found = profile(session, user_id)
        cache.put(user_id, stamp, found)
    return found


#: Newest (and oldest-but-not-forgotten) videos ``profile`` hands back as seeds.
PROFILE_VIDEOS = 60


def profile(session: Session, user_id: int, now: datetime | None = None) -> Profile:
    """The user's imported history folded into channel taste and seed videos.

    Aggregated in SQL (views per channel and day, the last view per video), so
    a history of a few hundred thousand views costs a few grouped scans.
    """
    now = as_utc(now or utcnow())
    mine = col(YoutubeWatchEvent.user_id) == user_id
    out = Profile()
    out.watched = set(
        session.exec(select(YoutubeWatchEvent.yt_id).where(mine).distinct()).all()
    )
    if not out.watched:
        return out

    # Views of the last ``THROWBACK_MIN_AGE_DAYS`` per channel and day; older
    # ones (their recent pull is at most 1/64 by then) per channel and month.
    cutoff = now - timedelta(days=THROWBACK_MIN_AGE_DAYS)
    stamp = col(YoutubeWatchEvent.watched_at)
    tastes: dict[str, ChannelTaste] = {}
    for bucket, window, old in (
        (func.date(stamp), stamp >= cutoff, False),
        (func.strftime("%Y-%m-15", stamp), stamp < cutoff, True),
    ):
        for channel_url, channel, when, count in session.execute(
            sa_select(
                col(YoutubeWatchEvent.channel_url),
                col(YoutubeWatchEvent.channel),
                bucket,
                func.count(),
            )
            .where(mine, window)
            .group_by(
                col(YoutubeWatchEvent.channel_url),
                col(YoutubeWatchEvent.channel),
                bucket,
            )
        ).all():
            key = channel_key(channel_url, channel)
            if key is None:
                continue
            taste = tastes.setdefault(key, ChannelTaste(None, None))
            taste.name = taste.name or channel
            taste.url = taste.url or channel_url
            noon = datetime.fromisoformat(str(when)).replace(hour=12, tzinfo=UTC)
            days = max(0.0, (now - noon).total_seconds() / 86400)
            taste.recent += int(count) * 0.5 ** (days / RECENT_HALF_LIFE_DAYS)
            taste.views += int(count)
            if old:
                taste.old_views += int(count)
    out.channels = tastes

    last = func.max(col(YoutubeWatchEvent.watched_at))
    newest = (
        sa_select(col(YoutubeWatchEvent.yt_id), last)
        .where(mine)
        .group_by(col(YoutubeWatchEvent.yt_id))
        .order_by(last.desc())
        .limit(PROFILE_VIDEOS)
    )
    out.recent_videos = [
        (str(yt_id), as_utc(when)) for yt_id, when in session.execute(newest).all()
    ]
    out.old_videos = [
        (str(yt_id), as_utc(when))
        for yt_id, when in session.execute(newest.having(last < cutoff)).all()
    ]
    return out

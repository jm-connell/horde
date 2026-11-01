"""One watch history across library videos, streamed videos and the YouTube import.

Horde keeps three records of what a user watched: ``user_video_state`` (library
videos), ``user_stream_state`` (videos played without downloading) and
``youtube_watch_events`` (views imported from Google Takeout). The History page
lists them as one timeline, one row per video at its latest watch, keyed the
way recommendations name a video (``discovery.history.library_key``: the
YouTube id, else ``video:<id>``).

Removing a row removes every record of that video for the user, so it counts
as unwatched again (watch time totals in ``user_watch_time`` stay: they are
history of time spent, not of what is "watched"). Marking a row "don't use for
recommendations" keeps it in the history, still counted as watched, but leaves
it out of the taste every recommendation shelf reads (``rec_feedback`` kind
``taste``).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import Select, String, and_, cast, func, literal, union_all
from sqlalchemy import select as sa_select
from sqlmodel import Session, col, delete, select

from ..models import (
    RecFeedback,
    UserStreamState,
    UserVideoState,
    Video,
    YoutubeWatchEvent,
    as_utc,
    require_id,
)
from .discovery import feedback
from .discovery.history import library_fraction, library_key, stream_fraction
from .takeout import history as takeout_history

#: The newest imported YouTube views that may join Continue watching.
CONTINUE_YOUTUBE_MAX = 5


@dataclass
class Entry:
    """One video in the user's history, at its latest watch."""

    key: str
    watched_at: datetime
    #: Where it was watched: library | stream | youtube (newest first).
    sources: list[str] = field(default_factory=list)
    video_id: int | None = None
    yt_id: str | None = None
    title: str | None = None
    channel: str | None = None
    channel_url: str | None = None
    duration: float | None = None
    #: How far the latest Horde watch got (0..1); None for a YouTube view.
    fraction: float | None = None
    #: Views imported from YouTube (0 when none).
    youtube_views: int = 0
    #: Left out of recommendations' taste by the user.
    excluded: bool = False


def _keys_query(user_id: int):
    """(key, watched_at) of every video the user watched, one row per video."""
    lib_key = func.coalesce(
        col(Video.youtube_id), literal("video:") + cast(col(Video.id), String)
    )
    library: Select[Any, Any] = (
        sa_select(lib_key.label("key"), col(UserVideoState.last_watched_at).label("at"))
        .join(Video, col(Video.id) == col(UserVideoState.video_id))
        .where(
            col(UserVideoState.user_id) == user_id,
            col(UserVideoState.last_watched_at).is_not(None),
            col(Video.needs_review) == False,  # noqa: E712 - SQL column comparison, not a Python truth test
        )
    )
    streams: Select[Any, Any] = sa_select(
        col(UserStreamState.yt_id).label("key"),
        col(UserStreamState.last_watched_at).label("at"),
    ).where(col(UserStreamState.user_id) == user_id)
    youtube: Select[Any, Any] = (
        sa_select(
            col(YoutubeWatchEvent.yt_id).label("key"),
            func.max(col(YoutubeWatchEvent.watched_at)).label("at"),
        )
        .where(col(YoutubeWatchEvent.user_id) == user_id)
        .group_by(col(YoutubeWatchEvent.yt_id))
    )
    every = union_all(library, streams, youtube).subquery()
    return (
        sa_select(every.c.key, func.max(every.c.at).label("at"))
        .group_by(every.c.key)
        .subquery()
    )


def page(
    session: Session, user_id: int, *, offset: int, limit: int
) -> tuple[list[Entry], bool]:
    """The user's history, newest first: ``limit`` entries from ``offset``,
    and whether more follow."""
    keys = _keys_query(user_id)
    rows = session.execute(
        sa_select(keys.c.key, keys.c.at)
        .order_by(keys.c.at.desc(), keys.c.key.desc())
        .offset(offset)
        .limit(limit + 1)
    ).all()
    more = len(rows) > limit
    rows = rows[:limit]
    entries = [Entry(key=str(k), watched_at=as_utc(at)) for k, at in rows]
    _fill(session, user_id, entries)
    return entries, more


def count(session: Session, user_id: int) -> int:
    keys = _keys_query(user_id)
    return int(session.scalar(sa_select(func.count()).select_from(keys)) or 0)


def _fill(session: Session, user_id: int, entries: list[Entry]) -> None:
    """Details of each entry from whichever records it has (library first)."""
    by_key = {e.key: e for e in entries}
    yt_ids = [k for k in by_key if not k.startswith("video:")]
    video_ids = [int(k[6:]) for k in by_key if k.startswith("video:")]
    seen: dict[str, list[tuple[datetime, str]]] = {k: [] for k in by_key}

    # Every library video an entry names, watched here or not (one watched only
    # on YouTube may be downloaded since); not those still under review.
    videos = session.exec(
        select(Video).where(
            col(Video.youtube_id).in_(yt_ids) | col(Video.id).in_(video_ids),
            Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
        )
    ).all()
    states = {
        state.video_id: state
        for state in session.exec(
            select(UserVideoState).where(
                UserVideoState.user_id == user_id,
                col(UserVideoState.video_id).in_([v.id for v in videos]),
                col(UserVideoState.last_watched_at).is_not(None),
            )
        ).all()
    }
    for video in videos:
        key = library_key(video.id, video.youtube_id)
        entry = by_key.get(key)
        if entry is None:
            continue
        entry.video_id = video.id
        entry.yt_id = video.youtube_id
        entry.title = video.title
        entry.channel = video.channel
        entry.channel_url = video.channel_url
        entry.duration = video.duration_sec
        state = states.get(require_id(video))
        if state is not None and state.last_watched_at is not None:
            entry.fraction = library_fraction(state.position_sec, video.duration_sec)
            seen[key].append((as_utc(state.last_watched_at), "library"))

    for row in session.exec(
        select(UserStreamState).where(
            UserStreamState.user_id == user_id,
            col(UserStreamState.yt_id).in_(yt_ids),
        )
    ).all():
        entry = by_key[row.yt_id]
        entry.yt_id = row.yt_id
        entry.title = entry.title or row.title
        entry.channel = entry.channel or row.channel
        entry.channel_url = entry.channel_url or row.channel_url
        entry.duration = entry.duration or row.duration_sec
        # The library watch's progress wins when there is one.
        if entry.fraction is None:
            entry.fraction = stream_fraction(row)
        seen[row.yt_id].append((as_utc(row.last_watched_at), "stream"))

    views = dict(
        session.execute(
            sa_select(col(YoutubeWatchEvent.yt_id), func.count())
            .where(
                col(YoutubeWatchEvent.user_id) == user_id,
                col(YoutubeWatchEvent.yt_id).in_(yt_ids),
            )
            .group_by(col(YoutubeWatchEvent.yt_id))
        ).all()
    )
    if views:
        details = takeout_history.latest_details(session, user_id, list(views))
        lasts = dict(
            session.execute(
                sa_select(
                    col(YoutubeWatchEvent.yt_id),
                    func.max(col(YoutubeWatchEvent.watched_at)),
                )
                .where(
                    col(YoutubeWatchEvent.user_id) == user_id,
                    col(YoutubeWatchEvent.yt_id).in_(list(views)),
                )
                .group_by(col(YoutubeWatchEvent.yt_id))
            ).all()
        )
        for yt_id, n in views.items():
            entry = by_key[str(yt_id)]
            entry.yt_id = str(yt_id)
            entry.youtube_views = int(n)
            title, channel, channel_url = details.get(str(yt_id), (None, None, None))
            entry.title = entry.title or title
            entry.channel = entry.channel or channel
            entry.channel_url = entry.channel_url or channel_url
            seen[str(yt_id)].append((as_utc(lasts[yt_id]), "youtube"))

    taste = feedback.exclusions(session, user_id).taste
    for entry in entries:
        entry.sources = [src for _at, src in sorted(seen[entry.key], reverse=True)]
        entry.excluded = entry.key in taste


@dataclass
class Removed:
    videos: int
    library: int
    streams: int
    youtube_views: int


def remove(session: Session, user_id: int, keys: Iterable[str]) -> Removed:
    """Forget these videos from the user's history entirely (see the module doc)."""
    wanted = {k for k in keys if k}
    yt_ids = {k for k in wanted if not k.startswith("video:")}
    video_ids = {
        int(k[6:]) for k in wanted if k.startswith("video:") and k[6:].isdigit()
    }
    # A library key names the video's other records too (by its YouTube id).
    if video_ids:
        yt_ids |= {
            yt
            for yt in session.exec(
                select(Video.youtube_id).where(col(Video.id).in_(list(video_ids)))
            ).all()
            if yt
        }
    if yt_ids:
        video_ids |= {
            vid
            for vid in session.exec(
                select(Video.id).where(col(Video.youtube_id).in_(list(yt_ids)))
            ).all()
            if vid is not None
        }
    library = streams = views = 0
    if video_ids:
        result = session.execute(
            delete(UserVideoState).where(
                col(UserVideoState.user_id) == user_id,
                col(UserVideoState.video_id).in_(list(video_ids)),
            )
        )
        library = int(getattr(result, "rowcount", 0) or 0)
    if yt_ids:
        result = session.execute(
            delete(UserStreamState).where(
                col(UserStreamState.user_id) == user_id,
                col(UserStreamState.yt_id).in_(list(yt_ids)),
            )
        )
        streams = int(getattr(result, "rowcount", 0) or 0)
        result = session.execute(
            delete(YoutubeWatchEvent).where(
                col(YoutubeWatchEvent.user_id) == user_id,
                col(YoutubeWatchEvent.yt_id).in_(list(yt_ids)),
            )
        )
        views = int(getattr(result, "rowcount", 0) or 0)
    # Gone from the history: nothing left to leave out of the taste.
    session.execute(
        delete(RecFeedback).where(
            col(RecFeedback.user_id) == user_id,
            col(RecFeedback.kind) == "taste",
            col(RecFeedback.key).in_(list(wanted)),
        )
    )
    session.commit()
    return Removed(len(wanted), library, streams, views)


def set_taste(
    session: Session, user_id: int, keys: Iterable[str], *, use: bool
) -> None:
    """Let these watches shape recommendations again (``use``), or stop them."""
    wanted = sorted({k for k in keys if k})
    if use:
        session.execute(
            delete(RecFeedback).where(
                col(RecFeedback.user_id) == user_id,
                col(RecFeedback.kind) == "taste",
                col(RecFeedback.key).in_(wanted),
            )
        )
        session.commit()
        return
    for key in wanted:
        feedback.add(session, user_id, kind="taste", key=key, label=None)


@dataclass
class RecentView:
    """A video watched on YouTube lately, for Continue watching."""

    yt_id: str
    watched_at: datetime
    title: str | None
    channel: str | None
    channel_url: str | None


def recent_youtube(
    session: Session, user_id: int, *, days: int, now: datetime
) -> list[RecentView]:
    """The newest imported YouTube views of the last ``days`` days, at most
    ``CONTINUE_YOUTUBE_MAX``: videos not in the library (those follow the
    library's own rules) and not finished as a stream in Horde since."""
    last = func.max(col(YoutubeWatchEvent.watched_at)).label("last")
    in_library = select(col(Video.youtube_id)).where(col(Video.youtube_id).is_not(None))
    finished = select(col(UserStreamState.yt_id)).where(
        and_(
            col(UserStreamState.user_id) == user_id,
            col(UserStreamState.finished_at).is_not(None),
        )
    )
    rows = session.execute(
        sa_select(col(YoutubeWatchEvent.yt_id), last)
        .where(
            col(YoutubeWatchEvent.user_id) == user_id,
            col(YoutubeWatchEvent.watched_at) >= now - timedelta(days=days),
            col(YoutubeWatchEvent.yt_id).not_in(in_library),
            col(YoutubeWatchEvent.yt_id).not_in(finished),
        )
        .group_by(col(YoutubeWatchEvent.yt_id))
        .order_by(last.desc())
        .limit(CONTINUE_YOUTUBE_MAX)
    ).all()
    details = takeout_history.latest_details(session, user_id, [r[0] for r in rows])
    out = []
    for yt_id, when in rows:
        title, channel, channel_url = details.get(yt_id, (None, None, None))
        out.append(RecentView(yt_id, as_utc(when), title, channel, channel_url))
    return out

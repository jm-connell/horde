"""Time spent watching, and the History stats built from it.

``user_video_state`` only knows where each user is in each video. How long they
actually watched is counted here, from the same progress saves: each save adds
how far the position moved since the previous one, into ``user_watch_time``
(one row per user, video and UTC hour).

A move counts when it is forward and fits the time since the previous save:
at most ``SPEED_ALLOWANCE`` times that time plus ``SLACK_SEC``, so playing counts
(at 2x speed the content seconds) and a seek forward or back does not. For a live
save the time is capped at ``MAX_LIVE_GAP_SEC``: the player saves every few
seconds while playing (and at once on resuming), so a longer gap is a pause, and
a seek made after it must not count as the paused time. A save queued offline
carries the time it was reached (``watched_at``) and is the only one left of an
offline session (the queue keeps the newest per video), so its gap is not capped;
it counts in the hour it was reached, unless something newer was saved
meanwhile: ``user_state.record_progress`` drops it then, and so is its time.

The previous save is held in memory (``WatchRefs`` on the ``AppContext``)
because the player sends 0 from 90% on (``positionToSave`` in the frontend) and
the database then stores 0 too; after a restart the stored position is the
reference. A 0 save after a position above 0 keeps the reference position and
banks the (capped) time since the previous save, so the finish can count the
tail after 90% for as long as it can have played.

The stats read the hourly rows in the viewer's time zone, so "today" and the
weekday × hour chart are the viewer's, whatever zone the server runs in.
"""

from __future__ import annotations

import threading
from collections import Counter, OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import String, func, text, union
from sqlalchemy import select as sa_select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session, col, select

from ..models import (
    UserStreamState,
    UserVideoState,
    UserWatchTime,
    Video,
    VideoTag,
    YoutubeWatchEvent,
    as_utc,
    require_id,
    utcnow,
)
from ..schemas import (
    HistoryStats,
    HistoryStatsChannel,
    HistoryStatsDay,
    HistoryStatsLibrary,
    HistoryStatsRange,
    HistoryStatsTag,
    HistoryStatsTotals,
)
from .url_clean import youtube_video_id

#: A move may be this many times the time since the previous save (2x playback).
SPEED_ALLOWANCE = 2.0
#: ... plus this much (request timing, the throttle's first save of an interval).
SLACK_SEC = 3.0
#: Longest gap between live saves that still counts as playing time. Saves come
#: every 5 s while playing, about once a minute from a background tab.
MAX_LIVE_GAP_SEC = 75.0
#: When the player first reports a streamed video (``STREAM_WATCH_MIN_SEC``).
STREAM_FIRST_SAVE_SEC = 20.0
#: (user, video) pairs whose previous save is remembered; the oldest go first.
REF_LIMIT = 4096
RANGE_DAYS: dict[str, int | None] = {"7d": 7, "30d": 30, "365d": 365, "all": None}
TOP_CHANNELS = 6
TOP_TAGS = 12


@dataclass(frozen=True)
class WatchRef:
    """The previous save: the position the player sent and when."""

    position: float
    at: datetime
    #: Playing time banked by 0 saves since ``position`` (the tail after 90%).
    tail_credit: float = 0.0
    #: Position 0 is where playing began (a stream's first report), not the
    #: 0 the library player saves from 90% on: a finish counts from there.
    from_start: bool = False


class WatchRefs:
    """The previous save of recently watched videos, per (user, video).

    A library video is keyed by its id, a streamed one by its YouTube id.
    """

    def __init__(self, limit: int = REF_LIMIT) -> None:
        self._limit = limit
        self._refs: OrderedDict[tuple[int, int | str], WatchRef] = OrderedDict()
        self._lock = threading.Lock()

    def step(
        self,
        key: tuple[int, int | str],
        fallback: WatchRef | None,
        decide: Callable[[WatchRef | None], tuple[float, WatchRef | None]],
    ) -> float:
        """Run ``decide`` on the remembered ref (else ``fallback``) and keep its new one.

        One lock around read, decision and write, so two saves of the same video
        arriving together (two tabs, a page-hide flush) never both count the
        same seconds.
        """
        with self._lock:
            seconds, new = decide(self._refs.get(key) or fallback)
            if new is not None:
                self._refs[key] = new
                self._refs.move_to_end(key)
                while len(self._refs) > self._limit:
                    self._refs.popitem(last=False)
            return seconds


def _hour(at: datetime) -> datetime:
    return as_utc(at).replace(minute=0, second=0, microsecond=0)


def _decider(
    stamp: datetime,
    position_sec: float,
    duration: float,
    *,
    late: bool,
    finished: bool,
) -> Callable[[WatchRef | None], tuple[float, WatchRef | None]]:
    """How much of a save counts against the previous one (the module docstring)."""

    def decide(ref: WatchRef | None) -> tuple[float, WatchRef | None]:
        if ref is None:
            ref = WatchRef(0.0, stamp)
        if ref.at > stamp:
            return 0.0, None  # an older late save than the one remembered
        elapsed = (stamp - ref.at).total_seconds()
        if not late:
            elapsed = min(elapsed, MAX_LIVE_GAP_SEC)
        if finished:
            started = ref.position > 0 or ref.from_start
            tail = duration - ref.position if started else 0.0
            played = ref.tail_credit + elapsed
            counted = min(tail, played * SPEED_ALLOWANCE + SLACK_SEC)
            return max(0.0, counted), WatchRef(0.0, stamp)
        if position_sec == 0 and ref.position > 0:
            # From 90% on the player saves 0: keep the position for the finish.
            return 0.0, replace(ref, at=stamp, tail_credit=ref.tail_credit + elapsed)
        delta = position_sec - ref.position
        fits = 0 < delta <= elapsed * SPEED_ALLOWANCE + SLACK_SEC
        return (delta if fits else 0.0), WatchRef(position_sec, stamp)

    return decide


def _add(
    session: Session,
    user_id: int,
    stamp: datetime,
    seconds: float,
    *,
    finished: bool,
    channel: str | None,
    video_id: int | None = None,
    yt_id: str | None = None,
) -> None:
    """Add to the (user, hour, video) row: a library ``video_id`` or a stream's ``yt_id``."""
    statement = sqlite_insert(UserWatchTime).values(
        user_id=user_id,
        video_id=video_id,
        yt_id=yt_id,
        channel=channel,
        hour_start=_hour(stamp),
        seconds=seconds,
        finished=1 if finished else 0,
    )
    excluded = statement.excluded
    session.execute(
        statement.on_conflict_do_update(
            index_elements=[
                "user_id",
                "hour_start",
                "video_id" if video_id is not None else "yt_id",
            ],
            set_={
                "seconds": col(UserWatchTime.seconds) + excluded.seconds,
                "finished": col(UserWatchTime.finished) + excluded.finished,
                "channel": excluded.channel,
            },
        )
    )
    session.commit()


def record_save(
    session: Session,
    refs: WatchRefs,
    user_id: int,
    video: Video,
    position_sec: float,
    watched_at: datetime | None,
    *,
    finished: bool,
) -> None:
    """Add the watch time a progress save stands for (see the module docstring).

    Call it before ``user_state.record_progress``: it compares with the state
    that save is about to replace. ``position_sec`` is what the player sent.
    """
    video_id = require_id(video)
    now = utcnow()
    stamp = now if watched_at is None else min(as_utc(watched_at), now)
    state = session.get(UserVideoState, (user_id, video_id))
    saved_at = as_utc(state.last_watched_at) if state is not None else None
    if watched_at is not None and saved_at is not None and saved_at >= stamp:
        return  # record_progress keeps the newer save, and so do we
    fallback = (
        WatchRef(state.position_sec, saved_at)
        if state is not None and saved_at is not None
        else None
    )
    decide = _decider(
        stamp,
        position_sec,
        video.duration_sec or 0.0,
        late=watched_at is not None,
        finished=finished,
    )
    seconds = refs.step((user_id, video_id), fallback, decide)
    if seconds <= 0 and not finished:
        return
    _add(
        session,
        user_id,
        stamp,
        seconds,
        finished=finished,
        channel=video.channel,
        video_id=video_id,
    )


def record_stream_save(
    session: Session,
    refs: WatchRefs,
    user_id: int,
    *,
    url: str,
    channel: str | None,
    position_sec: float,
    duration_sec: float | None,
    finished: bool,
) -> None:
    """``record_save`` for a streamed video's report (``discovery/history``).

    Call it before ``history.record_stream_watch``, for the same reason. The
    player first reports a stream once it has played ``STREAM_FIRST_SAVE_SEC``:
    with nothing to compare against, that report is taken to follow a start
    from 0 that long ago, so the opening seconds count (all of a video shorter
    than that, on its finish) while a first report far into it (a seek) does not.

    A video that is in the library by now (downloaded, restored or imported while
    it was being streamed) gets the time on its library row.
    """
    yt_id = youtube_video_id(url or "")
    if not yt_id:
        return  # the caller refuses it
    stamp = utcnow()
    state = session.get(UserStreamState, (user_id, yt_id))
    if state is not None:
        fallback = WatchRef(
            state.position_sec,
            as_utc(state.last_watched_at),
            from_start=state.position_sec == 0,
        )
        duration = duration_sec or state.duration_sec or 0.0
    else:
        fallback = WatchRef(
            0.0, stamp - timedelta(seconds=STREAM_FIRST_SAVE_SEC), from_start=True
        )
        duration = duration_sec or 0.0
    decide = _decider(stamp, position_sec, duration, late=False, finished=finished)
    seconds = refs.step((user_id, yt_id), fallback, decide)
    if seconds <= 0 and not finished:
        return
    library_id = session.exec(
        select(col(Video.id))
        .where(col(Video.youtube_id) == yt_id)
        .order_by(col(Video.id))
        .limit(1)
    ).first()
    _add(
        session,
        user_id,
        stamp,
        seconds,
        finished=finished,
        channel=(channel or "").strip()[:200] or (state.channel if state else None),
        video_id=library_id,
        yt_id=None if library_id is not None else yt_id,
    )


def adopt_stream_time(session: Session, video: Video) -> int:
    """Move the time streamed of ``video`` (by YouTube id) onto the library video.

    Called when it is downloaded. An hour that already has a library row for the
    video (a re-download) adds into it. One write transaction: SQLite holds the
    write lock from the INSERT, so no save lands between it and the DELETE.
    Returns how many stream rows moved.
    """
    yt_id = video.youtube_id
    if not yt_id:
        return 0
    params = {"yt_id": yt_id, "video_id": require_id(video)}
    session.execute(
        text(
            "INSERT INTO user_watch_time "
            "(user_id, video_id, yt_id, channel, hour_start, seconds, finished) "
            "SELECT user_id, :video_id, NULL, channel, hour_start, seconds, finished "
            "FROM user_watch_time WHERE yt_id = :yt_id AND video_id IS NULL "
            "ON CONFLICT (user_id, hour_start, video_id) DO UPDATE SET "
            "seconds = seconds + excluded.seconds, "
            "finished = finished + excluded.finished"
        ),
        params,
    )
    moved = session.execute(
        text("DELETE FROM user_watch_time WHERE yt_id = :yt_id AND video_id IS NULL"),
        {"yt_id": yt_id},
    )
    session.commit()
    return int(getattr(moved, "rowcount", 0) or 0)


# --- Stats ----------------------------------------------------------------------


class UnknownTimeZone(ValueError):
    pass


def resolve_tz(name: str | None) -> tuple[str, tzinfo]:
    """``(name, zone)`` for an IANA name; the server's own zone when omitted."""
    if not name:
        local = datetime.now().astimezone().tzinfo
        return ("local", local or UTC)
    if name.upper() == "UTC":
        return ("UTC", UTC)
    try:
        return (name, ZoneInfo(name))
    except ZoneInfoNotFoundError, ValueError:
        raise UnknownTimeZone(name) from None


def _local_midnight_utc(day: date, zone: tzinfo) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=zone).astimezone(UTC)


def _streak(active: set[date], today: date) -> int:
    day = today if today in active else today - timedelta(days=1)
    count = 0
    while day in active:
        count += 1
        day -= timedelta(days=1)
    return count


def _watched_union(user_id: int, since: datetime | None, *, finished: bool) -> Any:
    """Ids of the videos watched (or finished) since ``since``, from both tables.

    ``user_video_state`` carries the history from before watch time was recorded.
    """
    timed = select(col(UserWatchTime.video_id)).where(
        col(UserWatchTime.user_id) == user_id,
        col(UserWatchTime.video_id).is_not(None),
        (col(UserWatchTime.finished) > 0)
        if finished
        else col(UserWatchTime.seconds) > 0,
    )
    stamp = col(
        UserVideoState.finished_at if finished else UserVideoState.last_watched_at
    )
    states = select(col(UserVideoState.video_id)).where(
        col(UserVideoState.user_id) == user_id, stamp.is_not(None)
    )
    if since is not None:
        timed = timed.where(col(UserWatchTime.hour_start) >= since)
        states = states.where(stamp >= since)
    return union(timed, states).subquery()


def _watched_keys(user_id: int, since: datetime | None, *, finished: bool) -> Any:
    """Keys of the videos watched (or finished) since ``since``, library or streamed.

    A video's YouTube id when it has one, else ``video:<id>``, so a video both
    streamed and later watched in the library counts once. ``user_stream_state``
    carries the streams from before they were timed.
    """
    library = _watched_union(user_id, since, finished=finished)
    video_id = library.c[0]
    library_keys = (
        select(
            func.coalesce(col(Video.youtube_id), "video:" + func.cast(video_id, String))
        )
        .select_from(library)
        .outerjoin(Video, col(Video.id) == video_id)
    )
    timed = select(col(UserWatchTime.yt_id)).where(
        col(UserWatchTime.user_id) == user_id,
        col(UserWatchTime.yt_id).is_not(None),
        (col(UserWatchTime.finished) > 0)
        if finished
        else col(UserWatchTime.seconds) > 0,
    )
    stamp = col(
        UserStreamState.finished_at if finished else UserStreamState.last_watched_at
    )
    streamed = select(col(UserStreamState.yt_id)).where(
        col(UserStreamState.user_id) == user_id, stamp.is_not(None)
    )
    if since is not None:
        timed = timed.where(col(UserWatchTime.hour_start) >= since)
        streamed = streamed.where(stamp >= since)
    return union(library_keys, timed, streamed).subquery()


def _distinct_videos(
    session: Session, user_id: int, since: datetime | None, *, finished: bool
) -> int:
    """Videos watched (or finished) since ``since``, in the library or streamed."""
    keys = _watched_keys(user_id, since, finished=finished)
    return int(session.scalar(select(func.count()).select_from(keys)) or 0)


def _watched_youtube_ids(
    session: Session, user_id: int, since: datetime | None
) -> set[str]:
    """YouTube ids of the videos watched in Horde since ``since`` (to not count twice)."""
    keys = _watched_keys(user_id, since, finished=False)
    return {
        str(key)
        for key in session.exec(select(keys.c[0])).all()
        if key and not str(key).startswith("video:")
    }


def _youtube_hours(
    session: Session, user_id: int, zone: tzinfo
) -> list[tuple[datetime, int]]:
    """The imported YouTube views (``services/takeout``) per UTC hour, in ``zone``.

    Counted in SQL: a long history is a few hundred thousand views, but far
    fewer hours.
    """
    hour = func.strftime("%Y-%m-%d %H:00:00", col(YoutubeWatchEvent.watched_at))
    return [
        (
            datetime.strptime(str(text), "%Y-%m-%d %H:%M:%S")
            .replace(tzinfo=UTC)
            .astimezone(zone),
            int(count),
        )
        for text, count in session.execute(
            sa_select(hour, func.count())
            .where(col(YoutubeWatchEvent.user_id) == user_id)
            .group_by(hour)
        ).all()
    ]


def _youtube_since(user_id: int, since: datetime | None) -> Any:
    clause = col(YoutubeWatchEvent.user_id) == user_id
    if since is not None:
        clause = clause & (col(YoutubeWatchEvent.watched_at) >= since)
    return clause


def compute(
    session: Session,
    user_id: int,
    range_key: HistoryStatsRange,
    tz_name: str,
    zone: tzinfo,
    *,
    now: datetime | None = None,
    include_youtube: bool = False,
) -> HistoryStats:
    """The History stats of ``user_id`` for ``range_key``, in ``zone``.

    With ``include_youtube``, the imported YouTube history counts too: its views
    add to the videos watched, active days, the streak, top channels and the
    weekday × hour chart, never to watch time (Takeout does not say how long).
    """
    today = (now or utcnow()).astimezone(zone).date()

    # Every hour this user has watched, folded across videos. Small: at most one
    # row per hour ever watched, and the streak needs them all anyway.
    hourly = session.exec(
        select(
            col(UserWatchTime.hour_start),
            func.sum(col(UserWatchTime.seconds)),
            func.sum(col(UserWatchTime.finished)),
        )
        .where(col(UserWatchTime.user_id) == user_id)
        .group_by(col(UserWatchTime.hour_start))
    ).all()
    per_day: dict[date, tuple[float, int]] = {}
    local_hours: list[tuple[datetime, float]] = []
    for hour_start, hour_seconds, hour_finished in hourly:
        local = as_utc(hour_start).astimezone(zone)
        secs = float(hour_seconds or 0)
        local_hours.append((local, secs))
        day_secs, day_fins = per_day.get(local.date(), (0.0, 0))
        per_day[local.date()] = (day_secs + secs, day_fins + int(hour_finished or 0))

    youtube = _youtube_hours(session, user_id, zone) if include_youtube else []
    youtube_days: Counter[date] = Counter()
    for local, count in youtube:
        youtube_days[local.date()] += count

    span = RANGE_DAYS[range_key]
    if span is None:
        start = min([*per_day, *youtube_days], default=today)
    else:
        start = today - timedelta(days=span - 1)
    since = None if span is None else _local_midnight_utc(start, zone)

    days: list[HistoryStatsDay] = []
    day = start
    while day <= today:
        day_secs, day_fins = per_day.get(day, (0.0, 0))
        days.append(
            HistoryStatsDay(
                day=day.isoformat(),
                seconds=day_secs,
                finished=day_fins,
                youtube_views=youtube_days.get(day, 0),
            )
        )
        day += timedelta(days=1)
    watch_seconds = sum(d.seconds for d in days)
    previous = None
    if span is not None:
        before = start - timedelta(days=span)
        previous = sum(v[0] for d, v in per_day.items() if before <= d < start)
    watched_days = [d for d in days if d.seconds > 0]
    active_days = [d for d in days if d.seconds > 0 or d.youtube_views > 0]
    best = max(watched_days, key=lambda d: d.seconds, default=None)

    hours: list[list[float]] | None = None
    if watch_seconds > 0:
        hours = [[0.0] * 24 for _ in range(7)]
        for local, seconds in local_hours:
            if local.date() >= start:
                hours[local.weekday()][local.hour] += seconds
    in_range = [(local, n) for local, n in youtube if start <= local.date() <= today]
    youtube_views = sum(n for _local, n in in_range)
    youtube_hours: list[list[int]] | None = None
    videos_started = _distinct_videos(session, user_id, since, finished=False)
    channels = _top_channels(session, user_id, since)
    # Only a range with YouTube views changes anything (ranking included).
    if youtube_views:
        youtube_hours = [[0] * 24 for _ in range(7)]
        for local, n in in_range:
            youtube_hours[local.weekday()][local.hour] += n
        on_youtube = {
            str(yt)
            for yt in session.exec(
                select(YoutubeWatchEvent.yt_id)
                .where(_youtube_since(user_id, since))
                .distinct()
            ).all()
        }
        videos_started += len(
            on_youtube - _watched_youtube_ids(session, user_id, since)
        )
        channels = _with_youtube_channels(
            session,
            _top_channels(session, user_id, since, limit=None),
            user_id,
            since,
        )
    active = {d for d, v in per_day.items() if v[0] > 0} | set(youtube_days)

    return HistoryStats(
        range=range_key,
        tz=tz_name,
        start_day=start.isoformat(),
        end_day=today.isoformat(),
        totals=HistoryStatsTotals(
            watch_seconds=watch_seconds,
            previous_watch_seconds=previous,
            videos_started=videos_started,
            videos_finished=_distinct_videos(session, user_id, since, finished=True),
            active_days=len(active_days),
            current_streak_days=_streak(active, today),
            youtube_views=youtube_views,
        ),
        days=days,
        best_day=best,
        channels=channels,
        tags=_top_tags(session, user_id, since),
        hours=hours,
        includes_youtube=youtube_views > 0,
        youtube_hours=youtube_hours,
        library=_library(session, user_id, since),
    )


def _range_filter(since: datetime | None) -> Any:
    clause = col(UserWatchTime.seconds) > 0
    if since is not None:
        clause = clause & (col(UserWatchTime.hour_start) >= since)
    return clause


def _top_channels(
    session: Session,
    user_id: int,
    since: datetime | None,
    limit: int | None = TOP_CHANNELS,
) -> list[HistoryStatsChannel]:
    # The video's current channel (a rename moves it), or the copy on the row
    # once the video is gone.
    name = func.coalesce(col(Video.channel), col(UserWatchTime.channel))
    total = func.sum(col(UserWatchTime.seconds))
    # Videos by YouTube id where there is one, so a video both streamed and
    # watched in the library counts once; else by id (a gone video: neither).
    video = func.coalesce(
        col(Video.youtube_id),
        col(UserWatchTime.yt_id),
        "video:" + func.cast(col(UserWatchTime.video_id), String),
    )
    rows = session.exec(
        select(name, total, func.count(func.distinct(video)))
        .select_from(UserWatchTime)
        .outerjoin(Video, col(Video.id) == col(UserWatchTime.video_id))
        .where(col(UserWatchTime.user_id) == user_id, _range_filter(since))
        .where(name.is_not(None), name != "")
        .group_by(name)
        .order_by(total.desc())
        .limit(limit if limit is not None else -1)
    ).all()
    return [
        HistoryStatsChannel(name=str(n), seconds=float(s or 0), videos=int(v or 0))
        for n, s, v in rows
    ]


def _with_youtube_channels(
    session: Session,
    horde: list[HistoryStatsChannel],
    user_id: int,
    since: datetime | None,
) -> list[HistoryStatsChannel]:
    """Horde's channels and the YouTube history's together, most videos first.

    Matched by name. A channel's videos are its distinct videos from both (a
    video watched in both places counts once per place: they are not linked).
    """
    merged = {c.name.casefold(): c.model_copy() for c in horde}
    name = func.trim(col(YoutubeWatchEvent.channel))
    for channel, views, distinct in session.execute(
        sa_select(
            name, func.count(), func.count(func.distinct(col(YoutubeWatchEvent.yt_id)))
        )
        .where(_youtube_since(user_id, since), name != "")
        .group_by(name)
    ).all():
        key = str(channel).casefold()
        entry = merged.get(key) or HistoryStatsChannel(
            name=str(channel), seconds=0.0, videos=0
        )
        entry.videos += int(distinct)
        entry.youtube_views += int(views)
        merged[key] = entry
    ranked = sorted(merged.values(), key=lambda c: (-c.videos, -c.seconds, c.name))
    return ranked[:TOP_CHANNELS]


def _top_tags(
    session: Session, user_id: int, since: datetime | None
) -> list[HistoryStatsTag]:
    # video_tags has a row per tag and source: one per tag here.
    tags = select(col(VideoTag.video_id), col(VideoTag.tag)).distinct().subquery()
    total = func.sum(col(UserWatchTime.seconds))
    rows = session.exec(
        select(
            tags.c.tag, total, func.count(func.distinct(col(UserWatchTime.video_id)))
        )
        .select_from(UserWatchTime)
        .join(tags, tags.c.video_id == col(UserWatchTime.video_id))
        .where(col(UserWatchTime.user_id) == user_id, _range_filter(since))
        .group_by(tags.c.tag)
        .order_by(total.desc())
        .limit(TOP_TAGS)
    ).all()
    return [
        HistoryStatsTag(tag=str(t), seconds=float(s or 0), videos=int(v or 0))
        for t, s, v in rows
    ]


def _library(
    session: Session, user_id: int, since: datetime | None
) -> HistoryStatsLibrary:
    in_library = col(Video.needs_review) == False  # noqa: E712 - SQL column comparison, not a Python truth test
    total, size = session.exec(
        select(func.count(), func.coalesce(func.sum(col(Video.file_size)), 0)).where(
            in_library
        )
    ).one()
    added_query = select(func.count()).select_from(Video).where(in_library)
    if since is not None:
        added_query = added_query.where(col(Video.added_at) >= since)
    added = session.scalar(added_query) or 0
    watched = (
        session.scalar(
            select(func.count())
            .select_from(UserVideoState)
            .join(Video, col(Video.id) == col(UserVideoState.video_id))
            .where(col(UserVideoState.user_id) == user_id, in_library)
        )
        or 0
    )
    return HistoryStatsLibrary(
        total_videos=int(total),
        total_size_bytes=int(size or 0),
        added_in_range=int(added),
        watched_videos=int(watched),
        watched_share=(watched / total) if total else 0.0,
    )

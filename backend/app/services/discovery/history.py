"""One watch history across library videos and streamed videos.

Library watches live in ``user_video_state`` (``services/user_state.py``). A video
played without downloading it is recorded here, in ``user_stream_state``, keyed by
its YouTube id. Recommendations read both through ``watches``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from ...models import UserStreamState, UserVideoState, Video, as_utc, utcnow
from ..follows import normalize_channel_url
from ..takeout import history as takeout_history
from ..url_clean import youtube_video_id

#: A stream counts as finished from here on (the library player's rule too).
FINISHED_FRACTION = 0.9
#: Watches read for taste: enough for a year of normal use.
HISTORY_LIMIT = 600


class NotAYoutubeVideo(ValueError):
    """The URL does not name a YouTube video."""


def record_stream_watch(
    session: Session,
    user_id: int,
    *,
    url: str,
    title: str | None,
    channel: str | None,
    channel_url: str | None,
    position_sec: float,
    duration_sec: float | None,
    finished: bool,
) -> UserStreamState:
    """Note that ``user_id`` watched a stream up to ``position_sec``."""
    yt_id = youtube_video_id(url or "")
    if not yt_id:
        raise NotAYoutubeVideo(url)
    now = utcnow()
    row = session.get(UserStreamState, (user_id, yt_id))
    if row is None:
        row = UserStreamState(
            user_id=user_id, yt_id=yt_id, url=f"https://www.youtube.com/watch?v={yt_id}"
        )
    row.title = (title or "").strip()[:500] or row.title
    row.channel = (channel or "").strip()[:200] or row.channel
    normalized = normalize_channel_url(channel_url or "")
    row.channel_url = normalized or row.channel_url
    if duration_sec and duration_sec > 0:
        row.duration_sec = float(duration_sec)
    row.watched_sec = max(row.watched_sec, max(0.0, float(position_sec)))
    if not finished and row.duration_sec:
        finished = row.watched_sec >= row.duration_sec * FINISHED_FRACTION
    if finished:
        row.finished_at = now
    row.last_watched_at = now
    session.add(row)
    try:
        session.commit()
    except IntegrityError:
        # Another report for the same video landed first (two tabs): add to it.
        session.rollback()
        return record_stream_watch(
            session,
            user_id,
            url=url,
            title=title,
            channel=channel,
            channel_url=channel_url,
            position_sec=position_sec,
            duration_sec=duration_sec,
            finished=finished,
        )
    session.refresh(row)
    return row


def library_key(video_id: int | None, yt_id: str | None) -> str:
    """How feedback and impressions name a library video: its YouTube id when known."""
    return yt_id or f"video:{video_id}"


@dataclass
class Watch:
    """One watched video, from the library or streamed."""

    key: str
    yt_id: str | None
    video_id: int | None
    title: str
    channel: str
    channel_url: str
    watched_at: datetime
    #: How much the watch says about taste (0.35 opened and left .. 1 finished).
    engagement: float
    finished: bool
    #: How far it got (0..1); None when unknown (a YouTube import).
    fraction: float | None = None


def library_engagement(position_sec: float, duration_sec: float | None) -> float:
    """How much a library watch says about taste, from how far the user got."""
    if position_sec <= 0:
        # The player stores a finished video as 0 (useProgressSaver.finish); an
        # old position that expired is also 0, but recency already discounts it.
        return 1.0
    if duration_sec and duration_sec > 0:
        fraction = position_sec / duration_sec
        if fraction >= 0.5:
            return 1.0
        if fraction < 0.15 and position_sec < 120:
            return 0.35  # Opened and abandoned.
        return 0.7
    return 0.35 if position_sec < 60 else 0.8


def library_fraction(position_sec: float, duration_sec: float | None) -> float | None:
    """How far a library watch got (a saved 0 means finished, see above)."""
    if position_sec <= 0:
        return 1.0
    if duration_sec and duration_sec > 0:
        return min(1.0, position_sec / duration_sec)
    return None


def stream_fraction(row: UserStreamState) -> float | None:
    if row.finished_at is not None:
        return 1.0
    if row.duration_sec and row.duration_sec > 0:
        return min(1.0, row.watched_sec / row.duration_sec)
    return None


def counts_as_taste(watch: Watch, min_watched_pct: int) -> bool:
    """Whether a watch got far enough to say something about taste.

    A watch whose progress is unknown (a YouTube import) always counts.
    """
    if min_watched_pct <= 0 or watch.fraction is None:
        return True
    return watch.fraction * 100 >= min_watched_pct


def stream_engagement(row: UserStreamState) -> float:
    if row.finished_at is not None:
        return 1.0
    return library_engagement(row.watched_sec or 1.0, row.duration_sec)


#: How much a YouTube view (from a Takeout import) says about taste: Takeout
#: does not record how far it played, so one view counts like a part-watch
#: and a video watched again like a finished one.
YOUTUBE_ENGAGEMENT = 0.7
YOUTUBE_REWATCH_ENGAGEMENT = 1.0


def watches(
    session: Session,
    user_id: int,
    *,
    limit: int = HISTORY_LIMIT,
    include_youtube: bool = True,
) -> list[Watch]:
    """The user's watches, newest first; a video watched both ways counts once.

    Includes the YouTube history the user imported from Takeout unless
    ``include_youtube`` is off (other people's histories pooled for the
    household stay Horde-only: an import is for its own account).
    """
    out: list[Watch] = []
    for video, state in session.exec(
        select(Video, UserVideoState)
        .join(UserVideoState, col(UserVideoState.video_id) == col(Video.id))
        .where(
            UserVideoState.user_id == user_id,
            col(UserVideoState.last_watched_at).is_not(None),
            Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
        )
        .order_by(col(UserVideoState.last_watched_at).desc())
        .limit(limit)
    ).all():
        if state.last_watched_at is None:
            continue
        out.append(
            Watch(
                key=library_key(video.id, video.youtube_id),
                yt_id=video.youtube_id,
                video_id=video.id,
                title=video.title or "",
                channel=(video.channel or "").strip(),
                channel_url=normalize_channel_url(video.channel_url or ""),
                watched_at=as_utc(state.last_watched_at),
                engagement=library_engagement(state.position_sec, video.duration_sec),
                finished=state.finished_at is not None or state.position_sec <= 0,
                fraction=library_fraction(state.position_sec, video.duration_sec),
            )
        )
    seen = {w.key for w in out}
    for row in session.exec(
        select(UserStreamState)
        .where(UserStreamState.user_id == user_id)
        .order_by(col(UserStreamState.last_watched_at).desc())
        .limit(limit)
    ).all():
        if row.yt_id in seen:
            continue
        out.append(
            Watch(
                key=row.yt_id,
                yt_id=row.yt_id,
                video_id=None,
                title=row.title or "",
                channel=(row.channel or "").strip(),
                channel_url=row.channel_url or "",
                watched_at=as_utc(row.last_watched_at),
                engagement=stream_engagement(row),
                finished=row.finished_at is not None,
                fraction=stream_fraction(row),
            )
        )
    if include_youtube:
        seen = {w.key for w in out}
        for viewed in takeout_history.recent_videos(session, user_id, limit=limit):
            if viewed.yt_id in seen:
                continue
            out.append(
                Watch(
                    key=viewed.yt_id,
                    yt_id=viewed.yt_id,
                    video_id=None,
                    title=viewed.title or "",
                    channel=(viewed.channel or "").strip(),
                    channel_url=viewed.channel_url or "",
                    watched_at=viewed.last_watched_at,
                    engagement=YOUTUBE_REWATCH_ENGAGEMENT
                    if viewed.views > 1
                    else YOUTUBE_ENGAGEMENT,
                    finished=False,
                )
            )
    out.sort(key=lambda w: w.watched_at, reverse=True)
    return out[:limit]


def watched_keys(session: Session, user_id: int) -> set[str]:
    """Every library and streamed video the user ever watched (``watches``
    stops at ``HISTORY_LIMIT``; what may be shown must not)."""
    out = {
        library_key(vid, yt_id)
        for vid, yt_id in session.exec(
            select(Video.id, Video.youtube_id)
            .join(UserVideoState, col(UserVideoState.video_id) == col(Video.id))
            .where(
                UserVideoState.user_id == user_id,
                col(UserVideoState.last_watched_at).is_not(None),
            )
        ).all()
    }
    out |= set(
        session.exec(
            select(UserStreamState.yt_id).where(UserStreamState.user_id == user_id)
        ).all()
    )
    return out


@dataclass
class PastFavorite:
    """A video the user finished (or watched again) a while ago: a rewatch pick."""

    watch: Watch
    #: Views known (a YouTube import counts them; 1 otherwise).
    views: int = 1
    #: Its length when known, for the length and Shorts filters.
    duration: float | None = None


def past_favorites(
    session: Session, user_id: int, *, before: datetime, limit: int = 300
) -> list[PastFavorite]:
    """Videos finished, or watched more than once on YouTube, last seen before
    ``before``, the most recently seen first; a video counts once."""
    out: dict[str, PastFavorite] = {}
    for video, state in session.exec(
        select(Video, UserVideoState)
        .join(UserVideoState, col(UserVideoState.video_id) == col(Video.id))
        .where(
            UserVideoState.user_id == user_id,
            col(UserVideoState.last_watched_at).is_not(None),
            col(UserVideoState.last_watched_at) < before,
            col(UserVideoState.finished_at).is_not(None)
            | (col(UserVideoState.position_sec) <= 0),
            Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
        )
        .order_by(col(UserVideoState.last_watched_at).desc())
        .limit(limit)
    ).all():
        if state.last_watched_at is None:
            continue
        key = library_key(video.id, video.youtube_id)
        out[key] = PastFavorite(
            Watch(
                key=key,
                yt_id=video.youtube_id,
                video_id=video.id,
                title=video.title or "",
                channel=(video.channel or "").strip(),
                channel_url=normalize_channel_url(video.channel_url or ""),
                watched_at=as_utc(state.last_watched_at),
                engagement=1.0,
                finished=True,
                fraction=1.0,
            )
        )
    for row in session.exec(
        select(UserStreamState)
        .where(
            UserStreamState.user_id == user_id,
            col(UserStreamState.finished_at).is_not(None),
            col(UserStreamState.last_watched_at) < before,
        )
        .order_by(col(UserStreamState.last_watched_at).desc())
        .limit(limit)
    ).all():
        out.setdefault(
            row.yt_id,
            PastFavorite(
                Watch(
                    key=row.yt_id,
                    yt_id=row.yt_id,
                    video_id=None,
                    title=row.title or "",
                    channel=(row.channel or "").strip(),
                    channel_url=row.channel_url or "",
                    watched_at=as_utc(row.last_watched_at),
                    engagement=1.0,
                    finished=True,
                    fraction=1.0,
                ),
                duration=row.duration_sec,
            ),
        )
    rewatched, _more = takeout_history.rewatched_page(
        session, user_id, offset=0, limit=limit
    )
    for viewed in rewatched:
        if viewed.last_watched_at >= before or viewed.yt_id in out:
            continue
        out[viewed.yt_id] = PastFavorite(
            Watch(
                key=viewed.yt_id,
                yt_id=viewed.yt_id,
                video_id=None,
                title=viewed.title or "",
                channel=(viewed.channel or "").strip(),
                channel_url=viewed.channel_url or "",
                watched_at=viewed.last_watched_at,
                engagement=YOUTUBE_REWATCH_ENGAGEMENT,
                finished=False,
            ),
            views=viewed.views,
        )
    picks = sorted(out.values(), key=lambda p: p.watch.watched_at, reverse=True)
    return picks[:limit]

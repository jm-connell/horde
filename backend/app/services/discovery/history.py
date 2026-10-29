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


def stream_engagement(row: UserStreamState) -> float:
    if row.finished_at is not None:
        return 1.0
    return library_engagement(row.watched_sec or 1.0, row.duration_sec)


def watches(
    session: Session, user_id: int, *, limit: int = HISTORY_LIMIT
) -> list[Watch]:
    """The user's watches, newest first; a video watched both ways counts once."""
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
            )
        )
    out.sort(key=lambda w: w.watched_at, reverse=True)
    return out[:limit]

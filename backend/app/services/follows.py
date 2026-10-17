"""Followed channels: one list per user, read by the live list.

A user follows a channel by hand, or automatically when a library download they
queued finishes. An administrator's list is also seeded from the library at startup
(``seed_administrators``), because every download before follows existed was
theirs. Unfollowing keeps a
row with ``followed = False`` so the next download does not follow it again.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlsplit

from sqlmodel import Session, col, select

from ..context import get_engine
from ..models import ChannelFollow, DownloadRequester, User, Video, utcnow
from . import library
from .channel_catalog.runtime import is_youtube_channel_url

logger = logging.getLogger(__name__)

SOURCE_MANUAL = "manual"
SOURCE_DOWNLOAD = "download"
SOURCE_LIBRARY = "library"


_TAB_SUFFIXES = frozenset(
    {"videos", "streams", "shorts", "live", "playlists", "featured", "about", "search"}
)


def normalize_channel_url(channel_url: str) -> str:
    """The stored form of a channel URL. ``frontend/src/utils/followUrl.ts`` mirrors it.

    https, lowercase host without ``www.`` / ``m.`` or a port, no query, no
    trailing slash or tab suffix (``/live``, ``/videos``, ... in any case), and a
    lowercase ``@handle``. ``""`` for input that is not a URL.
    """
    text = (channel_url or "").strip()
    if not text:
        return ""
    if not re.match(r"^[a-z][a-z0-9+.-]*://", text, re.IGNORECASE):
        text = f"https://{text}"
    try:
        parsed = urlsplit(text)
        host = (parsed.hostname or "").lower()
    except ValueError:
        return ""
    host = re.sub(r"^(www|m)\.", "", host)
    if not host:
        return ""
    parts = [p for p in parsed.path.split("/") if p]
    while len(parts) > 1 and parts[-1].lower() in _TAB_SUFFIXES:
        parts.pop()
    path = "/".join(p.lower() if p.startswith("@") else p for p in parts)
    return f"https://{host}" + (f"/{path}" if path else "")


@dataclass(frozen=True)
class FollowedChannel:
    channel_url: str
    channel_name: str | None
    source: str
    created_at: datetime


def _row(session: Session, user_id: int, channel_url: str) -> ChannelFollow | None:
    return session.exec(
        select(ChannelFollow).where(
            ChannelFollow.user_id == user_id,
            ChannelFollow.channel_url == channel_url,
        )
    ).first()


def list_follows(session: Session, user_id: int) -> list[FollowedChannel]:
    rows = session.exec(
        select(ChannelFollow).where(
            ChannelFollow.user_id == user_id,
            ChannelFollow.followed == True,  # noqa: E712 - SQL column comparison, not a Python truth test
        )
    ).all()
    out = [
        FollowedChannel(
            channel_url=r.channel_url,
            channel_name=r.channel_name,
            source=r.source,
            created_at=r.created_at,
        )
        for r in rows
    ]
    out.sort(key=lambda f: (f.channel_name or f.channel_url).casefold())
    return out


def followed_urls(session: Session, user_id: int) -> set[str]:
    return {f.channel_url for f in list_follows(session, user_id)}


def all_followed_urls(session: Session) -> dict[str, str | None]:
    """Every channel at least one user follows: url -> a display name."""
    rows = session.exec(
        select(ChannelFollow.channel_url, ChannelFollow.channel_name).where(
            ChannelFollow.followed == True  # noqa: E712 - SQL column comparison, not a Python truth test
        )
    ).all()
    out: dict[str, str | None] = {}
    for url, name in rows:
        if name or url not in out:
            out[url] = name
    return out


def follow(
    session: Session,
    user_id: int,
    channel_url: str,
    channel_name: str | None = None,
    *,
    source: str = SOURCE_MANUAL,
) -> FollowedChannel:
    """Follow (or re-follow) a channel. A manual follow overrides an unfollow."""
    url = normalize_channel_url(channel_url)
    if not url or not is_youtube_channel_url(url):
        raise ValueError("Only YouTube channels can be followed")
    name = (channel_name or "").strip() or None
    row = _row(session, user_id, url)
    now = utcnow()
    if row is None:
        row = ChannelFollow(
            user_id=user_id,
            channel_url=url,
            channel_name=name,
            followed=True,
            source=source,
            created_at=now,
            updated_at=now,
        )
    else:
        row.followed = True
        if name:
            row.channel_name = name
        row.updated_at = now
    session.add(row)
    session.commit()
    session.refresh(row)
    return FollowedChannel(
        channel_url=row.channel_url,
        channel_name=row.channel_name,
        source=row.source,
        created_at=row.created_at,
    )


def unfollow(session: Session, user_id: int, channel_url: str) -> bool:
    """Unfollow; True when the channel was followed. Leaves a tombstone row."""
    url = normalize_channel_url(channel_url)
    row = _row(session, user_id, url)
    if row is None:
        row = ChannelFollow(user_id=user_id, channel_url=url, followed=False)
        session.add(row)
        session.commit()
        return False
    was = row.followed
    row.followed = False
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    return was


def _auto_follow(
    session: Session,
    user_id: int,
    channel_url: str,
    channel_name: str | None,
    source: str,
) -> bool:
    """Follow unless the user has a row for it already (followed or not)."""
    url = normalize_channel_url(channel_url)
    if not url or not is_youtube_channel_url(url):
        return False
    if _row(session, user_id, url) is not None:
        return False
    now = utcnow()
    session.add(
        ChannelFollow(
            user_id=user_id,
            channel_url=url,
            channel_name=(channel_name or "").strip() or None,
            followed=True,
            source=source,
            created_at=now,
            updated_at=now,
        )
    )
    return True


def seed_from_library(session: Session, user_id: int) -> int:
    """First visit of an administrator: follow every library channel once.

    Runs only while the user has no follow rows at all, so unfollowing everything
    (which leaves tombstones) does not bring the list back.
    """
    has_any = session.exec(
        select(ChannelFollow.id).where(ChannelFollow.user_id == user_id).limit(1)
    ).first()
    if has_any is not None:
        return 0
    added = 0
    for stat in library.channel_stats(session):
        if stat.channel_url and _auto_follow(
            session, user_id, stat.channel_url, stat.channel, SOURCE_LIBRARY
        ):
            added += 1
    if added:
        session.commit()
    return added


def seed_administrators() -> int:
    """At startup: seed every administrator who has no follow rows yet."""
    with Session(get_engine()) as session:
        admin_ids = session.exec(
            select(User.id).where(
                User.is_admin == True,  # noqa: E712 - SQL column comparison, not a Python truth test
                User.disabled == False,  # noqa: E712 - SQL column comparison, not a Python truth test
            )
        ).all()
        return sum(seed_from_library(session, uid) for uid in admin_ids if uid)


def record_requester(session: Session, job_id: int, user_id: int) -> None:
    """Remember who queued a job. The caller commits."""
    session.add(DownloadRequester(job_id=job_id, user_id=user_id))


def follow_from_download(job_id: int, video_id: int | None) -> None:
    """A finished library download follows its channel for whoever queued it.

    Best effort and never raises: the job is already committed as completed.
    """
    if video_id is None:
        return
    try:
        with Session(get_engine()) as session:
            requester = session.get(DownloadRequester, job_id)
            video = session.get(Video, video_id)
            if requester is None or video is None or not video.channel_url:
                return
            if _auto_follow(
                session,
                requester.user_id,
                video.channel_url,
                video.channel,
                SOURCE_DOWNLOAD,
            ):
                session.commit()
    except Exception:
        logger.warning(
            "could not follow the channel of job %s (video %s)",
            job_id,
            video_id,
            exc_info=True,
        )


def channel_name_hint(session: Session, channel_url: str) -> str | None:
    """A library channel name for a URL, when the library has one."""
    url = normalize_channel_url(channel_url)
    for name, raw in session.exec(
        select(Video.channel, Video.channel_url)
        .where(col(Video.channel_url).is_not(None))
        .where(col(Video.channel).is_not(None))
        .distinct()
    ).all():
        if raw and normalize_channel_url(raw) == url:
            return name
    return None

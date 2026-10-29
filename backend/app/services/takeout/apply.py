"""Turn the subscriptions and playlists of a Takeout export into Horde's own.

Both are the user's choice per item (the import dialog lists them first), and
both stay personal: a subscription becomes a follow on the importing account, a
playlist becomes a private playlist it owns. Importing the same export again
adds only what is missing: a playlist is found again by its YouTube id (else
its name) and gains only the videos it lacks.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sqlalchemy import func
from sqlalchemy import update as sa_update
from sqlmodel import Session, col, select

from ...models import (
    ChannelCatalog,
    ChannelCatalogVideo,
    ChannelFollow,
    Playlist,
    PlaylistItem,
    PlaylistSource,
    PlaylistVisibility,
    Video,
    require_id,
)
from .. import follows, playlist_entries
from . import history
from .parse import Subscription, TakeoutPlaylist

IMPORTED_DESCRIPTION = "Imported from YouTube"

FollowState = Literal["new", "following", "unfollowed"]


def playlist_url(playlist_id: str) -> str:
    return f"https://www.youtube.com/playlist?list={playlist_id}"


def subscription_states(
    session: Session, user_id: int, subscriptions: list[Subscription]
) -> dict[str, FollowState]:
    """``channel_url -> new | following | unfollowed`` for this user."""
    rows = {
        r.channel_url: r.followed
        for r in session.exec(
            select(ChannelFollow).where(ChannelFollow.user_id == user_id)
        ).all()
    }
    out: dict[str, FollowState] = {}
    for sub in subscriptions:
        followed = rows.get(sub.channel_url)
        out[sub.channel_url] = (
            "new" if followed is None else "following" if followed else "unfollowed"
        )
    return out


def follow_channels(
    session: Session, user_id: int, subscriptions: list[Subscription]
) -> int:
    """Follow the chosen channels; returns how many were not followed before."""
    states = subscription_states(session, user_id, subscriptions)
    added = 0
    for sub in subscriptions:
        try:
            follows.follow(session, user_id, sub.channel_url, sub.channel_name)
        except ValueError:
            continue  # not a YouTube channel URL
        if states.get(sub.channel_url) != "following":
            added += 1
    return added


def find_playlist(
    session: Session, user_id: int, playlist: TakeoutPlaylist
) -> Playlist | None:
    """The user's playlist an earlier import of ``playlist`` made, if any."""
    query = select(Playlist).where(col(Playlist.owner_user_id) == user_id)
    if playlist.playlist_id:
        query = query.where(
            col(Playlist.source_url) == playlist_url(playlist.playlist_id)
        )
    else:
        query = query.where(
            Playlist.name == playlist.title,
            col(Playlist.description) == IMPORTED_DESCRIPTION,
        )
    return session.exec(query.order_by(col(Playlist.id))).first()


def existing_ids(session: Session, playlist_id: int) -> set[str]:
    """YouTube ids the playlist holds, as library videos or streamed entries."""
    found = {
        yt
        for yt in session.exec(
            select(PlaylistItem.youtube_id).where(
                PlaylistItem.playlist_id == playlist_id
            )
        ).all()
        if yt
    }
    found.update(
        yt
        for yt in session.exec(
            select(Video.youtube_id)
            .join(PlaylistItem, col(PlaylistItem.video_id) == col(Video.id))
            .where(PlaylistItem.playlist_id == playlist_id)
        ).all()
        if yt
    )
    return found


@dataclass(frozen=True)
class PlaylistResult:
    playlist_id: int
    created: bool
    added: int


def import_playlist(
    session: Session, user_id: int, playlist: TakeoutPlaylist
) -> PlaylistResult:
    """Create the user's private copy of ``playlist``, or top up the one there is."""
    row = find_playlist(session, user_id, playlist)
    created = row is None
    if row is None:
        session.execute(sa_update(Playlist).values(position=Playlist.position + 1))
        row = Playlist(
            name=playlist.title[:200] or "YouTube playlist",
            description=IMPORTED_DESCRIPTION,
            source_type=PlaylistSource.user,
            source_url=playlist_url(playlist.playlist_id)
            if playlist.playlist_id
            else None,
            position=0,
            owner_user_id=user_id,
            visibility=PlaylistVisibility.private,
        )
        session.add(row)
        session.flush()
    pid = require_id(row)
    have = existing_ids(session, pid)
    wanted = [vid for vid in playlist.video_ids if vid not in have]
    last = session.scalar(
        select(func.max(col(PlaylistItem.position))).where(
            PlaylistItem.playlist_id == pid
        )
    )
    position = -1 if last is None else int(last)
    library = _library_videos(session, wanted)
    known = _known_details(session, user_id, [v for v in wanted if v not in library])
    for yt_id in wanted:
        position += 1
        video = library.get(yt_id)
        if video is not None:
            session.add(playlist_entries.new_item(pid, video, position))
            continue
        title, channel, channel_url, duration = known.get(
            yt_id, (None, None, None, None)
        )
        session.add(
            PlaylistItem(
                playlist_id=pid,
                video_id=None,
                position=position,
                youtube_id=yt_id,
                url=f"https://www.youtube.com/watch?v={yt_id}",
                title=title,
                channel=channel,
                channel_url=channel_url,
                duration_sec=duration,
            )
        )
    session.commit()
    return PlaylistResult(pid, created, len(wanted))


def _library_videos(session: Session, yt_ids: list[str]) -> dict[str, Video]:
    out: dict[str, Video] = {}
    for start in range(0, len(yt_ids), 500):
        for video in session.exec(
            select(Video)
            .where(col(Video.youtube_id).in_(yt_ids[start : start + 500]))
            .order_by(col(Video.id))
        ).all():
            if video.youtube_id:
                out.setdefault(video.youtube_id, video)
    return out


def _known_details(
    session: Session, user_id: int, yt_ids: list[str]
) -> dict[str, tuple[str | None, str | None, str | None, float | None]]:
    """What Horde already knows of videos it does not hold: indexed channels, history."""
    out: dict[str, tuple[str | None, str | None, str | None, float | None]] = {}
    for start in range(0, len(yt_ids), 500):
        chunk = yt_ids[start : start + 500]
        for row, catalog in session.exec(
            select(ChannelCatalogVideo, ChannelCatalog)
            .join(
                ChannelCatalog,
                col(ChannelCatalog.id) == col(ChannelCatalogVideo.catalog_id),
            )
            .where(col(ChannelCatalogVideo.yt_id).in_(chunk))
        ).all():
            out.setdefault(
                row.yt_id,
                (row.title, catalog.channel_name, catalog.channel_url, row.duration),
            )
    missing = [v for v in yt_ids if v not in out]
    for yt_id, (title, channel, channel_url) in history.latest_details(
        session, user_id, missing
    ).items():
        out[yt_id] = (title, channel, channel_url, None)
    return out

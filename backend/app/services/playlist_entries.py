"""Playlist entries that are library videos or streamed ones (``PlaylistItem``).

An entry always carries a snapshot of its video (YouTube id, link, title,
channel, duration), so it can be shown and streamed while ``video_id`` is None.
Three moments keep the two in step:

* deleting a library video (``detach_video``, from ``delete_video_cascade``)
  turns its entries into streamed ones, or drops them when the video has no
  link to stream from;
* a video joining the library by any path (a download, the scanner, a trash
  restore) links every streamed entry for it, in every playlist
  (``_link_new_video``, a mapper hook), so ``video_id`` is what other code
  (retention, "Remove from server") can rely on;
* a download for a playlist that has no entry for it yet adds one
  (``playlist_attach``); ``resolve`` also matches by YouTube id at read time,
  which only matters for rows written while that hook could not run.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import and_, delete, event, func, update
from sqlalchemy.engine import Connection
from sqlmodel import Session, col, select

from ..models import PlaylistItem, Video, require_id


def snapshot(video: Video) -> dict[str, Any]:
    """The entry columns that describe ``video`` when it is not in the library."""
    return {
        "youtube_id": video.youtube_id,
        "url": video.source_url if streamable_url(video.source_url) else None,
        "title": video.title,
        "channel": video.channel,
        "channel_url": video.channel_url,
        "duration_sec": video.duration_sec,
    }


def streamable_url(url: str | None) -> bool:
    return bool(url) and str(url).startswith(("https://", "http://"))


def new_item(playlist_id: int, video: Video, position: int) -> PlaylistItem:
    return PlaylistItem(
        playlist_id=playlist_id,
        video_id=require_id(video),
        position=position,
        **snapshot(video),
    )


def detach_video(session: Session, video: Video) -> None:
    """Before ``video`` is deleted: keep its entries as streamed ones if possible."""
    video_id = require_id(video)
    if streamable_url(video.source_url):
        session.execute(
            update(PlaylistItem)
            .where(col(PlaylistItem.video_id) == video_id)
            .values(video_id=None, **snapshot(video))
        )
    else:
        session.execute(
            delete(PlaylistItem).where(col(PlaylistItem.video_id) == video_id)
        )


def streamed_entry(
    session: Session, playlist_id: int, youtube_id: str | None, url: str | None
) -> PlaylistItem | None:
    """The playlist's streamed entry for a YouTube id (else a link), if any."""
    if youtube_id:
        same = col(PlaylistItem.youtube_id) == youtube_id
    elif url:
        same = col(PlaylistItem.url) == url
    else:
        return None
    return session.exec(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist_id,
            col(PlaylistItem.video_id).is_(None),
            same,
        )
    ).first()


def link_video(session: Session, playlist_id: int, video: Video) -> PlaylistItem | None:
    """Point the playlist's streamed entry for ``video`` at it. Does not commit."""
    item = streamed_entry(session, playlist_id, video.youtube_id, video.source_url)
    if item is not None:
        item.video_id = require_id(video)
        session.add(item)
    return item


@event.listens_for(Video, "after_insert")
def _link_new_video(_mapper: Any, connection: Connection, target: Video) -> None:
    if target.id is None:
        return
    if target.youtube_id:
        same = col(PlaylistItem.youtube_id) == target.youtube_id
    elif streamable_url(target.source_url):
        same = and_(
            col(PlaylistItem.youtube_id).is_(None),
            col(PlaylistItem.url) == target.source_url,
        )
    else:
        return
    # One entry per playlist: a playlist can hold the same video only once, so
    # any further streamed entries for it stay streamed.
    first = (
        select(func.min(PlaylistItem.id))
        .where(col(PlaylistItem.video_id).is_(None), same)
        .group_by(col(PlaylistItem.playlist_id))
    )
    connection.execute(
        update(PlaylistItem)
        .where(col(PlaylistItem.id).in_(first))
        .values(video_id=target.id)
    )


def resolve(session: Session, items: list[PlaylistItem]) -> dict[int, Video]:
    """``item.id -> Video`` for the entries whose video is in the library."""
    by_id = {item.video_id for item in items if item.video_id is not None}
    by_yt = {
        item.youtube_id for item in items if item.video_id is None and item.youtube_id
    }
    videos: dict[int, Video] = {}
    if by_id:
        for video in session.exec(select(Video).where(col(Video.id).in_(by_id))).all():
            videos[require_id(video)] = video
    downloaded: dict[str, Video] = {}
    if by_yt:
        for video in session.exec(
            select(Video)
            .where(col(Video.youtube_id).in_(by_yt))
            .order_by(col(Video.id))
        ).all():
            if video.youtube_id:
                downloaded.setdefault(video.youtube_id, video)
    out: dict[int, Video] = {}
    for item in items:
        found = (
            videos.get(item.video_id)
            if item.video_id is not None
            else downloaded.get(item.youtube_id or "")
        )
        if found is not None:
            out[require_id(item)] = found
    return out

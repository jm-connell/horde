"""What happens to playlists when accounts come and go.

Kept apart from ``playlists`` (the access rules) because ``auth.accounts`` calls
into this module and the access rules import the error types that import
``accounts``.
"""

from __future__ import annotations

from sqlalchemy import delete, update
from sqlmodel import Session, col, select

from ..models import Playlist, PlaylistItem, PlaylistVisibility, require_id
from .thumbnails import unlink_playlist_cover

#: (playlist id, cover file) of a deleted playlist, for ``remove_covers``.
Cover = tuple[int, str | None]


def hand_over(session: Session, owner_id: int, successor_id: int | None) -> list[Cover]:
    """Settle the playlists of an account that is being deleted.

    Its public playlists go to ``successor_id`` so shared lists survive; its
    private ones are deleted with their items. Returns the cover files to remove
    once the caller has committed (a rolled-back deletion keeps them).
    """
    session.execute(
        update(Playlist)
        .where(
            col(Playlist.owner_user_id) == owner_id,
            col(Playlist.visibility) == PlaylistVisibility.public,
        )
        .values(owner_user_id=successor_id)
    )
    private = session.exec(
        select(Playlist).where(
            col(Playlist.owner_user_id) == owner_id,
            col(Playlist.visibility) == PlaylistVisibility.private,
        )
    ).all()
    covers: list[Cover] = []
    for playlist in private:
        covers.append((require_id(playlist), playlist.cover_path))
        session.execute(
            delete(PlaylistItem).where(col(PlaylistItem.playlist_id) == playlist.id)
        )
        session.delete(playlist)
    return covers


def remove_covers(covers: list[Cover]) -> None:
    """Delete the cover files ``hand_over`` returned (call after the commit)."""
    for playlist_id, path in covers:
        unlink_playlist_cover(playlist_id, path)


def adopt_unowned(session: Session, user_id: int) -> None:
    """Give the playlists that predate accounts to the first administrator."""
    session.execute(
        update(Playlist)
        .where(col(Playlist.owner_user_id).is_(None))
        .values(owner_user_id=user_id)
    )

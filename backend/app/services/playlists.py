"""Who may see and change which playlist.

A playlist is **public** (every signed-in user sees it) or **private** (only its
owner does). To anyone else a private playlist does not exist: every lookup
answers 404, never 403, so its existence leaks nothing. Administrators get no
view into other people's private playlists.

Editing: the owner may always edit and delete their playlists. A public playlist
somebody else owns can be edited by holders of ``manage_playlists`` (administrators
hold it), as shared playlists always were. Only the owner changes who can see a
playlist, and publishing one takes ``manage_playlists``; a private playlist only
affects its owner, so making one needs no grant.

Every route and the download queue go through this module instead of repeating
the rules. What happens to playlists when an account is deleted or created is in
``playlist_owners``.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, or_
from sqlmodel import Session, col

from ..errors import CodedHTTPException
from ..models import Playlist, PlaylistVisibility
from .auth.accounts import AuthUser

MANAGE = "manage_playlists"


def _need_grant(user: AuthUser) -> None:
    """403 unless the user holds manage_playlists (the wording of ``ensure_permission``)."""
    if not user.can(MANAGE):
        raise CodedHTTPException(
            403,
            "Your account is not allowed to do this (Manage playlists). "
            "Ask an administrator.",
            "permission_denied",
        )


def visible_to(user: AuthUser) -> ColumnElement[bool]:
    """``WHERE`` clause: public playlists and the user's own private ones."""
    return or_(
        col(Playlist.visibility) == PlaylistVisibility.public,
        col(Playlist.owner_user_id) == user.id,
    )


def is_owner(user: AuthUser, playlist: Playlist) -> bool:
    return playlist.owner_user_id == user.id


def can_see(user: AuthUser, playlist: Playlist) -> bool:
    return playlist.visibility == PlaylistVisibility.public or is_owner(user, playlist)


def can_edit(user: AuthUser, playlist: Playlist) -> bool:
    if is_owner(user, playlist):
        return True
    return playlist.visibility == PlaylistVisibility.public and user.can(MANAGE)


def get_visible(session: Session, user: AuthUser, playlist_id: int) -> Playlist:
    """The playlist, or 404 when it is missing or somebody else's private one."""
    playlist = session.get(Playlist, playlist_id)
    if playlist is None or not can_see(user, playlist):
        raise CodedHTTPException(404, "Playlist not found", "not_found")
    return playlist


def get_editable(session: Session, user: AuthUser, playlist_id: int) -> Playlist:
    """Like ``get_visible``, and 403 when the user may look but not change it."""
    playlist = get_visible(session, user, playlist_id)
    if not can_edit(user, playlist):
        _need_grant(user)  # a public playlist: the grant is what is missing
    return playlist


def new_visibility(
    user: AuthUser, requested: PlaylistVisibility | None
) -> PlaylistVisibility:
    """The visibility a playlist the user creates gets (403 for public without a grant).

    Unspecified means public for those who may publish and private for the rest.
    """
    if requested is None:
        return (
            PlaylistVisibility.public
            if user.can(MANAGE)
            else PlaylistVisibility.private
        )
    if requested == PlaylistVisibility.public:
        _need_grant(user)
    return requested


def change_visibility(
    user: AuthUser, playlist: Playlist, requested: PlaylistVisibility
) -> None:
    """Apply a visibility change from ``user`` (the owner, with a grant to publish)."""
    if requested == playlist.visibility:
        return
    if not is_owner(user, playlist):
        raise CodedHTTPException(
            403, "Only the owner can change who sees a playlist", "permission_denied"
        )
    if requested == PlaylistVisibility.public:
        _need_grant(user)
    playlist.visibility = requested

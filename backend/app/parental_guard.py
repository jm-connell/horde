"""Route guards for parental controls (``services/parental.py``).

Added as router dependencies, they answer for a restricted member before a
route runs: ``video_guard`` 404s a library video of another channel named by
the ``video_id`` path parameter; ``stream_guard`` 403s a YouTube video (the
``youtube_id`` / ``video_id`` path parameter, or the ``url`` query) that is not
known to belong to an allowed channel. Unrestricted users pass at once.
"""

from __future__ import annotations

from fastapi import Depends, Request
from sqlmodel import Session

from .auth import current_user
from .context import get_session
from .errors import CodedHTTPException
from .models import Video
from .services import parental
from .services.auth.accounts import AuthUser
from .services.url_clean import youtube_video_id

NOT_ALLOWED = "This channel is not one you can watch"


def video_guard(
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
) -> None:
    if user.allowed is None:
        return
    raw = request.path_params.get("video_id")
    if raw is None:
        return
    try:
        video_id = int(raw)
    except ValueError:
        return
    video = session.get(Video, video_id)
    if video is not None and not parental.video_allowed(user.allowed, video):
        # As if it did not exist: a restricted member does not learn of it.
        raise CodedHTTPException(404, "Video not found", "not_found")


def _stream_id(request: Request) -> str | None:
    for name in ("youtube_id", "video_id"):
        raw = request.path_params.get(name)
        if raw:
            return str(raw)
    url = request.query_params.get("url")
    return youtube_video_id(url) if url else None


def stream_guard(
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
) -> None:
    if user.allowed is None:
        return
    yt_id = _stream_id(request)
    if yt_id is None:
        return  # no video named (a list: filtered where it is built)
    if not parental.stream_allowed(session, user.allowed, user.id, yt_id):
        raise CodedHTTPException(403, NOT_ALLOWED, "channel_not_allowed")


def restricted_forbidden(user: AuthUser = Depends(current_user)) -> None:
    """For routes that reach all of YouTube (search): closed to restricted members."""
    if user.allowed is not None:
        raise CodedHTTPException(
            403, "Searching YouTube is turned off for this account", "restricted"
        )

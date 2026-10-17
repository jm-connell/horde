"""The signed-in user's followed channels."""

from __future__ import annotations

import logging
import re
import time

from fastapi import APIRouter, Depends, Query, Request
from sqlmodel import Session

from ..auth import current_user
from ..context import get_ctx, get_session
from ..errors import CodedHTTPException
from ..schemas import (
    FollowedChannelRead,
    FollowListResponse,
    FollowRequest,
    UnfollowResult,
)
from ..services import follows
from ..services.auth.accounts import AuthUser
from ..services.channel_catalog.runtime import is_youtube_channel_url
from ..services.live.page import fetch_live_page, parse_channel_name, parse_live_page
from ..services.url_safety import UnsafeUrlError, UrlFetchError, validate_public_url

router = APIRouter(prefix="/api/follows", tags=["follows"])
logger = logging.getLogger(__name__)

_HANDLE_RE = re.compile(r"^@[\w.\-]{2,100}$")


def _channel_url_from_input(raw: str) -> str:
    text = raw.strip()
    if _HANDLE_RE.match(text):
        text = f"https://www.youtube.com/{text}"
    elif not text.startswith(("http://", "https://")):
        text = f"https://{text}"
    url = follows.normalize_channel_url(text)
    try:
        validate_public_url(url)
    except UnsafeUrlError as exc:
        raise CodedHTTPException(400, str(exc), "invalid_url") from exc
    return url


def _read(item: follows.FollowedChannel) -> FollowedChannelRead:
    return FollowedChannelRead(
        channel_url=item.channel_url,
        channel_name=item.channel_name,
        source=item.source,
        created_at=item.created_at,
    )


@router.get("", response_model=FollowListResponse)
def list_follows(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    return FollowListResponse(
        items=[_read(f) for f in follows.list_follows(session, user.id)]
    )


@router.put("", response_model=FollowedChannelRead)
def follow_channel(
    payload: FollowRequest,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Follow a channel by URL or ``@handle`` (it needs no videos in the library)."""
    url = _channel_url_from_input(payload.channel_url)
    if not is_youtube_channel_url(url):
        raise CodedHTTPException(
            400, "Only YouTube channels can be followed", "not_followable"
        )
    name = (payload.channel_name or "").strip() or follows.channel_name_hint(
        session, url
    )
    # One look at the channel page: its name when we have none, and whether it
    # is live right now (so the live list does not wait for the next poll).
    ctx = get_ctx(request)
    html: str | None = None
    directory = ctx.live.directory
    # No lookup offline (the browser suite) or while YouTube rate-limits us.
    if not ctx.e2e and time.time() >= directory.paused_until:
        try:
            html = fetch_live_page(url, timeout=10.0)
        except (UrlFetchError, UnsafeUrlError):
            logger.debug("could not look up followed channel %s", url, exc_info=True)
    if html is not None:
        try:
            broadcast = parse_live_page(html)
        except Exception:
            logger.debug("could not read the live page of %s", url, exc_info=True)
            broadcast = None
        name = name or (broadcast.channel_name if broadcast else None)
        name = name or parse_channel_name(html)
        directory.record(url, name, broadcast)
    try:
        item = follows.follow(session, user.id, url, name)
    except ValueError as exc:
        raise CodedHTTPException(400, str(exc), "not_followable") from exc
    _wake_poller(request)
    return _read(item)


@router.delete("", response_model=UnfollowResult)
def unfollow_channel(
    channel_url: str = Query(..., min_length=1, max_length=500),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    url = follows.normalize_channel_url(channel_url)
    follows.unfollow(session, user.id, url)
    return UnfollowResult(channel_url=url, following=False)


def _wake_poller(request: Request) -> None:
    get_ctx(request).live.wake_poller()

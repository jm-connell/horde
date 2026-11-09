"""The signed-in user's followed channels."""

from __future__ import annotations

import logging
import re
import time

from fastapi import APIRouter, Depends, Query, Request
from sqlmodel import Session

from ..auth import current_user, require_permission
from ..context import get_ctx, get_session
from ..errors import CodedHTTPException
from ..schemas import (
    FollowedChannelRead,
    FollowListResponse,
    FollowPreviewRead,
    FollowRequest,
    FollowUpdate,
    SubscribeAskIndexRequest,
    SubscribeAskIndexResult,
    UnfollowResult,
)
from ..services import channel_avatar, follows
from ..services.auth.accounts import AuthUser
from ..services.channel_catalog.runtime import is_youtube_channel_url
from ..services.knowledge import channels as kb_channels
from ..services.knowledge import search as kb_search
from ..services.limits import ytdlp_slot
from ..services.live.page import fetch_live_page, parse_channel_name, parse_live_page
from ..services.url_safety import UnsafeUrlError, UrlFetchError, validate_public_url

router = APIRouter(prefix="/api/follows", tags=["follows"])
logger = logging.getLogger(__name__)

_HANDLE_RE = re.compile(r"^@[\w.\-]{2,100}$")


def _channel_url_from_input(raw: str) -> str:
    """A YouTube channel URL from a link or ``@handle``; 400 ``not_followable``
    for anything else (another site, or a YouTube link that is not a channel).
    The host and path are checked before any DNS lookup."""
    text = raw.strip()
    if _HANDLE_RE.match(text):
        text = f"https://www.youtube.com/{text}"
    elif not text.startswith(("http://", "https://")):
        text = f"https://{text}"
    url = follows.normalize_channel_url(text)
    try:
        if not is_youtube_channel_url(url):
            raise CodedHTTPException(400, "not a YouTube link", "not_followable")
        kb_channels.parse_channel_input(url)
    except CodedHTTPException as exc:
        raise CodedHTTPException(
            400, "Only YouTube channels can be subscribed to", "not_followable"
        ) from exc
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
        hide_live=item.hide_live,
    )


@router.get("", response_model=FollowListResponse)
def list_follows(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    return FollowListResponse(
        items=[_read(f) for f in follows.list_follows(session, user.id)]
    )


_MANAGE = [Depends(require_permission("manage_subscriptions"))]


@router.get(
    "/preview", response_model=FollowPreviewRead, dependencies=[Depends(ytdlp_slot)]
)
def preview_channel(
    request: Request,
    channel: str = Query(..., min_length=1, max_length=500),
    session: Session = Depends(get_session),
):
    """Look a channel up by link or ``@handle`` before subscribing: its name and
    picture, read from its YouTube page (404 ``channel_not_found`` when there is
    no such page, 502 ``youtube_unavailable`` when YouTube does not answer)."""
    url = _channel_url_from_input(channel)
    name = follows.channel_name_hint(session, url)
    ctx = get_ctx(request)
    if ctx.e2e:
        # The browser suite has no YouTube: the handle stands in for the name.
        return FollowPreviewRead(channel_url=url, channel_name=name)
    if time.time() < ctx.live.directory.paused_until:
        raise CodedHTTPException(
            502, "YouTube is not answering right now", "youtube_unavailable"
        )
    try:
        page = channel_avatar.read_channel_page(url)
    except channel_avatar.AvatarUnreadable as exc:
        logger.debug("could not read the channel page of %s", url, exc_info=True)
        cause = exc.__cause__
        if isinstance(cause, UrlFetchError) and cause.status == 404:
            raise CodedHTTPException(
                404, "No YouTube channel found there", "channel_not_found"
            ) from exc
        raise CodedHTTPException(
            502, "YouTube is not answering right now", "youtube_unavailable"
        ) from exc
    avatar = channel_avatar.parse_avatar(page)
    channel_avatar.cache().put(url, avatar, channel_avatar.parse_about(page))
    return FollowPreviewRead(
        channel_url=url,
        channel_name=name or parse_channel_name(page),
        avatar_url=avatar,
    )


@router.put("", response_model=FollowedChannelRead, dependencies=_MANAGE)
def follow_channel(
    payload: FollowRequest,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Follow a channel by URL or ``@handle`` (it needs no videos in the library)."""
    url = _channel_url_from_input(payload.channel_url)
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
        except UrlFetchError, UnsafeUrlError:
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


@router.patch("", response_model=FollowedChannelRead)
def update_follow(
    payload: FollowUpdate,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Show or hide a followed channel's live streams, without unfollowing it."""
    item = follows.set_hide_live(
        session,
        user.id,
        _channel_url_from_input(payload.channel_url),
        payload.hide_live,
    )
    if item is None:
        raise CodedHTTPException(404, "You do not follow this channel", "not_followed")
    return _read(item)


@router.delete("", response_model=UnfollowResult, dependencies=_MANAGE)
def unfollow_channel(
    channel_url: str = Query(..., min_length=1, max_length=500),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    url = follows.normalize_channel_url(channel_url)
    follows.unfollow(session, user.id, url)
    return UnfollowResult(channel_url=url, following=False)


@router.post("/ask-index", response_model=SubscribeAskIndexResult, dependencies=_MANAGE)
def index_subscribed_channel(
    payload: SubscribeAskIndexRequest,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Turn Ask indexing on for a channel the caller subscribes to.

    Up to ``ASK_INDEX_AUTO_MAX`` uploads it starts by itself; a larger channel
    answers ``large`` and starts only with ``confirm_large``, which needs
    ``manage_ask``. Members without ``manage_ask`` may do this while the
    administrator includes their new channels (``follows.may_index_on_subscribe``).
    Reads the channel's upload count from YouTube.
    """
    if not follows.may_index_on_subscribe(user.is_admin, user.permissions):
        raise CodedHTTPException(
            403, "Turning Ask on for channels is not allowed here", "forbidden"
        )
    url = follows.normalize_channel_url(payload.channel_url)
    if url not in follows.followed_urls(session, user.id):
        raise CodedHTTPException(409, "Subscribe to the channel first", "not_followed")
    if not kb_search.fts_available(session):
        raise CodedHTTPException(
            503, "This server's SQLite has no full-text search (FTS5)", "unavailable"
        )
    if get_ctx(request).e2e:
        # The browser suite has no YouTube: nothing is looked up or turned on.
        return SubscribeAskIndexResult(channel_url=url)
    if payload.confirm_large and "manage_ask" not in user.permissions:
        raise CodedHTTPException(
            403,
            "Indexing a channel this large needs the Manage channel indexing permission",
            "channel_too_large",
        )
    done = kb_channels.index_on_subscribe(
        session,
        url,
        user_id=user.id,
        auto_max=follows.ASK_INDEX_AUTO_MAX,
        confirm_large=payload.confirm_large,
    )
    return SubscribeAskIndexResult(
        channel_url=done.channel_url,
        channel_name=done.channel_name,
        video_count=done.video_count,
        indexed=done.indexed,
        already=done.already,
        large=done.large,
    )


def _wake_poller(request: Request) -> None:
    get_ctx(request).live.wake_poller()

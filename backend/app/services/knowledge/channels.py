"""Add, list, change and remove Ask channels."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, func, select

from ...context import current
from ...errors import CodedHTTPException
from ...models import (
    ChannelCatalog,
    KbChannel,
    KbChannelStatus,
    KbChunk,
    KbVideo,
    require_id,
    utcnow,
)
from .. import app_settings
from ..follows import normalize_channel_url
from ..ytdlp_common import classify_ytdlp_error
from . import captions, indexing, listing

logger = logging.getLogger(__name__)

_HANDLE = re.compile(r"^@[\w.\-]{3,100}$")
_CHANNEL_PATH = re.compile(r"^/(@[^/]+|channel/UC[\w-]+|c/[^/]+|user/[^/]+)$")
_DELETE_BATCH = 500


def parse_channel_input(raw: str) -> str:
    """A YouTube channel URL from a pasted URL or a bare ``@handle``; 400 otherwise."""
    value = (raw or "").strip()
    if _HANDLE.match(value):
        value = f"https://www.youtube.com/{value}"
    url = normalize_channel_url(value)
    host = url.removeprefix("https://").split("/", 1)[0]
    path = url[len("https://") + len(host) :]
    if host not in ("youtube.com", "music.youtube.com") or not _CHANNEL_PATH.match(
        path
    ):
        raise CodedHTTPException(
            400,
            "Enter a YouTube channel link or @handle",
            "invalid_channel",
        )
    return url


def _youtube_error(exc: Exception, url: str) -> CodedHTTPException:
    _, message = classify_ytdlp_error(exc, url=url)
    logger.warning("Ask: reading channel %s failed", url, exc_info=True)
    return CodedHTTPException(
        502, message or "Could not read that channel from YouTube", "youtube_error"
    )


def preview(raw: str) -> listing.Preview:
    url = parse_channel_input(raw)
    try:
        return listing.preview(url)
    except listing.ChannelNotFound as exc:
        raise CodedHTTPException(
            404, "No YouTube channel at that address", "not_found"
        ) from exc
    except Exception as exc:
        raise _youtube_error(exc, url) from exc


def _find(session: Session, channel_url: str) -> KbChannel | None:
    return session.exec(
        select(KbChannel).where(KbChannel.channel_url == channel_url)
    ).first()


def add(
    session: Session,
    raw: str,
    *,
    include_streams: bool,
    user_id: int,
    found: listing.Preview | None = None,
) -> KbChannel:
    """Turn Ask on for a channel (``found``: its preview, when already read)."""
    found = found or preview(raw)
    canonical = normalize_channel_url(found.channel_url) or parse_channel_input(raw)
    if _find(session, canonical) is not None:
        raise CodedHTTPException(409, "Ask is already on for this channel", "exists")
    channel = KbChannel(
        channel_url=canonical,
        channel_name=found.channel_name,
        include_streams=include_streams,
        added_by=user_id,
    )
    session.add(channel)
    session.commit()
    session.refresh(channel)
    current().knowledge.wake.set()
    return channel


@dataclass(frozen=True)
class SubscribeIndex:
    """What turning Ask on for a subscribed channel did."""

    channel_url: str
    channel_name: str | None
    video_count: int | None
    indexed: bool
    already: bool = False


def index_on_subscribe(
    session: Session, channel_url: str, *, user_id: int
) -> SubscribeIndex:
    """Turn Ask on for a channel someone subscribed to, whatever its size: the
    limit (``effective_limit``) caps how much of it is indexed. Raises 502
    ``youtube_error`` when YouTube cannot be asked about the channel."""
    url = parse_channel_input(channel_url)
    on = _find(session, url)
    if on is not None:
        return SubscribeIndex(url, on.channel_name, None, indexed=True, already=True)
    found = preview(url)
    canonical = normalize_channel_url(found.channel_url) or url
    on = _find(session, canonical)
    if on is not None:
        return SubscribeIndex(
            canonical, on.channel_name, found.video_count, indexed=True, already=True
        )
    try:
        channel = add(session, url, include_streams=False, user_id=user_id, found=found)
    except CodedHTTPException as exc:
        if exc.code != "exists":
            raise
        return _already(session, canonical, found)
    except IntegrityError:
        # Someone else turned it on between the look-up and the insert.
        session.rollback()
        return _already(session, canonical, found)
    return SubscribeIndex(
        channel.channel_url, channel.channel_name, found.video_count, indexed=True
    )


def _already(
    session: Session, canonical: str, found: listing.Preview
) -> SubscribeIndex:
    on = _find(session, canonical)
    return SubscribeIndex(
        canonical,
        on.channel_name if on else found.channel_name,
        found.video_count,
        indexed=True,
        already=True,
    )


def get_or_404(session: Session, channel_id: int) -> KbChannel:
    channel = session.get(KbChannel, channel_id)
    if channel is None:
        raise CodedHTTPException(404, "Channel not found", "not_found")
    return channel


def default_limit() -> int:
    """The app-wide number of newest uploads Ask indexes per channel."""
    return app_settings.clamp_ask_max_videos(app_settings.load().get("ask_max_videos"))


def effective_limit(channel: KbChannel) -> int:
    """The channel's own limit, or the app-wide one."""
    return channel.max_videos or default_limit()


def _list_again(channel: KbChannel) -> None:
    """Queue a new listing (a listing in flight is discarded: it used the old
    choice). A paused channel lists when it is resumed."""
    channel.updated_at = utcnow()
    if channel.status != KbChannelStatus.paused:
        channel.status = KbChannelStatus.queued


def set_limit(session: Session, channel: KbChannel, limit: int | None) -> None:
    """Give the channel its own limit (None: follow the app-wide one). The next
    listing fetches up to it and deletes what lies beyond it."""
    if limit == channel.max_videos:
        return
    before = effective_limit(channel)
    channel.max_videos = limit
    if effective_limit(channel) != before:
        _list_again(channel)
    session.add(channel)
    session.commit()
    current().knowledge.wake.set()


def default_limit_changed(session: Session) -> None:
    """The app-wide limit changed: list the channels that follow it again."""
    for channel in session.exec(
        select(KbChannel).where(col(KbChannel.max_videos).is_(None))
    ).all():
        _list_again(channel)
        session.add(channel)
    session.commit()
    current().knowledge.wake.set()


def set_streams(session: Session, channel: KbChannel, include: bool) -> None:
    """Turning streams off removes their passages; on lists them at the next pass."""
    channel_id = require_id(channel)
    if include == channel.include_streams:
        return
    channel.include_streams = include
    channel.updated_at = utcnow()
    if channel.status == KbChannelStatus.listing:
        # The listing in flight used the old choice: list again.
        channel.status = KbChannelStatus.queued
    if include:
        if channel.status != KbChannelStatus.paused:
            channel.status = KbChannelStatus.queued
    else:
        stream_ids = list(
            session.exec(
                select(KbVideo.id).where(
                    KbVideo.kb_channel_id == channel_id, col(KbVideo.is_stream)
                )
            ).all()
        )
        indexing.delete_videos(session, [i for i in stream_ids if i is not None])
    session.add(channel)
    session.commit()
    current().knowledge.wake.set()


def pause(session: Session, channel: KbChannel) -> None:
    channel.status = KbChannelStatus.paused
    channel.updated_at = utcnow()
    session.add(channel)
    session.commit()


def resume(session: Session, channel: KbChannel) -> None:
    if channel.status != KbChannelStatus.paused:
        return
    # Re-list: uploads may have arrived while it was paused.
    channel.status = KbChannelStatus.queued
    channel.updated_at = utcnow()
    session.add(channel)
    session.commit()
    current().knowledge.wake.set()


def remove(session: Session, channel: KbChannel) -> None:
    channel_id = require_id(channel)
    # Stop the worker from picking it up while its rows go.
    channel.status = KbChannelStatus.paused
    session.add(channel)
    session.commit()
    while True:
        result = session.execute(
            text(
                "DELETE FROM kb_chunks WHERE id IN "
                "(SELECT id FROM kb_chunks WHERE kb_channel_id = :c LIMIT :n)"
            ),
            {"c": channel_id, "n": _DELETE_BATCH},
        )
        session.commit()
        if not getattr(result, "rowcount", 0):
            break
    session.delete(channel)
    session.commit()


@dataclass
class ChannelCounts:
    videos: int = 0
    fetched: int = 0
    pending: int = 0
    no_captions: int = 0
    unavailable: int = 0
    passages: int = 0


def counts(session: Session) -> dict[int, ChannelCounts]:
    """Progress per channel, counted (never stored, so it cannot drift)."""
    out: dict[int, ChannelCounts] = {}
    rows = session.exec(
        select(KbVideo.kb_channel_id, KbVideo.fetch_status, func.count()).group_by(
            col(KbVideo.kb_channel_id), col(KbVideo.fetch_status)
        )
    ).all()
    for channel_id, status, n in rows:
        c = out.setdefault(channel_id, ChannelCounts())
        c.videos += n
        if status == captions.FETCHED:
            c.fetched += n
        elif status == "pending":
            c.pending += n
        elif status == captions.NO_CAPTIONS:
            c.no_captions += n
        else:
            c.unavailable += n
    for channel_id, n in session.exec(
        select(KbChunk.kb_channel_id, func.count())
        .where(col(KbChunk.chunk_index) >= 0)
        .group_by(col(KbChunk.kb_channel_id))
    ).all():
        out.setdefault(channel_id, ChannelCounts()).passages = n
    return out


def channel_totals(session: Session) -> dict[str, int]:
    """Uploads each channel has on YouTube, by channel URL, where the channel
    catalog knows it (Ask's own listing stops at the limit)."""
    rows = session.exec(
        select(ChannelCatalog.channel_url, ChannelCatalog.channel_total).where(
            col(ChannelCatalog.channel_total).is_not(None)
        )
    ).all()
    return {normalize_channel_url(url): total for url, total in rows if total}


def list_channels(session: Session) -> list[KbChannel]:
    return list(
        session.exec(select(KbChannel).order_by(col(KbChannel.channel_name))).all()
    )

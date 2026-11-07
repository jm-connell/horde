"""Add, list, change and remove Ask channels."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from sqlalchemy import delete, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, func, select

from ...context import current
from ...errors import CodedHTTPException
from ...models import KbChannel, KbChannelStatus, KbChunk, KbVideo, require_id, utcnow
from ..follows import normalize_channel_url
from ..ytdlp_common import classify_ytdlp_error
from . import captions, listing

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
    large: bool = False


def index_on_subscribe(
    session: Session,
    channel_url: str,
    *,
    user_id: int,
    auto_max: int,
    confirm_large: bool,
) -> SubscribeIndex:
    """Turn Ask on for a channel someone subscribed to: by itself up to
    ``auto_max`` uploads, beyond that only with ``confirm_large`` (the caller
    checks who may confirm). Uploads it cannot count are treated as large."""
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
    count = found.video_count
    if not confirm_large:
        if count is None:
            try:
                large = listing.has_more_uploads_than(canonical, auto_max)
            except Exception as exc:
                raise _youtube_error(exc, canonical) from exc
        else:
            large = count > auto_max
        if large:
            return SubscribeIndex(
                canonical, found.channel_name, count, indexed=False, large=True
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
        channel.channel_url, channel.channel_name, count, indexed=True
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
        _delete_videos(session, [i for i in stream_ids if i is not None])
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


def _delete_videos(session: Session, video_ids: list[int]) -> None:
    """Delete in batches so the FTS triggers never hold the write lock for long."""
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i : i + 50]
        session.execute(delete(KbChunk).where(col(KbChunk.kb_video_id).in_(batch)))
        session.execute(delete(KbVideo).where(col(KbVideo.id).in_(batch)))
        session.commit()


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


def list_channels(session: Session) -> list[KbChannel]:
    return list(
        session.exec(select(KbChannel).order_by(col(KbChannel.channel_name))).all()
    )

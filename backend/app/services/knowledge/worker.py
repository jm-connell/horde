"""The Ask worker: lists channels' uploads and fetches their captions, one at a time.

Each pass does one unit of work, in this order:

1. list a channel that is new, failed listing an hour ago, or was last listed a
   day ago (new uploads join this way);
2. fetch the next video's captions, newest uploads first, oldest-added channel
   first. A library copy is read straight away; a YouTube fetch waits until no
   library caption retry is due and the pacer's background slot is free
   (``services/timedtext.py``), so library caption work always goes first.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlmodel import Session, col, or_, select

from ...context import current, get_engine
from ...models import KbChannel, KbChannelStatus, KbVideo, as_utc, require_id, utcnow
from .. import activity
from ..subtitle_retry import next_due_video
from ..workers import BackgroundWorker
from ..ytdlp_common import classify_ytdlp_error
from . import captions, indexing, listing

logger = logging.getLogger(__name__)

STARTUP_DELAY_SEC = 30
IDLE_POLL_SEC = 60
# Spacing between YouTube caption fetches (the library retry worker uses the same).
FETCH_SPACING_SEC = 15
RELIST_AFTER = timedelta(days=1)
RETRY_LISTING_AFTER = timedelta(hours=1)
_ACTIVE = (KbChannelStatus.indexing, KbChannelStatus.ready)


def recover() -> int:
    """A listing cut off by a restart starts over."""
    with Session(get_engine()) as session:
        rows = session.exec(
            select(KbChannel).where(KbChannel.status == KbChannelStatus.listing)
        ).all()
        for row in rows:
            row.status = KbChannelStatus.queued
            session.add(row)
        session.commit()
        return len(rows)


def _channel_due_for_listing(session: Session) -> KbChannel | None:
    now = datetime.now(UTC)
    for channel in session.exec(
        select(KbChannel).order_by(col(KbChannel.created_at))
    ).all():
        listed = as_utc(channel.last_listed_at)
        if channel.status == KbChannelStatus.queued:
            return channel
        if channel.status == KbChannelStatus.error:
            if now - as_utc(channel.updated_at) >= RETRY_LISTING_AFTER:
                return channel
        elif channel.status in _ACTIVE and (
            listed is None or now - listed >= RELIST_AFTER
        ):
            return channel
    return None


def list_due_channel() -> bool:
    """List one channel if any is due. Returns True when one was listed (or failed)."""
    with Session(get_engine()) as session:
        channel = _channel_due_for_listing(session)
        if channel is None:
            return False
        channel_id = require_id(channel)
        url = channel.channel_url
        include_streams = channel.include_streams
        max_videos = channel.max_videos
        name = channel.channel_name or url
        channel.status = KbChannelStatus.listing
        session.add(channel)
        session.commit()
    try:
        with activity.track(
            "ask", "Listing a channel for Ask", engine="yt-dlp", detail=name
        ):
            found = listing.list_channel(
                url, include_streams=include_streams, max_videos=max_videos
            )
    except Exception as exc:
        _, message = classify_ytdlp_error(exc, url=url)
        logger.warning("Ask: listing %s failed", url, exc_info=True)
        with Session(get_engine()) as session:
            channel = session.get(KbChannel, channel_id)
            if channel is not None:
                channel.status = KbChannelStatus.error
                channel.last_error = (message or str(exc))[:500]
                channel.updated_at = utcnow()
                session.add(channel)
                session.commit()
        return True
    with Session(get_engine()) as session:
        channel = session.get(KbChannel, channel_id)
        # Removed or paused while listing.
        if channel is None or channel.status != KbChannelStatus.listing:
            return True
        added = indexing.apply_listing(session, channel, found)
        indexing.finish_if_done(session, channel_id)
    logger.info("Ask: listed %s (%s new)", name, added)
    return True


def _next_video(session: Session) -> KbVideo | None:
    now = datetime.now(UTC)
    return session.exec(
        select(KbVideo)
        .join(KbChannel, col(KbChannel.id) == col(KbVideo.kb_channel_id))
        .where(
            col(KbChannel.status).in_(_ACTIVE),
            KbVideo.fetch_status == indexing.PENDING,
            or_(
                col(KbVideo.next_attempt_at).is_(None),
                col(KbVideo.next_attempt_at) <= now,
            ),
        )
        .order_by(col(KbChannel.created_at), col(KbVideo.position))
        .limit(1)
    ).first()


def fetch_next_video() -> bool:
    """Fetch one video's captions if one is due. True when a fetch ran."""
    with Session(get_engine()) as session:
        video = _next_video(session)
        if video is None:
            return False
        video_id = require_id(video)
        yt_id = video.yt_id
        title = video.title or yt_id
        result = captions.from_library(session, yt_id)
        if result is None:
            if next_due_video(session) is not None:
                return False
            pacer = current().timedtext
            if not pacer.try_reserve_background(FETCH_SPACING_SEC):
                return False
    if result is None:
        with activity.track(
            "ask", "Fetching captions for Ask", engine="yt-dlp", detail=title
        ):
            result = captions.fetch_remote(yt_id)
    with Session(get_engine()) as session:
        video = session.get(KbVideo, video_id)
        if video is None:  # its channel was removed meanwhile
            return True
        backoff = indexing.apply_result(session, video, result)
        indexing.finish_if_done(session, video.kb_channel_id)
    if backoff:
        current().timedtext.block(backoff)
        logger.info("Ask: captions rate limited; everyone waits %ss", backoff)
    return True


def _loop(worker: BackgroundWorker) -> None:
    try:
        recover()
    except Exception:
        logger.warning("Ask: recovering channels failed", exc_info=True)
    if worker.sleep(STARTUP_DELAY_SEC):
        return
    while not worker.stopping:
        worked = False
        try:
            worked = list_due_channel() or fetch_next_video()
        except Exception:
            logger.warning("Ask: worker pass failed", exc_info=True)
        if worked:
            continue
        wait = max(
            1.0, min(IDLE_POLL_SEC, current().timedtext.seconds_until_background())
        )
        if worker.wait_for_wake(wait if _has_pending() else IDLE_POLL_SEC):
            return


def _has_pending() -> bool:
    with Session(get_engine()) as session:
        return _next_video(session) is not None


def create_worker() -> BackgroundWorker:
    return BackgroundWorker("ask", _loop, wake_event=current().knowledge.wake)

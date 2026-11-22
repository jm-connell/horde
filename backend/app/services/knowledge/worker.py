"""The Ask worker: lists channels' uploads and fetches their captions, one at a time.

Each pass does one unit of work, in this order:

1. list a channel that is new, failed listing an hour ago, or was last listed a
   day ago (new uploads join this way);
2. fetch the next video's captions, newest uploads first and channels in
   turn (each channel's newest, then each one's next). A library copy is
   read straight away; a YouTube fetch waits until no
   library caption retry is due and the pacer's background slot is free
   (``services/timedtext.py``), so library caption work always goes first;
3. ask SponsorBlock about the next video not asked yet (``sponsorblock.step``).
   A video whose captions were just stored is asked right away when the
   SponsorBlock pacer allows, after the captions are committed.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta

from sqlmodel import Session, col, or_, select

from ...context import current, get_engine
from ...models import KbChannel, KbChannelStatus, KbVideo, as_utc, require_id, utcnow
from .. import activity
from ..follows import normalize_channel_url
from ..subtitle_retry import next_due_video
from ..workers import BackgroundWorker
from ..ytdlp_common import classify_ytdlp_error
from . import captions, embed, indexing, listing, sponsorblock, subscriptions
from . import channels as kb_channels

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
        max_videos = kb_channels.effective_limit(channel)
        first_listing = channel.last_listed_at is None
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
        if isinstance(exc, listing.ChannelNotFound):
            message = "YouTube has no channel at this address"
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
        # Removed, paused or its streams choice changed while listing.
        if (
            channel is None
            or channel.status != KbChannelStatus.listing
            or channel.include_streams != include_streams
        ):
            return True
        if first_listing and _is_duplicate(session, channel, found):
            logger.info("Ask: %s is a channel Ask already has; dropped", name)
            kb_channels.remove(session, channel)
            return True
        added = indexing.apply_listing(session, channel, found, max_videos)
        # SponsorBlock segments are often submitted days after upload.
        sponsorblock.mark_recent_due(session, channel_id)
        indexing.finish_if_done(session, channel_id)
    logger.info("Ask: listed %s (%s new)", name, added)
    return True


def _is_duplicate(session: Session, channel: KbChannel, found: listing.Listing) -> bool:
    """A channel added by a subscription's address (``subscriptions.py``) that
    YouTube knows under the address of a channel Ask already has."""
    canonical = normalize_channel_url(found.channel_url or "")
    if not canonical or canonical == channel.channel_url:
        return False
    other = session.exec(
        select(KbChannel.id).where(KbChannel.channel_url == canonical)
    ).first()
    return other is not None


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
        # Channels in turn, newest uploads first: each channel's newest
        # video, then each one's next. One at a time, the last channel added
        # waited hours for its first answer.
        .order_by(col(KbVideo.position), col(KbChannel.created_at))
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
        has_captions = video.fetch_status == captions.FETCHED
    if result.status in (captions.FETCHED, captions.NO_CAPTIONS):
        _queue_embedding()
    if has_captions:
        # Committed above: the request holds no database lock.
        _refresh_sponsor_segments(video_id, yt_id)
    if backoff:
        current().timedtext.block(backoff)
        logger.info("Ask: captions rate limited; everyone waits %ss", backoff)
    return True


def _refresh_sponsor_segments(video_id: int, yt_id: str) -> None:
    try:
        sponsorblock.refresh(video_id, yt_id)
    except Exception:
        logger.warning("Ask: storing SponsorBlock segments failed", exc_info=True)


def _queue_embedding() -> None:
    try:
        embed.ensure_jobs()
    except Exception:
        logger.warning("Ask: queueing embeddings failed", exc_info=True)


def _loop(worker: BackgroundWorker) -> None:
    try:
        recover()
    except Exception:
        logger.warning("Ask: recovering channels failed", exc_info=True)
    if worker.sleep(STARTUP_DELAY_SEC):
        return
    try:
        subscriptions.add_subscribed_once()
    except Exception:
        logger.warning("Ask: adding subscribed channels failed", exc_info=True)
    # Idle passes come every 3 s during a SponsorBlock backfill: check
    # embeddings no more often than captions are fetched.
    embeddings_checked = -float(FETCH_SPACING_SEC)
    while not worker.stopping:
        worked = False
        try:
            worked = list_due_channel() or fetch_next_video() or sponsorblock.step()
        except Exception:
            logger.warning("Ask: worker pass failed", exc_info=True)
        if worked:
            continue
        # Also catches a changed embedding model or a provider set up later.
        if time.monotonic() - embeddings_checked >= FETCH_SPACING_SEC:
            embeddings_checked = time.monotonic()
            _queue_embedding()
        wait: float = IDLE_POLL_SEC
        if _has_pending():
            wait = min(wait, current().timedtext.seconds_until_background())
        if sponsorblock.has_due():
            wait = min(wait, current().knowledge.sponsor.seconds_until_free())
        if worker.wait_for_wake(max(1.0, wait)):
            return


def _has_pending() -> bool:
    with Session(get_engine()) as session:
        return _next_video(session) is not None


def create_worker() -> BackgroundWorker:
    return BackgroundWorker("ask", _loop, wake_event=current().knowledge.wake)

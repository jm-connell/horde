"""Store listings and caption results in the Ask tables."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, update
from sqlmodel import Session, col, func, select

from ...models import KbChannel, KbChannelStatus, KbChunk, KbVideo, require_id, utcnow
from ..subtitle_retry import backoff_seconds
from . import captions, chunking
from .listing import MAX_PER_TAB, Listing

# Failures other than rate limits: retry this many times, an hour apart and growing.
MAX_ATTEMPTS = 3
# Rate limits and bot checks: back off this many times before giving up.
MAX_RETRIES = 6
_FAILED_RETRY = timedelta(hours=1)
PENDING = "pending"
# States after which a video is not fetched again.
_FINAL = (captions.FETCHED, captions.NO_CAPTIONS, captions.MEMBERS_ONLY)


def delete_videos(session: Session, video_ids: list[int]) -> None:
    """Delete in batches so the FTS triggers never hold the write lock for long."""
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i : i + 50]
        session.execute(delete(KbChunk).where(col(KbChunk.kb_video_id).in_(batch)))
        session.execute(delete(KbVideo).where(col(KbVideo.id).in_(batch)))
        session.commit()


def apply_listing(
    session: Session, channel: KbChannel, listing: Listing, limit: int
) -> int:
    """Upsert the listed uploads; returns how many are new. Rows that left the
    listing go when they are older than what the channel indexes now: their
    tab (uploads or streams) listed the whole limit, so new uploads pushed them
    out, or they sat beyond a lowered limit. Otherwise they are kept (a video
    YouTube no longer lists, or a listing that ended early)."""
    channel_id = require_id(channel)
    existing = {
        v.yt_id: v
        for v in session.exec(
            select(KbVideo).where(KbVideo.kb_channel_id == channel_id)
        ).all()
    }
    added = 0
    for upload in listing.uploads:
        row = existing.get(upload.yt_id)
        if row is None:
            row = KbVideo(kb_channel_id=channel_id, yt_id=upload.yt_id)
            existing[upload.yt_id] = row
            added += 1
        row.title = upload.title or row.title
        row.published_at = upload.published_at or row.published_at
        row.duration = upload.duration if upload.duration is not None else row.duration
        row.is_stream = upload.is_stream
        row.position = upload.position
        session.add(row)
    if listing.channel_name:
        channel.channel_name = listing.channel_name
    channel.last_listed_at = utcnow()
    channel.last_error = None
    channel.updated_at = utcnow()
    session.add(channel)
    # Only while still listing: a pause or a changed streams choice meanwhile wins.
    session.execute(
        update(KbChannel)
        .where(
            col(KbChannel.id) == channel_id,
            col(KbChannel.status) == KbChannelStatus.listing,
        )
        .values(status=KbChannelStatus.indexing)
    )
    session.commit()
    listed = {upload.yt_id for upload in listing.uploads}
    cap = min(limit, MAX_PER_TAB)
    full = {
        is_stream
        for is_stream in (False, True)
        if sum(1 for u in listing.uploads if u.is_stream == is_stream) >= cap
    }
    delete_videos(
        session,
        [
            require_id(row)
            for yt_id, row in existing.items()
            if yt_id not in listed and (row.is_stream in full or row.position >= limit)
        ],
    )
    return added


def _replace_chunks(
    session: Session, video: KbVideo, lines: list[chunking.Line]
) -> None:
    video_id = require_id(video)
    session.execute(delete(KbChunk).where(col(KbChunk.kb_video_id) == video_id))
    meta = chunking.metadata_text(video.title, video.description)
    if meta:
        session.add(
            KbChunk(
                kb_video_id=video_id,
                kb_channel_id=video.kb_channel_id,
                chunk_index=chunking.META_CHUNK_INDEX,
                text=meta,
            )
        )
    for passage in chunking.build_passages(lines):
        session.add(
            KbChunk(
                kb_video_id=video_id,
                kb_channel_id=video.kb_channel_id,
                chunk_index=passage.index,
                start_sec=passage.start_sec,
                end_sec=passage.end_sec,
                text=passage.text,
            )
        )
    video.embedded_model = None


def apply_result(
    session: Session, video: KbVideo, result: captions.CaptionResult
) -> int | None:
    """Record a caption fetch. Returns the back-off in seconds after a rate limit."""
    now = datetime.now(UTC)
    video.updated_at = now
    if result.description and not video.description:
        video.description = result.description
    if result.published_at:
        # From the video itself: the listing only knows "3 years ago".
        video.published_at = result.published_at
    backoff: int | None = None
    if result.status == captions.FETCHED:
        lines = chunking.lines_from_vtt(result.vtt)
        video.cues = chunking.pack_lines(lines) if lines else None
        video.caption_auto = result.auto
        video.fetch_status = captions.FETCHED if lines else captions.NO_CAPTIONS
        _replace_chunks(session, video, lines)
    elif result.status == captions.NO_CAPTIONS:
        video.fetch_status = captions.NO_CAPTIONS
        # The title and description are still worth finding.
        _replace_chunks(session, video, [])
    elif result.status == captions.MEMBERS_ONLY:
        video.fetch_status = captions.MEMBERS_ONLY
    elif result.status == captions.RETRY:
        video.attempts += 1
        backoff = backoff_seconds(video.attempts)
        if video.attempts >= MAX_RETRIES:
            # A bot check or PO token problem that never clears: stop asking.
            video.fetch_status = captions.FAILED
        else:
            video.next_attempt_at = now + timedelta(seconds=backoff)
    else:
        video.attempts += 1
        if video.attempts >= MAX_ATTEMPTS:
            video.fetch_status = captions.FAILED
        else:
            video.next_attempt_at = now + _FAILED_RETRY * video.attempts
    session.add(video)
    session.commit()
    return backoff


def finish_if_done(session: Session, channel_id: int) -> None:
    """An indexing channel with nothing left to fetch becomes ready."""
    channel = session.get(KbChannel, channel_id)
    if channel is None or channel.status != KbChannelStatus.indexing:
        return
    pending = session.exec(
        select(func.count(col(KbVideo.id))).where(
            KbVideo.kb_channel_id == channel_id, KbVideo.fetch_status == PENDING
        )
    ).one()
    if pending == 0:
        channel.status = KbChannelStatus.ready
        channel.updated_at = utcnow()
        session.add(channel)
        session.commit()


def is_final(status: str) -> bool:
    return status in _FINAL

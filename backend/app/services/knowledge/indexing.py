"""Store listings and caption results in the Ask tables."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlmodel import Session, col, func, select

from ...models import KbChannel, KbChannelStatus, KbChunk, KbVideo, require_id, utcnow
from ..subtitle_retry import backoff_seconds
from . import captions, chunking
from .listing import Listing

# Failures other than rate limits: retry this many times, an hour apart and growing.
MAX_ATTEMPTS = 3
_FAILED_RETRY = timedelta(hours=1)
PENDING = "pending"
# States after which a video is not fetched again.
_FINAL = (captions.FETCHED, captions.NO_CAPTIONS, captions.MEMBERS_ONLY)


def apply_listing(session: Session, channel: KbChannel, listing: Listing) -> int:
    """Upsert the listed uploads; returns how many are new. Unlisted rows are kept."""
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
    channel.status = KbChannelStatus.indexing
    channel.updated_at = utcnow()
    session.add(channel)
    session.commit()
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

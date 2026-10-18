"""The upload that clearly continues a video: its channel's next upload, if a series.

Looked up in the channel's catalog (the indexed uploads, ``position`` 0 =
newest) when the channel is indexed, otherwise among the channel's downloaded
videos by publish date. Only the very next listed upload is considered, and
only when its title continues the series (``series_titles``): a channel whose
next upload is something else gets no next part, and the player falls back to
a related recommendation.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session, col, select

from ..models import ChannelCatalog, ChannelCatalogVideo, Video, require_id
from .channel_catalog.query import is_hidden_catalog_video
from .channel_catalog.skips import skipped_yt_ids
from .series_titles import next_part_reason

#: Uploads read to tell a series tag from the channel's usual format.
_CONTEXT_TITLES = 50
#: Newer uploads scanned past hidden ones (Shorts, skipped, live) for the next.
_SCAN = 25
_NOT_PLAYABLE_YET = {"is_live", "is_upcoming"}


@dataclass(frozen=True)
class NextPart:
    url: str
    yt_id: str | None
    title: str
    channel: str | None
    channel_url: str | None
    duration: float | None
    thumbnail_url: str | None
    published_at: str | None
    video_id: int | None
    reason: str


def _library_id(session: Session, yt_id: str | None) -> int | None:
    if not yt_id:
        return None
    row = session.exec(select(Video.id).where(Video.youtube_id == yt_id)).first()
    return row


def _from_catalog(session: Session, video: Video) -> NextPart | None:
    rows = session.exec(
        select(ChannelCatalogVideo).where(ChannelCatalogVideo.yt_id == video.youtube_id)
    ).all()
    for current in rows:
        catalog = session.get(ChannelCatalog, current.catalog_id)
        if catalog is None:
            continue
        skipped = skipped_yt_ids(session, require_id(catalog))
        newer = session.exec(
            select(ChannelCatalogVideo)
            .where(ChannelCatalogVideo.catalog_id == current.catalog_id)
            .where(col(ChannelCatalogVideo.position) < current.position)
            .order_by(col(ChannelCatalogVideo.position).desc())
            .limit(_SCAN)
        ).all()
        candidate = next(
            (
                row
                for row in newer
                if row.live_status not in _NOT_PLAYABLE_YET
                and not is_hidden_catalog_video(row, skipped)
            ),
            None,
        )
        if candidate is None or not candidate.title:
            continue
        context = session.exec(
            select(ChannelCatalogVideo.title)
            .where(ChannelCatalogVideo.catalog_id == current.catalog_id)
            .order_by(col(ChannelCatalogVideo.position).asc())
            .limit(_CONTEXT_TITLES)
        ).all()
        reason = next_part_reason(
            video.title,
            candidate.title,
            channel_name=catalog.channel_name or video.channel,
            channel_titles=[
                t for t in context if t and t not in (video.title, candidate.title)
            ],
        )
        if reason is None:
            return None
        return NextPart(
            url=candidate.url,
            yt_id=candidate.yt_id,
            title=candidate.title,
            channel=catalog.channel_name or video.channel,
            channel_url=catalog.channel_url,
            duration=candidate.duration,
            thumbnail_url=candidate.thumbnail_url,
            published_at=candidate.published_at,
            video_id=_library_id(session, candidate.yt_id),
            reason=reason,
        )
    return None


def _from_library(session: Session, video: Video) -> NextPart | None:
    if video.published_at is None or not (video.channel_url or video.channel):
        return None
    same_channel = (
        col(Video.channel_url) == video.channel_url
        if video.channel_url
        else col(Video.channel) == video.channel
    )
    candidate = session.exec(
        select(Video)
        .where(same_channel)
        .where(col(Video.published_at) > video.published_at)
        .order_by(col(Video.published_at).asc())
        .limit(1)
    ).first()
    if candidate is None:
        return None
    context = session.exec(
        select(Video.title)
        .where(same_channel)
        .order_by(col(Video.published_at).desc())
        .limit(_CONTEXT_TITLES)
    ).all()
    reason = next_part_reason(
        video.title,
        candidate.title,
        channel_name=video.channel,
        channel_titles=[t for t in context if t not in (video.title, candidate.title)],
    )
    if reason is None:
        return None
    return NextPart(
        url=candidate.source_url or f"/watch/{require_id(candidate)}",
        yt_id=candidate.youtube_id,
        title=candidate.title,
        channel=candidate.channel,
        channel_url=candidate.channel_url,
        duration=candidate.duration_sec,
        thumbnail_url=None,
        published_at=(
            candidate.published_at.isoformat() if candidate.published_at else None
        ),
        video_id=require_id(candidate),
        reason=reason,
    )


def find_next_part(session: Session, video: Video) -> NextPart | None:
    """The clearly-next upload after ``video``, downloaded or not, or None."""
    if video.youtube_id:
        found = _from_catalog(session, video)
        if found is not None:
            return found
        # An indexed channel answered "not a series": trust it over the library.
        indexed = session.exec(
            select(ChannelCatalogVideo.id).where(
                ChannelCatalogVideo.yt_id == video.youtube_id
            )
        ).first()
        if indexed is not None:
            return None
    return _from_library(session, video)

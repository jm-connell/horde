"""The upload that clearly continues a video: its channel's next upload, if a series.

Looked up in the channel's catalog (the indexed uploads, ``position`` 0 =
newest) when the channel is indexed, otherwise among the channel's downloaded
videos by publish date. The very next upload counts when its title continues
the series by any rule (``series_titles.next_part_reason``). Failing that, the
first later upload that is the next numbered part of a named series
(``numbered_next``: "Cities Skylines #2" -> "#3") wins, past unrelated uploads
in between. Otherwise there is no next part, and the player falls back to a
related recommendation.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import partial

from sqlmodel import Session, col, select

from ..models import ChannelCatalog, ChannelCatalogVideo, Video, require_id
from ..schemas import ChannelFeedEntry
from .channel_catalog.query import is_hidden_catalog_video
from .channel_catalog.skips import skipped_yt_ids
from .series_titles import next_part_reason, numbered_next

#: Uploads read to tell a series tag from the channel's usual format.
_CONTEXT_TITLES = 50
#: Later uploads scanned for the next numbered part.
_SCAN = 50
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

    def to_entry(self) -> ChannelFeedEntry:
        return ChannelFeedEntry(
            id=self.yt_id,
            url=self.url,
            title=self.title,
            duration=self.duration,
            thumbnail_url=self.thumbnail_url,
            published_at=self.published_at,
            channel=self.channel,
            channel_url=self.channel_url,
            in_library=self.video_id is not None,
            video_id=self.video_id,
        )


def _pick[T](
    prev_title: str,
    later: Sequence[T],
    title_of: Callable[[T], str | None],
    channel_titles: Callable[[], Sequence[str | None]],
    channel_name: str | None,
) -> tuple[T, str] | None:
    """The next part among ``later`` (oldest first) and why, or None.

    The very next upload may continue by any rule (``next_part_reason``);
    later ones only as the next numbered part of a named series.
    ``channel_titles`` reads the channel's recent titles for the tag rule.
    """
    if not later:
        return None
    first_title = title_of(later[0])
    if first_title:
        reason = next_part_reason(
            prev_title,
            first_title,
            channel_name=channel_name,
            channel_titles=[
                t for t in channel_titles() if t and t not in (prev_title, first_title)
            ],
        )
        if reason:
            return later[0], reason
    for item in later[1:]:
        title = title_of(item)
        reason = (
            numbered_next(prev_title, title, channel_name=channel_name)
            if title
            else None
        )
        if reason:
            return item, reason
    return None


def _library_id(session: Session, yt_id: str | None) -> int | None:
    if not yt_id:
        return None
    # A video still waiting in Import review is not in the library yet.
    row = session.exec(
        select(Video.id).where(
            Video.youtube_id == yt_id,
            Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
        )
    ).first()
    return row


def _catalog_titles(session: Session, catalog_id: int) -> Sequence[str | None]:
    return session.exec(
        select(ChannelCatalogVideo.title)
        .where(ChannelCatalogVideo.catalog_id == catalog_id)
        .order_by(col(ChannelCatalogVideo.position).asc())
        .limit(_CONTEXT_TITLES)
    ).all()


def _from_catalog(
    session: Session, yt_id: str, title: str | None, channel: str | None
) -> NextPart | None:
    """``title`` defaults to the indexed title of ``yt_id``."""
    rows = session.exec(
        select(ChannelCatalogVideo).where(ChannelCatalogVideo.yt_id == yt_id)
    ).all()
    for current in rows:
        catalog = session.get(ChannelCatalog, current.catalog_id)
        prev_title = title or current.title
        if catalog is None or not prev_title:
            continue
        skipped = skipped_yt_ids(session, require_id(catalog))
        newer = session.exec(
            select(ChannelCatalogVideo)
            .where(ChannelCatalogVideo.catalog_id == current.catalog_id)
            .where(col(ChannelCatalogVideo.position) < current.position)
            .order_by(col(ChannelCatalogVideo.position).desc())
            .limit(_SCAN)
        ).all()
        later = [
            row
            for row in newer
            if row.live_status not in _NOT_PLAYABLE_YET
            and not is_hidden_catalog_video(row, skipped)
        ]
        if not later:
            continue
        channel_name = catalog.channel_name or channel
        picked = _pick(
            prev_title,
            later,
            lambda row: row.title,
            partial(_catalog_titles, session, current.catalog_id),
            channel_name,
        )
        if picked is None:
            return None
        candidate, reason = picked
        return NextPart(
            url=candidate.url,
            yt_id=candidate.yt_id,
            title=candidate.title or "",
            channel=channel_name,
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
    later = session.exec(
        select(Video)
        .where(same_channel)
        .where(col(Video.published_at) > video.published_at)
        .order_by(col(Video.published_at).asc())
        .limit(_SCAN)
    ).all()

    def channel_titles() -> Sequence[str]:
        return session.exec(
            select(Video.title)
            .where(same_channel)
            .order_by(col(Video.published_at).desc())
            .limit(_CONTEXT_TITLES)
        ).all()

    picked = _pick(video.title, later, lambda v: v.title, channel_titles, video.channel)
    if picked is None:
        return None
    candidate, reason = picked
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


def find_stream_next_part(session: Session, yt_id: str) -> NextPart | None:
    """The clearly-next upload after the indexed upload ``yt_id`` (a stream), or None."""
    return _from_catalog(session, yt_id, None, None)


def find_next_part(session: Session, video: Video) -> NextPart | None:
    """The clearly-next upload after ``video``, downloaded or not, or None."""
    if video.youtube_id:
        found = _from_catalog(session, video.youtube_id, video.title, video.channel)
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

"""Members-only / skip-list helpers for channel catalogs (leaf module).

A skip row has a reason. ``members_only`` and ``cookies`` mean the video cannot be
played or downloaded, so it also leaves the channel feed, related and next-part
views. ``deleted`` means a user deleted the downloaded copy: the video stays
visible everywhere (as "not downloaded", so it can be fetched by hand) and only
keeps the automatic download from fetching it again.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlmodel import Session, col, select

from ...context import get_engine
from ...models import (
    AiJob,
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogSkip,
    ChannelCatalogVideo,
    Video,
    require_id,
    utcnow,
)
from .. import feed_meta_cache
from ..ytdlp_common import (
    ERROR_KIND_COOKIES,
    catalog_skip_message,
    is_age_restricted_entry,
    is_members_only_entry,
)

#: Skip reason for a video a user deleted (see the module docstring).
DELETED = "deleted"


def skipped_yt_ids(session: Session, catalog_id: int) -> set[str]:
    """Videos the catalog hides: unplayable ones, not the ones a user deleted."""
    rows = session.exec(
        select(ChannelCatalogSkip.yt_id).where(
            ChannelCatalogSkip.catalog_id == catalog_id,
            ChannelCatalogSkip.reason != DELETED,
        )
    ).all()
    return {str(yt_id) for yt_id in rows if yt_id}


def deleted_yt_ids(session: Session, catalog_ids: Iterable[int]) -> set[str]:
    """Videos a user deleted from these catalogs: automatic download skips them."""
    ids = set(catalog_ids)
    if not ids:
        return set()
    rows = session.exec(
        select(ChannelCatalogSkip.yt_id).where(
            col(ChannelCatalogSkip.catalog_id).in_(ids),
            ChannelCatalogSkip.reason == DELETED,
        )
    ).all()
    return {str(yt_id) for yt_id in rows if yt_id}


def is_skipped(session: Session, catalog_id: int, yt_id: str) -> bool:
    row = session.exec(
        select(ChannelCatalogSkip).where(
            ChannelCatalogSkip.catalog_id == catalog_id,
            ChannelCatalogSkip.yt_id == yt_id,
            ChannelCatalogSkip.reason != DELETED,
        )
    ).first()
    return row is not None


def record_catalog_skip(
    session: Session,
    catalog_id: int,
    yt_id: str,
    *,
    reason: str = "members_only",
    commit: bool = False,
) -> None:
    yt_id = str(yt_id)
    existing = session.exec(
        select(ChannelCatalogSkip).where(
            ChannelCatalogSkip.catalog_id == catalog_id,
            ChannelCatalogSkip.yt_id == yt_id,
        )
    ).first()
    if existing is None:
        session.add(
            ChannelCatalogSkip(
                catalog_id=catalog_id,
                yt_id=yt_id,
                reason=reason,
                skipped_at=utcnow(),
            )
        )
    elif existing.reason == DELETED and reason != DELETED:
        # Not downloadable after all: it has to leave the feed, not just auto-download.
        existing.reason = reason
        existing.skipped_at = utcnow()
        session.add(existing)
    if commit:
        session.commit()


def record_deleted_video(session: Session, video: Video) -> None:
    """Keep automatic download from fetching ``video`` again after a user deleted it.

    The one function every user or retention delete of downloaded media calls (the
    trash move, and the permanent delete when the trash is off). Records a
    ``deleted`` skip in each catalog that lists the video or belongs to its channel;
    a video of no indexed channel needs none. Part of the caller's transaction.
    """
    from .runtime import get_catalog_by_url

    yt_id = video.youtube_id
    if not yt_id:
        return
    catalog_ids = set(
        session.exec(
            select(ChannelCatalogVideo.catalog_id).where(
                ChannelCatalogVideo.yt_id == yt_id
            )
        ).all()
    )
    if video.channel_url:
        catalog = get_catalog_by_url(session, video.channel_url)
        if catalog is not None:
            catalog_ids.add(require_id(catalog))
    for catalog_id in catalog_ids:
        record_catalog_skip(session, catalog_id, yt_id, reason=DELETED)


def clear_deleted(session: Session, yt_id: str | None) -> None:
    """Forget that ``yt_id`` was deleted (restored, or a user asked for it again).

    Part of the caller's transaction.
    """
    if not yt_id:
        return
    for skip in session.exec(
        select(ChannelCatalogSkip).where(
            ChannelCatalogSkip.yt_id == yt_id,
            ChannelCatalogSkip.reason == DELETED,
        )
    ).all():
        session.delete(skip)


def record_members_only_skip(
    session: Session,
    catalog_id: int,
    yt_id: str,
    *,
    commit: bool = False,
) -> None:
    record_catalog_skip(
        session, catalog_id, yt_id, reason="members_only", commit=commit
    )


def delete_catalog_video_row(session: Session, row: ChannelCatalogVideo) -> None:
    """Delete a catalog video plus embedding and AI jobs. Does not record a skip."""
    video_id = row.id
    if video_id is None:
        return
    emb = session.exec(
        select(ChannelCatalogEmbedding).where(
            ChannelCatalogEmbedding.catalog_video_id == video_id
        )
    ).first()
    if emb is not None:
        session.delete(emb)
    for job in session.exec(
        select(AiJob).where(AiJob.catalog_video_id == video_id)
    ).all():
        session.delete(job)
    session.delete(row)


def purge_catalog_video(
    session: Session,
    row: ChannelCatalogVideo,
    *,
    reason: str = "members_only",
    commit: bool = True,
) -> None:
    """Delete catalog video + embedding + AI jobs, drop feed cache, record skip."""
    catalog_id = row.catalog_id
    yt_id = row.yt_id

    delete_catalog_video_row(session, row)

    record_catalog_skip(session, catalog_id, yt_id, reason=reason)
    feed_meta_cache.drop(yt_id)
    if commit:
        session.commit()


def purge_members_only_by_yt_id(yt_id: str) -> None:
    """Purge any catalog rows for a YouTube id and record skips (all catalogs)."""
    yt_id = str(yt_id).strip()
    if not yt_id:
        return
    with Session(get_engine()) as session:
        rows = session.exec(
            select(ChannelCatalogVideo).where(ChannelCatalogVideo.yt_id == yt_id)
        ).all()
        for row in rows:
            purge_catalog_video(session, row, commit=False)
        session.commit()
        feed_meta_cache.drop(yt_id)


def _skip_reason_for_entry(raw: dict[str, Any]) -> str | None:
    if is_members_only_entry(raw):
        return "members_only"
    if is_age_restricted_entry(raw):
        return "cookies"
    return None


def _reject_members_or_skipped(
    session: Session,
    catalog: ChannelCatalog,
    raw: dict[str, Any],
    *,
    skipped: set[str] | None = None,
    allow_gated: bool = False,
) -> str | None:
    """If entry must be ignored, purge any existing row and return yt_id; else None."""
    yt_id = raw.get("id")
    if not yt_id:
        return None
    yt_id = str(yt_id)
    skip_set = (
        skipped if skipped is not None else skipped_yt_ids(session, require_id(catalog))
    )
    reason = _skip_reason_for_entry(raw)
    if reason is not None and allow_gated:
        # Full catalog index can keep the row so a later per-video extract
        # retries with cookies. Feed-head sync stays anonymous and skips.
        reason = None
    if reason is None and yt_id not in skip_set:
        return None
    skip_reason = reason or "members_only"
    existing = session.exec(
        select(ChannelCatalogVideo).where(
            ChannelCatalogVideo.catalog_id == catalog.id,
            ChannelCatalogVideo.yt_id == yt_id,
        )
    ).first()
    if existing is not None:
        purge_catalog_video(session, existing, reason=skip_reason, commit=False)
    elif catalog.id is not None:
        record_catalog_skip(session, catalog.id, yt_id, reason=skip_reason)
    if reason == "cookies" and not catalog.last_error:
        catalog.last_error = catalog_skip_message(
            ERROR_KIND_COOKIES,
            url=str(raw.get("url") or "") or None,
            title=raw.get("title") if isinstance(raw.get("title"), str) else None,
            channel=catalog.channel_name,
        )[:500]
        session.add(catalog)
    return yt_id

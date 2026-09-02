"""Members-only / skip-list helpers for channel catalogs (leaf module)."""

from __future__ import annotations

from typing import Any, Optional

from sqlmodel import Session, select

from ...database import engine
from ...models import (
    AiJob,
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogSkip,
    ChannelCatalogVideo,
    utcnow,
)
from .. import feed_meta_cache
from ..ytdlp_common import is_members_only_entry

def skipped_yt_ids(session: Session, catalog_id: int) -> set[str]:
    rows = session.exec(
        select(ChannelCatalogSkip.yt_id).where(
            ChannelCatalogSkip.catalog_id == catalog_id
        )
    ).all()
    return {str(yt_id) for yt_id in rows if yt_id}


def is_skipped(session: Session, catalog_id: int, yt_id: str) -> bool:
    row = session.exec(
        select(ChannelCatalogSkip).where(
            ChannelCatalogSkip.catalog_id == catalog_id,
            ChannelCatalogSkip.yt_id == yt_id,
        )
    ).first()
    return row is not None


def record_members_only_skip(
    session: Session,
    catalog_id: int,
    yt_id: str,
    *,
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
                reason="members_only",
                skipped_at=utcnow(),
            )
        )
    if commit:
        session.commit()


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

    record_members_only_skip(session, catalog_id, yt_id)
    _ = reason
    feed_meta_cache.drop(yt_id)
    if commit:
        session.commit()


def purge_members_only_by_yt_id(yt_id: str) -> None:
    """Purge any catalog rows for a YouTube id and record skips (all catalogs)."""
    yt_id = str(yt_id).strip()
    if not yt_id:
        return
    with Session(engine) as session:
        rows = session.exec(
            select(ChannelCatalogVideo).where(ChannelCatalogVideo.yt_id == yt_id)
        ).all()
        for row in rows:
            purge_catalog_video(session, row, commit=False)
        session.commit()
        feed_meta_cache.drop(yt_id)


def _reject_members_or_skipped(
    session: Session,
    catalog: ChannelCatalog,
    raw: dict[str, Any],
    *,
    skipped: Optional[set[str]] = None,
) -> Optional[str]:
    """If entry must be ignored, purge any existing row and return yt_id; else None."""
    yt_id = raw.get("id")
    if not yt_id:
        return None
    yt_id = str(yt_id)
    skip_set = (
        skipped
        if skipped is not None
        else skipped_yt_ids(session, catalog.id)  # type: ignore[arg-type]
    )
    members = is_members_only_entry(raw) or yt_id in skip_set
    if not members:
        return None
    existing = session.exec(
        select(ChannelCatalogVideo).where(
            ChannelCatalogVideo.catalog_id == catalog.id,
            ChannelCatalogVideo.yt_id == yt_id,
        )
    ).first()
    if existing is not None:
        purge_catalog_video(session, existing, commit=False)
    elif catalog.id is not None:
        record_members_only_skip(session, catalog.id, yt_id)
    return yt_id



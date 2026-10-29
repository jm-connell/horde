"""Catalog refreshes and old completed jobs must not pile up AI job rows."""

from datetime import timedelta

from sqlmodel import select

from app.models import (
    AiJob,
    AiJobKind,
    AiJobStatus,
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    utcnow,
)
from app.services.ai import worker
from app.services.channel_catalog import catalog_content_hash
from app.services.channel_catalog.index import _enqueue_catalog_embeds


def _catalog_videos(
    session, titles: list[str]
) -> tuple[int, list[ChannelCatalogVideo]]:
    catalog = ChannelCatalog(
        channel_url="https://www.youtube.com/@someone",
        channel_name="Someone",
        status=ChannelCatalogStatus.ready,
    )
    session.add(catalog)
    session.commit()
    session.refresh(catalog)
    rows = []
    for i, title in enumerate(titles):
        row = ChannelCatalogVideo(
            catalog_id=catalog.id,
            yt_id=f"vid{i}",
            url=f"https://www.youtube.com/watch?v=vid{i}",
            title=title,
            position=i,
        )
        session.add(row)
        rows.append(row)
    session.commit()
    for row in rows:
        session.refresh(row)
    return catalog.id, rows


def _queued_catalog_ids(session) -> set[int | None]:
    session.expire_all()
    return {
        job.catalog_video_id
        for job in session.exec(
            select(AiJob).where(AiJob.kind == AiJobKind.embed_catalog_video)
        )
    }


def test_refresh_queues_only_catalog_videos_whose_text_changed(session):
    catalog_id, (unchanged, edited, new) = _catalog_videos(
        session, ["Same title", "New title", "Never embedded"]
    )
    session.add(
        ChannelCatalogEmbedding(
            catalog_video_id=unchanged.id, content_hash=catalog_content_hash(unchanged)
        )
    )
    session.add(ChannelCatalogEmbedding(catalog_video_id=edited.id, content_hash="old"))
    session.commit()

    _enqueue_catalog_embeds(catalog_id)

    assert _queued_catalog_ids(session) == {edited.id, new.id}


def test_prune_deletes_only_old_completed_jobs(session):
    old = utcnow() - timedelta(days=worker.COMPLETED_JOB_KEEP_DAYS + 1)
    rows = {
        "old_done": AiJob(
            kind=AiJobKind.refresh_categories,
            status=AiJobStatus.completed,
            updated_at=old,
        ),
        "recent_done": AiJob(
            kind=AiJobKind.refresh_categories, status=AiJobStatus.completed
        ),
        # Failures stay: they drive retries and the failed-jobs list.
        "old_error": AiJob(
            kind=AiJobKind.refresh_categories, status=AiJobStatus.error, updated_at=old
        ),
        "old_queued": AiJob(
            kind=AiJobKind.refresh_categories, status=AiJobStatus.queued, updated_at=old
        ),
    }
    for row in rows.values():
        session.add(row)
    session.commit()
    ids = {name: row.id for name, row in rows.items()}

    assert worker.prune_completed_jobs() == 1

    session.expire_all()
    left = {job.id for job in session.exec(select(AiJob))}
    assert left == {ids["recent_done"], ids["old_error"], ids["old_queued"]}

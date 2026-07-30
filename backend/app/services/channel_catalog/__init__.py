"""Channel catalog package — public API matches the former module."""

from .documents import catalog_content_hash, catalog_document
from .index import schedule_feed_head_sync, sync_feed_head
from .query import (
    catalog_feed_page,
    catalog_progress,
    search_all_catalogs,
    search_catalog,
    update_catalog_view_counts,
)
from .runtime import (
    enqueue_all_library_channels,
    enqueue_channel,
    get_catalog_by_url,
    get_runtime_status,
    maybe_enqueue_for_feed,
    recover_catalog_jobs,
    refresh_all_library_channels,
    refresh_stale_catalogs,
    start_catalog_worker,
    stop_catalog_worker,
)
from .skips import (
    is_skipped,
    purge_catalog_video,
    purge_members_only_by_yt_id,
    record_members_only_skip,
    skipped_yt_ids,
)

__all__ = [
    "catalog_content_hash",
    "catalog_document",
    "catalog_feed_page",
    "catalog_progress",
    "enqueue_all_library_channels",
    "enqueue_channel",
    "get_catalog_by_url",
    "get_runtime_status",
    "is_skipped",
    "maybe_enqueue_for_feed",
    "purge_catalog_video",
    "purge_members_only_by_yt_id",
    "record_members_only_skip",
    "recover_catalog_jobs",
    "refresh_all_library_channels",
    "refresh_stale_catalogs",
    "schedule_feed_head_sync",
    "search_all_catalogs",
    "search_catalog",
    "skipped_yt_ids",
    "start_catalog_worker",
    "stop_catalog_worker",
    "sync_feed_head",
    "update_catalog_view_counts",
]

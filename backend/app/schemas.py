from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict

from .models import JobStatus, PlaylistSource, VideoStatus


class SubtitleTrack(BaseModel):
    lang: str
    auto: bool = False


class VideoRead(BaseModel):
    id: int
    title: str
    channel: Optional[str]
    channel_url: Optional[str]
    tags: list[str]
    ai_tags: list[str] = []
    user_tags: list[str] = []
    description: Optional[str]
    notes: Optional[str]
    source_url: Optional[str]
    has_thumbnail: bool
    subtitles: list[SubtitleTrack]
    file_path: str
    duration_sec: Optional[float]
    file_size: Optional[int]
    width_px: Optional[int]
    height_px: Optional[int]
    frame_rate: Optional[float]
    view_count: Optional[int]
    channel_subscriber_count: Optional[int]
    published_at: Optional[datetime]
    added_at: datetime
    last_position_sec: float
    last_watched_at: Optional[datetime]
    needs_review: bool
    platform: Optional[str]
    status: VideoStatus
    metadata_synced_at: Optional[datetime]
    source_title: Optional[str]
    title_is_custom: bool
    subtitles_pending: bool = False


class VideoUpdate(BaseModel):
    title: Optional[str] = None
    channel: Optional[str] = None
    channel_url: Optional[str] = None
    tags: Optional[list[str]] = None
    user_tag: Optional[str] = None  # mark a newly added tag as user-defined
    description: Optional[str] = None
    notes: Optional[str] = None
    source_url: Optional[str] = None
    published_at: Optional[datetime] = None
    # Setting a remote URL fetches and caches the image server-side.
    thumbnail_url: Optional[str] = None


class WatchProgressUpdate(BaseModel):
    position_sec: float


class DownloadCreate(BaseModel):
    url: str
    quality_preset: str = "best"
    title_override: Optional[str] = None
    channel_override: Optional[str] = None
    notes_pending: Optional[str] = None
    normalize_volume: bool = False


class DownloadPreview(BaseModel):
    is_playlist: bool
    title: Optional[str]
    channel: Optional[str]
    channel_url: Optional[str]
    thumbnail_url: Optional[str] = None
    entry_count: Optional[int]
    view_count: Optional[int] = None
    available_presets: list[str] = []
    preset_sizes: dict[str, int] = {}


class StreamPreviewMeta(BaseModel):
    id: Optional[str] = None
    title: Optional[str] = None
    channel: Optional[str] = None
    channel_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    description: Optional[str] = None
    duration: Optional[float] = None
    view_count: Optional[int] = None
    source_url: Optional[str] = None
    preview_height: Optional[int] = None
    library_video_id: Optional[int] = None
    available_presets: list[str] = []


class DownloadJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    url: str
    quality_preset: str
    status: JobStatus
    progress: float
    title: Optional[str]
    title_override: Optional[str]
    channel: Optional[str]
    channel_override: Optional[str]
    thumbnail_url: Optional[str]
    notes_pending: Optional[str]
    paused: bool
    error: Optional[str]
    video_id: Optional[int]
    file_size: Optional[int]
    created_at: datetime


class DownloadJobUpdate(BaseModel):
    title_override: Optional[str] = None
    channel_override: Optional[str] = None
    notes_pending: Optional[str] = None


class DownloadQueueStatus(BaseModel):
    paused: bool
    active_count: int
    queued_count: int


class VideoRedownload(BaseModel):
    quality_preset: str = "best"
    normalize_volume: bool = False


class ChannelStat(BaseModel):
    channel: str
    count: int
    last_download_at: Optional[datetime] = None
    subscriber_count: Optional[int] = None
    channel_url: Optional[str] = None


class ChannelSearchHit(BaseModel):
    name: str
    url: str
    thumbnail_url: Optional[str] = None
    subscriber_count: Optional[int] = None


class ChannelSearchResponse(BaseModel):
    results: list[ChannelSearchHit] = []


class ChannelFeedEntry(BaseModel):
    id: Optional[str] = None
    url: str
    title: Optional[str] = None
    duration: Optional[float] = None
    thumbnail_url: Optional[str] = None
    view_count: Optional[int] = None
    published_at: Optional[str] = None
    in_library: bool = False
    video_id: Optional[int] = None
    library_height_px: Optional[int] = None
    max_height: Optional[int] = None


class ChannelFeedPage(BaseModel):
    channel: Optional[str] = None
    channel_url: Optional[str] = None
    entries: list[ChannelFeedEntry] = []
    has_more: bool = False
    indexing: bool = False
    from_catalog: bool = False
    catalog_indexed: int = 0
    catalog_total: Optional[int] = None
    catalog_complete: bool = False
    catalog_status: Optional[str] = None


class ChannelCatalogStatusItem(BaseModel):
    id: Optional[int] = None
    channel_url: str
    channel_name: Optional[str] = None
    status: str
    indexed_count: int = 0
    channel_total: Optional[int] = None
    complete: bool = False
    max_videos: int = 1000
    phase: Optional[str] = None
    last_error: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    updated_at: Optional[str] = None


class ChannelCatalogStatusResponse(BaseModel):
    enabled: bool = True
    running: bool = False
    current_channel: Optional[str] = None
    current_channel_url: Optional[str] = None
    current_phase: Optional[str] = None
    done: int = 0
    total: int = 0
    catalog_id: Optional[int] = None
    queue_depth: int = 0
    catalogs: list[ChannelCatalogStatusItem] = []


class ChannelCatalogIndexRequest(BaseModel):
    channel: Optional[str] = None
    url: Optional[str] = None
    force: bool = True


class ChannelCatalogIndexResult(BaseModel):
    queued: int = 0
    skipped: int = 0
    catalog_id: Optional[int] = None
    detail: str = ""


class TagStat(BaseModel):
    tag: str
    count: int


class StorageStats(BaseModel):
    total_bytes: int
    video_bytes: int
    thumbnail_bytes: int
    video_count: int


class ChannelRename(BaseModel):
    old_name: str
    new_name: str


class PlaylistCreate(BaseModel):
    name: str
    description: Optional[str] = None


class PlaylistUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class PlaylistRead(BaseModel):
    id: int
    name: str
    description: Optional[str]
    source_type: PlaylistSource
    source_url: Optional[str]
    created_at: datetime
    item_count: int


class PlaylistDetail(PlaylistRead):
    videos: list[VideoRead]


class PlaylistItemAdd(BaseModel):
    video_id: int


class PlaylistReorder(BaseModel):
    video_ids: list[int]


class PlaylistImport(BaseModel):
    url: str
    quality_preset: str = "best"
    name: Optional[str] = None
    entries: list[str] = []


class PlaylistPreviewEntry(BaseModel):
    id: Optional[str] = None
    url: str
    title: Optional[str] = None
    channel: Optional[str] = None
    duration: Optional[float] = None
    thumbnail_url: Optional[str] = None
    view_count: Optional[int] = None


class PlaylistPreview(BaseModel):
    title: Optional[str] = None
    channel: Optional[str] = None
    entries: list[PlaylistPreviewEntry] = []


class PlaylistSizeEstimateRequest(BaseModel):
    urls: list[str]


class PlaylistSizeEstimate(BaseModel):
    sizes: dict[str, dict[str, int]] = {}


class BulkVideoDelete(BaseModel):
    video_ids: list[int]
    delete_files: bool = False


class BulkVideoNotes(BaseModel):
    video_ids: list[int]
    notes: str


class BulkMetadataRefresh(BaseModel):
    video_ids: list[int] = []
    fields: list[str] = []  # views | thumbnails | captions | titles_descriptions | all


class MetadataRefreshResult(BaseModel):
    refreshed: int = 0
    failed: int = 0
    skipped: int = 0
    started: bool = False
    detail: str = ""
    total: int = 0


class MetadataSyncStatus(BaseModel):
    running: bool = False
    total: int = 0
    done: int = 0
    failed: int = 0
    skipped: int = 0
    current_title: Optional[str] = None
    current_video_id: Optional[int] = None
    fields: list[str] = []
    last_error: Optional[str] = None
    finished_at: Optional[str] = None


class BulkPlaylistAdd(BaseModel):
    video_ids: list[int]

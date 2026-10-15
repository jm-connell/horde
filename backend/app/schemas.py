from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator

from .models import DownloadDestination, JobStatus, PlaylistSource, VideoStatus


class SubtitleTrack(BaseModel):
    lang: str
    auto: bool = False


class SearchMatchReason(BaseModel):
    source: Literal[
        "title", "description", "tags", "notes", "captions", "related", "youtube"
    ]
    snippet: str | None = None


class ChapterRead(BaseModel):
    start_sec: float
    title: str


class CompatState(BaseModel):
    kind: str = "compat"
    status: str  # none | queued | running | ready | error
    stage: str | None = None
    progress: float = 0.0
    error: str | None = None


class VideoRead(BaseModel):
    id: int
    title: str
    channel: str | None
    channel_url: str | None
    tags: list[str]
    ai_tags: list[str] = []
    user_tags: list[str] = []
    description: str | None
    notes: str | None
    source_url: str | None
    has_thumbnail: bool
    has_sprites: bool = False
    subtitles: list[SubtitleTrack]
    file_path: str
    duration_sec: float | None
    file_size: int | None
    width_px: int | None
    height_px: int | None
    frame_rate: float | None
    # Actual on-disk stream (ffprobe), for client decode checks.
    vcodec: str | None = None
    acodec: str | None = None
    codec_string: str | None = None
    bit_depth: int | None = None
    is_hdr: bool = False
    # ≤1080p H.264 sidecar: compact lists only report has_compat.
    has_compat: bool = False
    compat_size: int | None = None
    compat: Optional["CompatState"] = None
    view_count: int | None
    channel_subscriber_count: int | None
    published_at: datetime | None
    added_at: datetime
    last_position_sec: float
    last_watched_at: datetime | None
    needs_review: bool
    platform: str | None
    status: VideoStatus
    metadata_synced_at: datetime | None
    source_title: str | None
    source_description: str | None = None
    title_is_custom: bool
    description_is_custom: bool = False
    subtitles_pending: bool = False
    ai_summary: str | None = None
    ai_summary_length: str | None = None
    ai_summary_cost: float | None = None
    ai_summary_model: str | None = None
    embed_status: str | None = None
    embed_error: str | None = None
    tags_enriched_at: datetime | None = None
    processing_summary: bool = False
    processing_sprites: bool = False
    processing_chapters: bool = False
    chapters: list[ChapterRead] = []
    chapters_source: Literal["description", "source", "ai"] | None = None
    match_reason: SearchMatchReason | None = None


class VideoUpdate(BaseModel):
    title: str | None = None
    channel: str | None = None
    channel_url: str | None = None
    tags: list[str] | None = None
    user_tag: str | None = None  # mark a newly added tag as user-defined
    description: str | None = None
    notes: str | None = None
    source_url: str | None = None
    published_at: datetime | None = None
    # Setting a remote URL fetches and caches the image server-side.
    thumbnail_url: str | None = None
    # Explicit clear/set for "Use source" / keep-custom flows.
    title_is_custom: bool | None = None
    description_is_custom: bool | None = None


class WatchProgressUpdate(BaseModel):
    position_sec: float


class DownloadCreate(BaseModel):
    url: str
    quality_preset: str = "best"
    title_override: str | None = None
    channel_override: str | None = None
    notes_pending: str | None = None
    normalize_volume: bool = False
    destination: DownloadDestination = DownloadDestination.library
    video_codec: str | None = None
    playlist_id: int | None = None


class DownloadBulkCreate(BaseModel):
    urls: list[str]
    quality_preset: str = "best"
    destination: DownloadDestination = DownloadDestination.library
    normalize_volume: bool = False
    video_codec: str | None = None


class DownloadBulkSkip(BaseModel):
    url: str
    reason: str


class DownloadPreview(BaseModel):
    is_playlist: bool
    title: str | None
    channel: str | None
    channel_url: str | None
    thumbnail_url: str | None = None
    entry_count: int | None
    view_count: int | None = None
    published_at: str | None = None
    available_presets: list[str] = []
    preset_sizes: dict[str, int] = {}


class StreamPreviewMeta(BaseModel):
    id: str | None = None
    title: str | None = None
    channel: str | None = None
    channel_url: str | None = None
    thumbnail_url: str | None = None
    description: str | None = None
    duration: float | None = None
    view_count: int | None = None
    source_url: str | None = None
    preview_height: int | None = None
    library_video_id: int | None = None
    available_presets: list[str] = []
    subtitles: list[SubtitleTrack] = []


class DownloadJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    url: str
    quality_preset: str
    available_presets: list[str] = []
    status: JobStatus
    progress: float
    title: str | None
    title_override: str | None
    channel: str | None
    channel_override: str | None
    thumbnail_url: str | None
    notes_pending: str | None
    paused: bool
    error: str | None
    error_kind: str | None = None
    destination: str = DownloadDestination.library.value
    device_file_path: str | None = None
    video_id: int | None
    replace_video_id: int | None = None
    file_size: int | None
    height_px: int | None = None
    video_codec: str = "av1"
    created_at: datetime
    video_missing: bool = False
    superseded: bool = False
    playlist_id: int | None = None

    @field_validator("video_codec", mode="before")
    @classmethod
    def _normalize_video_codec(cls, value: object) -> str:
        from .services.ytdlp_formats import normalize_video_codec

        return normalize_video_codec(value)


class DownloadBulkResult(BaseModel):
    jobs: list[DownloadJobRead]
    skipped: int = 0
    skips: list[DownloadBulkSkip] = []


class DownloadJobUpdate(BaseModel):
    title_override: str | None = None
    channel_override: str | None = None
    notes_pending: str | None = None


class DownloadQualityUpdate(BaseModel):
    quality_preset: str


class DownloadQueueStatus(BaseModel):
    paused: bool
    active_count: int
    queued_count: int


class VideoRedownload(BaseModel):
    quality_preset: str = "best"
    normalize_volume: bool = False
    video_codec: str | None = None


class ChannelStat(BaseModel):
    channel: str
    count: int
    last_download_at: datetime | None = None
    subscriber_count: int | None = None
    channel_url: str | None = None


class ChannelSearchHit(BaseModel):
    name: str
    url: str
    thumbnail_url: str | None = None
    subscriber_count: int | None = None


class ChannelSearchResponse(BaseModel):
    results: list[ChannelSearchHit] = []


class ChannelFeedEntry(BaseModel):
    id: str | None = None
    url: str
    title: str | None = None
    duration: float | None = None
    thumbnail_url: str | None = None
    view_count: int | None = None
    like_count: int | None = None
    dislike_count: int | None = None
    published_at: str | None = None
    # Honest UI string when the calendar day is unknown ("3 years ago", "2013").
    published_label: str | None = None
    # Channel display name (set for global catalog search).
    channel: str | None = None
    channel_url: str | None = None
    in_library: bool = False
    video_id: int | None = None
    library_height_px: int | None = None
    max_height: int | None = None
    match_reason: SearchMatchReason | None = None


class ChannelFeedPage(BaseModel):
    channel: str | None = None
    channel_url: str | None = None
    entries: list[ChannelFeedEntry] = []
    has_more: bool = False
    indexing: bool = False
    from_catalog: bool = False
    catalog_indexed: int = 0
    catalog_total: int | None = None
    catalog_complete: bool = False
    catalog_status: str | None = None
    direct_youtube_search_effective: bool | None = None
    youtube_video_search_effective: bool | None = None


class ChannelCatalogStatusItem(BaseModel):
    id: int | None = None
    channel_url: str
    channel_name: str | None = None
    status: str
    indexed_count: int = 0
    channel_total: int | None = None
    complete: bool = False
    max_videos: int = 1000
    phase: str | None = None
    last_error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    updated_at: str | None = None
    # None = inherit system default.
    direct_youtube_search: bool | None = None
    direct_youtube_search_effective: bool = True


class ChannelCatalogStatusResponse(BaseModel):
    enabled: bool = True
    running: bool = False
    current_channel: str | None = None
    current_channel_url: str | None = None
    current_phase: str | None = None
    done: int = 0
    total: int = 0
    catalog_id: int | None = None
    queue_depth: int = 0
    catalogs: list[ChannelCatalogStatusItem] = []
    direct_youtube_search: bool = True


class ChannelCatalogIndexRequest(BaseModel):
    channel: str | None = None
    url: str | None = None
    force: bool = False
    mode: Literal["incremental", "full"] = "incremental"


class ChannelCatalogIndexResult(BaseModel):
    queued: int = 0
    skipped: int = 0
    refreshed: int = 0
    catalog_id: int | None = None
    detail: str = ""


class ChannelCatalogYoutubeSearchUpdate(BaseModel):
    channel: str | None = None
    url: str | None = None
    # null = inherit the system Direct YouTube search default.
    direct_youtube_search: bool | None = None


class ChannelCatalogYoutubeSearchPref(BaseModel):
    channel_url: str
    direct_youtube_search: bool | None = None
    direct_youtube_search_effective: bool = True


class ChannelAutodownloadRead(BaseModel):
    configured: bool = False
    enabled: bool = False
    previous_mode: Literal["none", "count", "all"] = "none"
    previous_count: int | None = 10
    quality_preset: str = "1080p"
    include_completed_streams: bool = False
    channel_url: str | None = None
    channel_name: str | None = None
    pending_estimate: int = 0
    catalog_max_videos: int = 1000


class ChannelAutodownloadUpdate(BaseModel):
    channel: str | None = None
    url: str | None = None
    enabled: bool = False
    previous_mode: Literal["none", "count", "all"] = "none"
    previous_count: int | None = None
    quality_preset: str = "1080p"
    include_completed_streams: bool = False


class TagStat(BaseModel):
    tag: str
    count: int


class StorageStats(BaseModel):
    total_bytes: int
    video_bytes: int
    thumbnail_bytes: int
    video_count: int
    # H.264 sidecars (counted in total_bytes, not video_bytes).
    compat_bytes: int = 0


class ChannelRename(BaseModel):
    old_name: str
    new_name: str


class PlaylistCreate(BaseModel):
    name: str
    description: str | None = None


class PlaylistUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    subscribed: bool | None = None
    quality_preset: str | None = None
    cover_video_id: int | None = None


class PlaylistRead(BaseModel):
    id: int
    name: str
    description: str | None
    source_type: PlaylistSource
    source_url: str | None
    subscribed: bool = False
    quality_preset: str | None = None
    last_synced_at: datetime | None = None
    sync_error: str | None = None
    created_at: datetime
    item_count: int
    position: int = 0
    cover_video_id: int | None = None
    has_custom_cover: bool = False
    thumbnail_video_id: int | None = None
    has_thumbnail: bool = False


class PlaylistDetail(PlaylistRead):
    videos: list[VideoRead]


class PlaylistItemAdd(BaseModel):
    video_id: int | None = None
    url: str | None = None


class PlaylistReorder(BaseModel):
    video_ids: list[int]


class PlaylistListReorder(BaseModel):
    playlist_ids: list[int]


class PlaylistImport(BaseModel):
    url: str
    quality_preset: str = "best"
    name: str | None = None
    entries: list[str] = []
    subscribe: bool = False


class PlaylistPreviewEntry(BaseModel):
    id: str | None = None
    url: str
    title: str | None = None
    channel: str | None = None
    duration: float | None = None
    thumbnail_url: str | None = None
    view_count: int | None = None


class PlaylistPreview(BaseModel):
    title: str | None = None
    channel: str | None = None
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
    current_title: str | None = None
    current_video_id: int | None = None
    fields: list[str] = []
    last_error: str | None = None
    finished_at: str | None = None


class ActivityTaskRead(BaseModel):
    id: str
    kind: str
    group: str
    label: str
    reason: str | None = None
    engine: str | None = None
    detail: str | None = None
    video_id: int | None = None
    done: int | None = None
    total: int | None = None
    status: str
    started_at: float
    finished_at: float | None = None
    error: str | None = None


class SystemActivityRead(BaseModel):
    running: list[ActivityTaskRead] = []
    recent: list[ActivityTaskRead] = []
    queued: dict[str, int] = {}
    cpu_percent: float | None = None


class BulkPlaylistAdd(BaseModel):
    video_ids: list[int]

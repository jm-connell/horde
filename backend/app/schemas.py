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


class VideoUpdate(BaseModel):
    title: Optional[str] = None
    channel: Optional[str] = None
    channel_url: Optional[str] = None
    tags: Optional[list[str]] = None
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
    normalize_volume: bool = False


class DownloadPreview(BaseModel):
    is_playlist: bool
    title: Optional[str]
    channel: Optional[str]
    channel_url: Optional[str]
    thumbnail_url: Optional[str] = None
    entry_count: Optional[int]


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


class BulkVideoDelete(BaseModel):
    video_ids: list[int]
    delete_files: bool = False


class BulkVideoNotes(BaseModel):
    video_ids: list[int]
    notes: str


class BulkMetadataRefresh(BaseModel):
    video_ids: list[int] = []


class MetadataRefreshResult(BaseModel):
    refreshed: int
    failed: int
    skipped: int


class BulkPlaylistAdd(BaseModel):
    video_ids: list[int]

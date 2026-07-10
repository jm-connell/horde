from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class VideoStatus(str, Enum):
    downloading = "downloading"
    ready = "ready"
    error = "error"


class JobStatus(str, Enum):
    queued = "queued"
    downloading = "downloading"
    completed = "completed"
    error = "error"
    cancelled = "cancelled"


class Video(SQLModel, table=True):
    __tablename__ = "videos"

    id: Optional[int] = Field(default=None, primary_key=True)
    title: str = Field(index=True)
    channel: Optional[str] = Field(default=None, index=True)
    channel_url: Optional[str] = None
    # Comma-free tags stored as a JSON-encoded list string for simple filtering.
    tags: str = Field(default="[]")
    description: Optional[str] = None
    # Free-form user note, e.g. context about when/why the video was saved.
    notes: Optional[str] = None
    source_url: Optional[str] = None
    thumbnail_path: Optional[str] = None
    # JSON list of subtitle tracks: [{"lang": str, "path": str, "auto": bool}].
    subtitles: str = Field(default="[]")

    # Path relative to DOWNLOADS_DIR, used as the natural key for scanning.
    file_path: str = Field(index=True, unique=True)
    duration_sec: Optional[float] = None
    file_size: Optional[int] = None
    width_px: Optional[int] = None
    height_px: Optional[int] = None
    view_count: Optional[int] = None
    # Denormalized per video; same value for all videos from a channel when known.
    channel_subscriber_count: Optional[int] = None

    published_at: Optional[datetime] = None
    added_at: datetime = Field(default_factory=utcnow, index=True)

    last_position_sec: float = 0.0
    last_watched_at: Optional[datetime] = None

    needs_review: bool = Field(default=False, index=True)
    platform: Optional[str] = None
    status: VideoStatus = Field(default=VideoStatus.ready)

    frame_rate: Optional[float] = None

    # Metadata resync tracking
    metadata_synced_at: Optional[datetime] = None
    source_title: Optional[str] = None
    source_description: Optional[str] = None
    title_is_custom: bool = Field(default=False)
    description_is_custom: bool = Field(default=False)
    subtitles_pending: bool = Field(default=False)


class DownloadJob(SQLModel, table=True):
    __tablename__ = "download_jobs"

    id: Optional[int] = Field(default=None, primary_key=True)
    url: str
    quality_preset: str = "best"
    status: JobStatus = Field(default=JobStatus.queued)
    progress: float = 0.0
    title: Optional[str] = None
    title_override: Optional[str] = None
    channel: Optional[str] = None
    channel_override: Optional[str] = None
    thumbnail_url: Optional[str] = None
    notes_pending: Optional[str] = None
    paused: bool = Field(default=False)
    normalize_volume: bool = Field(default=False)
    replace_video_id: Optional[int] = Field(default=None, foreign_key="videos.id")
    error: Optional[str] = None
    video_id: Optional[int] = Field(default=None, foreign_key="videos.id")
    file_size: Optional[int] = None
    created_at: datetime = Field(default_factory=utcnow)


class PlaylistSource(str, Enum):
    user = "user"
    youtube = "youtube"


class Playlist(SQLModel, table=True):
    __tablename__ = "playlists"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    description: Optional[str] = None
    source_type: PlaylistSource = Field(default=PlaylistSource.user)
    source_url: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow, index=True)


class PlaylistItem(SQLModel, table=True):
    __tablename__ = "playlist_items"

    id: Optional[int] = Field(default=None, primary_key=True)
    playlist_id: int = Field(foreign_key="playlists.id", index=True)
    video_id: int = Field(foreign_key="videos.id", index=True)
    position: int = 0


class AiJobStatus(str, Enum):
    queued = "queued"
    running = "running"
    completed = "completed"
    error = "error"
    cancelled = "cancelled"


class AiJobKind(str, Enum):
    embed_video = "embed_video"
    enrich_tags = "enrich_tags"
    score_duplicates = "score_duplicates"
    refresh_categories = "refresh_categories"


class VideoEmbedding(SQLModel, table=True):
    __tablename__ = "video_embeddings"

    id: Optional[int] = Field(default=None, primary_key=True)
    video_id: int = Field(foreign_key="videos.id", index=True)
    # -1 = metadata document; 0+ = subtitle chunk index.
    chunk_index: int = Field(default=-1, index=True)
    model: str = Field(default="nomic-embed-text")
    dim: int = 0
    vector: bytes = Field(default=b"")
    content_hash: str = Field(default="")
    updated_at: datetime = Field(default_factory=utcnow)


class VideoAiMeta(SQLModel, table=True):
    __tablename__ = "video_ai_meta"

    video_id: int = Field(primary_key=True, foreign_key="videos.id")
    embed_status: str = Field(default="pending", index=True)
    content_hash: str = Field(default="")
    summary: Optional[str] = None
    # JSON list of tags added by AI (subset of Video.tags).
    ai_tags: str = Field(default="[]")
    # JSON list of tags added manually by the user.
    user_tags: str = Field(default="[]")
    tags_enriched_at: Optional[datetime] = None
    tags_locked: bool = Field(default=False)
    updated_at: datetime = Field(default_factory=utcnow)


class AiCategory(SQLModel, table=True):
    __tablename__ = "ai_categories"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    embedding: bytes = Field(default=b"")
    dim: int = 0
    model: str = Field(default="nomic-embed-text")
    updated_at: datetime = Field(default_factory=utcnow)


class AiJob(SQLModel, table=True):
    __tablename__ = "ai_jobs"

    id: Optional[int] = Field(default=None, primary_key=True)
    kind: AiJobKind = Field(index=True)
    video_id: Optional[int] = Field(default=None, foreign_key="videos.id", index=True)
    status: AiJobStatus = Field(default=AiJobStatus.queued, index=True)
    attempts: int = 0
    run_after: Optional[datetime] = Field(default=None, index=True)
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

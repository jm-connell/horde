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

    published_at: Optional[datetime] = None
    added_at: datetime = Field(default_factory=utcnow, index=True)

    needs_review: bool = Field(default=False, index=True)
    platform: Optional[str] = None
    status: VideoStatus = Field(default=VideoStatus.ready)


class DownloadJob(SQLModel, table=True):
    __tablename__ = "download_jobs"

    id: Optional[int] = Field(default=None, primary_key=True)
    url: str
    quality_preset: str = "best"
    status: JobStatus = Field(default=JobStatus.queued)
    progress: float = 0.0
    title: Optional[str] = None
    error: Optional[str] = None
    video_id: Optional[int] = Field(default=None, foreign_key="videos.id")
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

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
    # Comma-free tags stored as a JSON-encoded list string for simple filtering.
    tags: str = Field(default="[]")
    description: Optional[str] = None
    source_url: Optional[str] = None
    thumbnail_path: Optional[str] = None

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

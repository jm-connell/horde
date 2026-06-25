from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from .models import JobStatus, VideoStatus


class VideoRead(BaseModel):
    id: int
    title: str
    channel: Optional[str]
    tags: list[str]
    description: Optional[str]
    source_url: Optional[str]
    has_thumbnail: bool
    file_path: str
    duration_sec: Optional[float]
    file_size: Optional[int]
    published_at: Optional[datetime]
    added_at: datetime
    needs_review: bool
    platform: Optional[str]
    status: VideoStatus


class VideoUpdate(BaseModel):
    title: Optional[str] = None
    channel: Optional[str] = None
    tags: Optional[list[str]] = None
    description: Optional[str] = None
    source_url: Optional[str] = None
    published_at: Optional[datetime] = None
    # Setting a remote URL fetches and caches the image server-side.
    thumbnail_url: Optional[str] = None


class DownloadCreate(BaseModel):
    url: str
    quality_preset: str = "best"


class DownloadJobRead(BaseModel):
    id: int
    url: str
    quality_preset: str
    status: JobStatus
    progress: float
    title: Optional[str]
    error: Optional[str]
    video_id: Optional[int]
    created_at: datetime


class ChannelStat(BaseModel):
    channel: str
    count: int

from datetime import UTC, datetime
from enum import Enum
from typing import Protocol, overload

from sqlalchemy import Column, Index, String, UniqueConstraint, event
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(UTC)


@overload
def as_utc(dt: datetime) -> datetime: ...
@overload
def as_utc(dt: None) -> None: ...
@overload
def as_utc(dt: datetime | None) -> datetime | None: ...
def as_utc(dt: datetime | None) -> datetime | None:
    """Treat naive datetimes as UTC. SQLite often strips tzinfo on read."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


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


class DownloadDestination(str, Enum):
    library = "library"
    device = "device"


# Foreign keys are enforced (PRAGMA foreign_keys=ON). Every FK declares what
# happens when the parent row goes away:
#   CASCADE  - the child only makes sense with its parent (embeddings, chat,
#              playlist membership, catalog rows).
#   SET NULL - the child is history that must outlive the parent (download
#              jobs, the OpenRouter cost ledger) or a soft pointer (playlist
#              cover, job -> playlist).
# Tables whose ids are referenced from elsewhere use AUTOINCREMENT so a deleted
# id is never reissued to an unrelated row.
_AUTOINCREMENT = {"sqlite_autoincrement": True}


class _HasId(Protocol):
    id: int | None


def require_id(row: _HasId) -> int:
    """The primary key of a row that has been flushed (``None`` only before that)."""
    if row.id is None:
        raise RuntimeError(f"{type(row).__name__} has not been saved yet")
    return row.id


class Video(SQLModel, table=True):
    __tablename__ = "videos"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    title: str = Field(index=True)
    channel: str | None = Field(default=None, index=True)
    channel_url: str | None = None
    # Tags as a JSON-encoded list string. This column is what the application
    # writes (it keeps order and exact spelling); ``video_tags`` is a derived
    # index kept in step by SQLite triggers, and is what tag queries read.
    tags: str = Field(default="[]")
    description: str | None = None
    # Free-form user note, e.g. context about when/why the video was saved.
    notes: str | None = None
    source_url: str | None = Field(default=None, index=True)
    # YouTube video id derived from source_url / the ``[id]`` file name token.
    # Maintained by the before_insert/before_update listener below; lookups use
    # the index instead of scanning every row.
    youtube_id: str | None = Field(default=None, index=True)
    thumbnail_path: str | None = None
    # Seek-preview sprite sheet path (absolute), sibling JSON sidecar beside it.
    sprite_path: str | None = None
    # JSON list of subtitle tracks: [{"lang": str, "path": str, "auto": bool}].
    subtitles: str = Field(default="[]")

    # Path relative to DOWNLOADS_DIR, used as the natural key for scanning.
    file_path: str = Field(index=True, unique=True)
    duration_sec: float | None = None
    file_size: int | None = None
    width_px: int | None = None
    height_px: int | None = None
    view_count: int | None = None
    # Denormalized per video; same value for all videos from a channel when known.
    channel_subscriber_count: int | None = None

    published_at: datetime | None = None
    added_at: datetime = Field(default_factory=utcnow, index=True)

    last_position_sec: float = 0.0
    last_watched_at: datetime | None = None

    needs_review: bool = Field(default=False, index=True)
    platform: str | None = None
    status: VideoStatus = Field(default=VideoStatus.ready)

    frame_rate: float | None = None

    # Metadata resync tracking
    metadata_synced_at: datetime | None = None
    source_title: str | None = None
    source_description: str | None = None
    title_is_custom: bool = Field(default=False)
    description_is_custom: bool = Field(default=False)
    subtitles_pending: bool = Field(default=False, index=True)
    # Next timedtext attempt after a retryable miss (429 / network). Internal.
    subtitles_retry_after: datetime | None = None
    subtitles_fetch_attempts: int = Field(default=0)
    # JSON list of yt-dlp native chapters: [{"start_sec": float, "title": str}].
    source_chapters: str = Field(default="[]")

    # Actual stream info from ffprobe (not the requested download mode).
    # vcodec/acodec are families ("av1", "vp9", "h264", "hevc", "aac", "opus").
    vcodec: str | None = None
    acodec: str | None = None
    # RFC 6381 codec string for MediaCapabilities, e.g. "av01.0.08M.08".
    codec_string: str | None = None
    bit_depth: int | None = None
    is_hdr: bool = Field(default=False)
    media_probed_at: datetime | None = None
    # ≤1080p H.264 + AAC sidecar for devices that cannot decode the original.
    # Path relative to DOWNLOADS_DIR; "youtube" (native download) or "transcode".
    compat_path: str | None = None
    compat_size: int | None = None
    compat_source: str | None = None
    compat_error: str | None = None


@event.listens_for(Video, "before_insert")
@event.listens_for(Video, "before_update")
def _set_youtube_id(_mapper, _connection, target: Video) -> None:
    from .services.youtube_id import derive_youtube_id

    derived = derive_youtube_id(target.source_url, target.file_path)
    if target.youtube_id != derived:
        target.youtube_id = derived


class VideoTag(SQLModel, table=True):
    """One tag on one video, with where it came from.

    Derived data: the triggers created by revisions ``0005_tags_search`` and
    ``0006_video_tags_delete`` rebuild a video's rows whenever ``videos.tags`` or its
    ``video_ai_meta`` tag lists change (and clear them when the video is deleted),
    so nothing in the application writes this table. ``source`` is ``user`` (added
    by hand), ``ai`` (added by tag enrichment) or ``source`` (collected from the
    platform). ``tag`` compares case-insensitively.
    """

    __tablename__ = "video_tags"
    __table_args__ = (Index("ix_video_tags_tag", "tag"),)

    video_id: int = Field(foreign_key="videos.id", primary_key=True, ondelete="CASCADE")
    tag: str = Field(
        sa_column=Column(String(collation="NOCASE"), primary_key=True, nullable=False)
    )
    source: str = Field(primary_key=True)


class DownloadJob(SQLModel, table=True):
    __tablename__ = "download_jobs"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    url: str
    quality_preset: str = "best"
    # JSON list of source presets from preview (e.g. ["2160p","1080p","audio"]).
    available_presets_json: str | None = None
    status: JobStatus = Field(default=JobStatus.queued, index=True)
    progress: float = 0.0
    title: str | None = None
    title_override: str | None = None
    channel: str | None = None
    channel_override: str | None = None
    thumbnail_url: str | None = None
    notes_pending: str | None = None
    paused: bool = Field(default=False)
    normalize_volume: bool = Field(default=False)
    # Archive video codec: av1 (copy) | h264 | h265. Stamped from Settings.
    video_codec: str = Field(default="av1")
    # "library" archives to the server; "device" is ephemeral browser save.
    destination: str = Field(default=DownloadDestination.library.value)
    # Relative path under DOWNLOADS_DIR for device jobs (serve + cleanup).
    device_file_path: str | None = None
    replace_video_id: int | None = Field(
        default=None, foreign_key="videos.id", ondelete="SET NULL", index=True
    )
    # When set, the finished library video is appended to this playlist.
    playlist_id: int | None = Field(
        default=None, foreign_key="playlists.id", ondelete="SET NULL", index=True
    )
    error: str | None = None
    error_kind: str | None = None
    video_id: int | None = Field(
        default=None, foreign_key="videos.id", ondelete="SET NULL", index=True
    )
    file_size: int | None = None
    height_px: int | None = None
    created_at: datetime = Field(default_factory=utcnow)


class PlaylistSource(str, Enum):
    user = "user"
    youtube = "youtube"


class Playlist(SQLModel, table=True):
    __tablename__ = "playlists"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    name: str
    description: str | None = None
    source_type: PlaylistSource = Field(default=PlaylistSource.user)
    source_url: str | None = None
    subscribed: bool = Field(default=False)
    quality_preset: str | None = None
    last_synced_at: datetime | None = None
    sync_error: str | None = None
    # Lower sorts first. New playlists are inserted at 0.
    position: int = Field(default=0, index=True)
    # Pinned cover from a member video; None uses the first item.
    cover_video_id: int | None = Field(
        default=None, foreign_key="videos.id", ondelete="SET NULL"
    )
    cover_path: str | None = None
    created_at: datetime = Field(default_factory=utcnow, index=True)


class PlaylistItem(SQLModel, table=True):
    __tablename__ = "playlist_items"
    __table_args__ = (
        UniqueConstraint("playlist_id", "video_id", name="uq_playlist_items_pair"),
    )

    id: int | None = Field(default=None, primary_key=True)
    playlist_id: int = Field(foreign_key="playlists.id", index=True, ondelete="CASCADE")
    video_id: int = Field(foreign_key="videos.id", index=True, ondelete="CASCADE")
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
    refresh_categories = "refresh_categories"
    embed_catalog_video = "embed_catalog_video"
    summarize = "summarize"
    chapters = "chapters"


class ChannelCatalogStatus(str, Enum):
    idle = "idle"
    queued = "queued"
    indexing = "indexing"
    ready = "ready"
    error = "error"


class ChannelCatalog(SQLModel, table=True):
    __tablename__ = "channel_catalogs"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    channel_url: str = Field(index=True, unique=True)
    channel_name: str | None = Field(default=None, index=True)
    status: ChannelCatalogStatus = Field(default=ChannelCatalogStatus.idle, index=True)
    indexed_count: int = 0
    # Best-known total uploads on the YouTube channel (from yt-dlp playlist_count).
    channel_total: int | None = None
    # True when indexing reached the end of the channel (not stopped by max cap).
    complete: bool = Field(default=False)
    max_videos: int = 1000
    # None = inherit system direct_youtube_search; True/False = per-channel override.
    direct_youtube_search: bool | None = None
    phase: str | None = None  # flat | descriptions | embed
    last_error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    updated_at: datetime = Field(default_factory=utcnow)


class ChannelCatalogVideo(SQLModel, table=True):
    __tablename__ = "channel_catalog_videos"
    __table_args__ = (UniqueConstraint("catalog_id", "yt_id"), _AUTOINCREMENT)

    id: int | None = Field(default=None, primary_key=True)
    catalog_id: int = Field(
        foreign_key="channel_catalogs.id", index=True, ondelete="CASCADE"
    )
    yt_id: str = Field(index=True)
    url: str
    title: str | None = None
    duration: float | None = None
    view_count: int | None = None
    published_at: str | None = None
    thumbnail_url: str | None = None
    description: str | None = None
    # yt-dlp live_status: not_live | is_live | is_upcoming | was_live | post_live
    live_status: str | None = None
    # 0 = newest upload in the indexed window.
    position: int = Field(default=0, index=True)
    indexed_at: datetime = Field(default_factory=utcnow)


class ChannelAutodownload(SQLModel, table=True):
    """Per-channel policy for automatically enqueueing catalog uploads."""

    __tablename__ = "channel_autodownloads"

    id: int | None = Field(default=None, primary_key=True)
    channel_url: str = Field(index=True, unique=True)
    channel_name: str | None = None
    enabled: bool = Field(default=False, index=True)
    # none = future only; count = last N previous + future; all = all indexed + future
    previous_mode: str = Field(default="none")
    previous_count: int | None = 10
    quality_preset: str = Field(default="1080p")
    include_completed_streams: bool = Field(default=False)
    # False until the first feed-head sync after enable, so existing uploads
    # are not treated as "new" future videos.
    anchor_ready: bool = Field(default=False)
    updated_at: datetime = Field(default_factory=utcnow)


class ChannelCatalogSkip(SQLModel, table=True):
    """IDs permanently excluded from a channel catalog (e.g. members-only)."""

    __tablename__ = "channel_catalog_skips"
    __table_args__ = (UniqueConstraint("catalog_id", "yt_id"),)

    id: int | None = Field(default=None, primary_key=True)
    catalog_id: int = Field(
        foreign_key="channel_catalogs.id", index=True, ondelete="CASCADE"
    )
    yt_id: str = Field(index=True)
    reason: str = Field(default="members_only")
    skipped_at: datetime = Field(default_factory=utcnow)


class ChannelCatalogEmbedding(SQLModel, table=True):
    __tablename__ = "channel_catalog_embeddings"

    id: int | None = Field(default=None, primary_key=True)
    catalog_video_id: int = Field(
        foreign_key="channel_catalog_videos.id",
        index=True,
        unique=True,
        ondelete="CASCADE",
    )
    model: str = Field(default="nomic-embed-text")
    dim: int = 0
    vector: bytes = Field(default=b"")
    content_hash: str = Field(default="")
    updated_at: datetime = Field(default_factory=utcnow)


class VideoEmbedding(SQLModel, table=True):
    __tablename__ = "video_embeddings"

    id: int | None = Field(default=None, primary_key=True)
    video_id: int = Field(foreign_key="videos.id", index=True, ondelete="CASCADE")
    # -1 = metadata document; 0+ = subtitle chunk index.
    chunk_index: int = Field(default=-1, index=True)
    model: str = Field(default="nomic-embed-text")
    dim: int = 0
    vector: bytes = Field(default=b"")
    content_hash: str = Field(default="")
    updated_at: datetime = Field(default_factory=utcnow)


class VideoAiMeta(SQLModel, table=True):
    __tablename__ = "video_ai_meta"

    video_id: int = Field(primary_key=True, foreign_key="videos.id", ondelete="CASCADE")
    embed_status: str = Field(default="pending", index=True)
    content_hash: str = Field(default="")
    summary: str | None = None
    # short | medium | long — length setting used when summary was generated.
    summary_length: str | None = None
    # OpenRouter cost for the last generated summary (USD/credits), when known.
    summary_cost: float | None = None
    # Model id used for the last generated summary (when known).
    summary_model: str | None = None
    # JSON list of tags added by AI (subset of Video.tags).
    ai_tags: str = Field(default="[]")
    # JSON list of tags added manually by the user.
    user_tags: str = Field(default="[]")
    tags_enriched_at: datetime | None = None
    tags_locked: bool = Field(default=False)
    # Last embed failure message (cleared on successful index).
    embed_error: str | None = None
    # JSON list of LLM chapters: [{"start_sec": float, "title": str}].
    chapters: str | None = None
    chapters_skip_reason: str | None = None
    updated_at: datetime = Field(default_factory=utcnow)


class VideoAiChatMessage(SQLModel, table=True):
    """One turn of a user's conversation about a video (chat is per user)."""

    __tablename__ = "video_ai_chat_messages"

    id: int | None = Field(default=None, primary_key=True)
    video_id: int = Field(foreign_key="videos.id", index=True, ondelete="CASCADE")
    # NULL only for history from before accounts; it is adopted by the first admin.
    user_id: int | None = Field(
        default=None, foreign_key="users.id", index=True, ondelete="CASCADE"
    )
    role: str = Field(default="user", index=True)  # user | assistant
    content: str = Field(default="")
    # OpenRouter usage.cost for this assistant turn (USD/credits), when known.
    cost: float | None = None
    # Model id used for this assistant turn (when known).
    model: str | None = None
    created_at: datetime = Field(default_factory=utcnow)


class OpenRouterUsage(SQLModel, table=True):
    """Append-only ledger of OpenRouter charges attributed to Horde."""

    __tablename__ = "openrouter_usage"

    id: int | None = Field(default=None, primary_key=True)
    kind: str = Field(default="other", index=True)
    cost: float = Field(default=0.0)
    model: str | None = None
    video_id: int | None = Field(
        default=None, foreign_key="videos.id", ondelete="SET NULL", index=True
    )
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    created_at: datetime = Field(default_factory=utcnow, index=True)


class AiCategory(SQLModel, table=True):
    __tablename__ = "ai_categories"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    blurb: str | None = None
    embedding: bytes = Field(default=b"")
    dim: int = 0
    model: str = Field(default="nomic-embed-text")
    updated_at: datetime = Field(default_factory=utcnow)


class AiJob(SQLModel, table=True):
    __tablename__ = "ai_jobs"
    # Dedupe lookups ("is there already a queued X job for this video?").
    __table_args__ = (
        Index("ix_ai_jobs_video_id_kind_status", "video_id", "kind", "status"),
        _AUTOINCREMENT,
    )

    id: int | None = Field(default=None, primary_key=True)
    kind: AiJobKind = Field(index=True)
    video_id: int | None = Field(
        default=None, foreign_key="videos.id", index=True, ondelete="CASCADE"
    )
    catalog_video_id: int | None = Field(
        default=None,
        foreign_key="channel_catalog_videos.id",
        index=True,
        ondelete="CASCADE",
    )
    status: AiJobStatus = Field(default=AiJobStatus.queued, index=True)
    attempts: int = 0
    run_after: datetime | None = Field(default=None, index=True)
    error: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class User(SQLModel, table=True):
    """A person who can sign in. The first one created is the administrator."""

    __tablename__ = "users"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    # As entered (shown in the UI); ``username_norm`` is the lowercased identity.
    username: str
    username_norm: str = Field(unique=True, index=True)
    # ``scrypt$n$r$p$salt_b64$hash_b64``; see services/passwords.py.
    password_hash: str
    is_admin: bool = Field(default=False)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    last_login_at: datetime | None = None
    disabled: bool = Field(default=False)
    # JSON list of granted permission names (see services/auth/permissions.py).
    # Meaningful for members only: administrators implicitly have everything.
    permissions: str = Field(default="[]")


class UserSession(SQLModel, table=True):
    """A signed-in browser. Only the SHA-256 of the cookie token is stored."""

    __tablename__ = "user_sessions"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    token_hash: str = Field(unique=True, index=True)
    created_at: datetime = Field(default_factory=utcnow)
    last_seen_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime = Field(index=True)
    user_agent: str | None = None
    ip: str | None = None


class UserVideoState(SQLModel, table=True):
    """One user's watch progress for one video (history is per user)."""

    __tablename__ = "user_video_state"
    __table_args__ = (
        Index("ix_user_video_state_user_watched", "user_id", "last_watched_at"),
    )

    user_id: int = Field(foreign_key="users.id", primary_key=True, ondelete="CASCADE")
    video_id: int = Field(
        foreign_key="videos.id", primary_key=True, index=True, ondelete="CASCADE"
    )
    position_sec: float = 0.0
    last_watched_at: datetime | None = None


class UserSettings(SQLModel, table=True):
    """One user's UI preferences (JSON). Server-wide settings stay in app_settings."""

    __tablename__ = "user_settings"

    user_id: int = Field(foreign_key="users.id", primary_key=True, ondelete="CASCADE")
    ui_json: str = Field(default="{}")
    updated_at: datetime = Field(default_factory=utcnow)

import uuid
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


class JobOrigin(str, Enum):
    """What queued a download job (notifications can tell watched jobs from unattended ones)."""

    manual = "manual"
    channel_autodownload = "channel_autodownload"
    playlist_sync = "playlist_sync"


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
    # Who queued it: a person (manual), a channel's auto-download or a subscribed playlist.
    origin: str = Field(default=JobOrigin.manual.value)
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
    # A clip: only this part of the video, in seconds from the start of the
    # broadcast. Saved as its own library video (services/downloads/clips.py).
    clip_start_sec: float | None = None
    clip_end_sec: float | None = None


class PlaylistSource(str, Enum):
    user = "user"
    youtube = "youtube"


class PlaylistVisibility(str, Enum):
    #: Everyone signed in sees it (the owner and holders of manage_playlists edit it).
    public = "public"
    #: Only its owner sees it; to everyone else it does not exist.
    private = "private"


class Playlist(SQLModel, table=True):
    __tablename__ = "playlists"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    name: str
    # Who made it. NULL only for a public playlist that predates accounts (the
    # first administrator adopts it). A deleted owner's public playlists are
    # handed on first (services/playlists.py); the cascade only reaches private ones.
    owner_user_id: int | None = Field(
        default=None, foreign_key="users.id", index=True, ondelete="CASCADE"
    )
    visibility: PlaylistVisibility = Field(default=PlaylistVisibility.public)
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
    """One entry of a playlist: a library video, or a video that is only streamed.

    ``video_id`` is None for a streamed entry; ``youtube_id`` and ``url`` say what
    to stream and the snapshot fields (title ... duration) what to show. Deleting
    a library video turns its entries into streamed ones
    (``services/playlist_entries.py``); downloading one links them again.
    """

    __tablename__ = "playlist_items"
    __table_args__ = (
        UniqueConstraint("playlist_id", "video_id", name="uq_playlist_items_pair"),
        # Entry ids are handed to clients (remove, reorder): never reuse one.
        _AUTOINCREMENT,
    )

    id: int | None = Field(default=None, primary_key=True)
    playlist_id: int = Field(foreign_key="playlists.id", index=True, ondelete="CASCADE")
    video_id: int | None = Field(
        default=None, foreign_key="videos.id", index=True, ondelete="SET NULL"
    )
    position: int = 0
    youtube_id: str | None = Field(default=None, index=True)
    url: str | None = None
    title: str | None = None
    channel: str | None = None
    channel_url: str | None = None
    duration_sec: float | None = None


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
    embed_kb_channel = "embed_kb_channel"


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
    """IDs excluded from a channel catalog.

    ``members_only`` / ``cookies``: unplayable, hidden everywhere. ``deleted``: a user
    deleted the downloaded copy; the video stays listed and only automatic download
    skips it (``services/channel_catalog/skips.py``).
    """

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


class StreamAiState(SQLModel, table=True):
    """AI results for a streamed (not downloaded) video, keyed by YouTube id.

    Moved onto the library video when it is downloaded; deleted when nobody
    opened the stream for ``STREAM_AI_RETENTION_DAYS``.
    """

    __tablename__ = "stream_ai_state"

    id: int | None = Field(default=None, primary_key=True)
    youtube_id: str = Field(index=True, unique=True)
    source_url: str = Field(default="")
    title: str = Field(default="")
    channel: str | None = None
    description: str | None = None
    duration_sec: float | None = None
    # English WebVTT fetched from the stream (None until first needed).
    captions_vtt: str | None = None
    summary: str | None = None
    summary_length: str | None = None
    summary_cost: float | None = None
    summary_model: str | None = None
    # JSON list of LLM chapters: [{"start_sec": float, "title": str}].
    chapters: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    last_used_at: datetime = Field(default_factory=utcnow, index=True)


class StreamAiChatMessage(SQLModel, table=True):
    """One turn of a user's conversation about a streamed video."""

    __tablename__ = "stream_ai_chat_messages"

    id: int | None = Field(default=None, primary_key=True)
    stream_id: int = Field(
        foreign_key="stream_ai_state.id", index=True, ondelete="CASCADE"
    )
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    role: str = Field(default="user")  # user | assistant
    content: str = Field(default="")
    cost: float | None = None
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
    kb_channel_id: int | None = Field(
        default=None, foreign_key="kb_channels.id", index=True, ondelete="CASCADE"
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
    # Profile picture version (the client's cache key); None when the account
    # has none. The image is DATA_DIR/avatars/{id}_{version}.jpg.
    avatar_version: int | None = None
    # Whether other accounts on a device may see this account's offline downloads
    # there, and fetch its device-destination downloads from the server.
    share_downloads: bool = Field(default=True)
    # Two-step sign-in (services/auth/two_factor.py). ``totp_secret`` is the base32
    # secret, stored as is like the other keys in DATA_DIR; with ``totp_enabled_at``
    # still empty it is an enrollment waiting for its first code and is not used to
    # sign in. ``totp_last_step`` is the newest 30 second step accepted (no replays).
    totp_secret: str | None = None
    totp_enabled_at: datetime | None = None
    totp_last_step: int | None = None


class UserRecoveryCode(SQLModel, table=True):
    """One unused recovery code of an account (keyed hash only; deleted when used)."""

    __tablename__ = "user_recovery_codes"
    __table_args__ = (UniqueConstraint("user_id", "code_hash"), _AUTOINCREMENT)

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    code_hash: str
    created_at: datetime = Field(default_factory=utcnow)


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
    #: When this session last proved the password (sign-in or ``/api/auth/reauth``);
    #: the sensitive administrator actions need it recently. None: never.
    reauth_at: datetime | None = None


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
    # When this user finished the video (a save of position 0 means "finished").
    # Cleared when they watch it again. Set only by ``user_state.record_progress``:
    # an expired half-watch also has position 0 but is never "finished", which
    # is why the retention rules read this column and not the position.
    finished_at: datetime | None = None


class UserWatchTime(SQLModel, table=True):
    """Seconds one user spent watching one video within one UTC hour.

    Written only by ``services/watch_stats.py`` from progress saves; the History
    stats read it. Hours rather than days so the viewer's own time zone decides
    where a day starts (and the weekday × hour chart has something to show). The
    rows are history that outlives the video: deleting it clears ``video_id``
    (the channel name stays, so top channels still add up), a restore from the
    trash links them again. Deleting the account deletes them.
    """

    __tablename__ = "user_watch_time"
    __table_args__ = (
        Index(
            "ux_user_watch_time_bucket",
            "user_id",
            "hour_start",
            "video_id",
            unique=True,
        ),
        _AUTOINCREMENT,
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", ondelete="CASCADE")
    video_id: int | None = Field(
        default=None, foreign_key="videos.id", index=True, ondelete="SET NULL"
    )
    #: The video's channel when the time was recorded (read when the video is gone).
    channel: str | None = None
    #: Start of the UTC hour the watching happened in.
    hour_start: datetime
    seconds: float = 0.0
    #: How many times the video was played to its end in this hour.
    finished: int = 0


class UserSettings(SQLModel, table=True):
    """One user's UI preferences (JSON). Server-wide settings stay in app_settings."""

    __tablename__ = "user_settings"

    user_id: int = Field(foreign_key="users.id", primary_key=True, ondelete="CASCADE")
    ui_json: str = Field(default="{}")
    updated_at: datetime = Field(default_factory=utcnow)


class TrashEntry(SQLModel, table=True):
    """A deleted video waiting in the trash (``services/trash.py``).

    A tombstone, not a soft-delete flag: the ``videos`` row and everything that
    hangs off it are really deleted, so no query has to remember to filter them.
    ``snapshot_json`` holds what a restore needs to put the rows back and
    ``files_json`` lists the files moved into ``.horde-trash``. ``video_id`` is the
    id the video had (it is reused on restore) and is deliberately not a foreign
    key. ``folder`` names the folders holding the files (``.horde-trash/<folder>``
    and ``DATA_DIR/trash/<folder>``): a random token, never the row id, so a trash
    that crashed before its commit cannot share a folder with a later one. Never
    read the two JSON columns for a listing: they can be large.
    """

    __tablename__ = "trash_entries"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    folder: str = Field(
        default_factory=lambda: uuid.uuid4().hex, index=True, unique=True
    )
    video_id: int
    youtube_id: str | None = Field(default=None, index=True)
    title: str
    channel: str | None = None
    # The media file's path relative to DOWNLOADS_DIR before it was trashed.
    relative_path: str
    # Bytes of the files moved into the trash (media and sidecars).
    size_bytes: int = 0
    trashed_at: datetime = Field(default_factory=utcnow, index=True)
    trashed_by_user_id: int | None = Field(
        default=None, foreign_key="users.id", ondelete="SET NULL"
    )
    # JSON list of {"root": "downloads" | "data", "path": str, "size": int}.
    files_json: str = Field(default="[]")
    snapshot_json: str = Field(default="{}")
    # Why it was trashed when it was not by hand, e.g. "Retention: keep latest 20".
    reason: str | None = None


class ChannelRetention(SQLModel, table=True):
    """A channel's rules for removing its old videos (``services/channel_retention.py``).

    Keyed by the channel name the library groups videos by, the one a rename
    changes (``library.rename_channel`` moves the row along). At most one of each
    limit; any combination. ``last_removed_*`` describe the latest run that moved
    something to the trash, ``last_run_at`` the latest run of all.
    """

    __tablename__ = "channel_retention"

    id: int | None = Field(default=None, primary_key=True)
    channel: str = Field(index=True, unique=True)
    enabled: bool = Field(default=False, index=True)
    keep_latest: int | None = None
    max_age_days: int | None = None
    remove_watched_after_days: int | None = None
    updated_at: datetime = Field(default_factory=utcnow)
    last_run_at: datetime | None = None
    last_removed_count: int = 0
    last_removed_at: datetime | None = None


class RetentionKeep(SQLModel, table=True):
    """A video the retention rules never touch: one restored from the trash."""

    __tablename__ = "retention_keeps"

    video_id: int = Field(foreign_key="videos.id", primary_key=True, ondelete="CASCADE")
    created_at: datetime = Field(default_factory=utcnow)


class DownloadRequester(SQLModel, table=True):
    """Who queued a download job (automatic jobs have no row).

    A finished library download follows its channel for this user
    (``services/follows.follow_from_download``).
    """

    __tablename__ = "download_requesters"

    job_id: int = Field(
        foreign_key="download_jobs.id", primary_key=True, ondelete="CASCADE"
    )
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")


class ChannelFollow(SQLModel, table=True):
    """A channel one user follows (feeds the live list).

    ``followed`` False is a tombstone: the user unfollowed it, so a later download
    from that channel must not follow it again.
    """

    __tablename__ = "channel_follows"
    __table_args__ = (
        UniqueConstraint("user_id", "channel_url", name="uq_channel_follows_user_url"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    # Normalized (services/follows.normalize_channel_url).
    channel_url: str = Field(index=True)
    channel_name: str | None = None
    followed: bool = Field(default=True)
    # download | manual | library (seeded from the library for an administrator)
    source: str = Field(default="manual")
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class UserStreamState(SQLModel, table=True):
    """One user's watch of a video they streamed without downloading it.

    Written by the player through ``services/discovery/history.py``. Recommendations
    read it the way they read ``user_video_state``: as taste, and to leave out what
    the user already watched. Keyed by the YouTube id, so a later download of the
    same video is recognised.
    """

    __tablename__ = "user_stream_state"
    __table_args__ = (
        Index("ix_user_stream_state_user_watched", "user_id", "last_watched_at"),
    )

    user_id: int = Field(foreign_key="users.id", primary_key=True, ondelete="CASCADE")
    yt_id: str = Field(primary_key=True)
    url: str
    title: str | None = None
    channel: str | None = None
    channel_url: str | None = None
    duration_sec: float | None = None
    #: The furthest point reached, so a rewatch from the start keeps what was seen.
    watched_sec: float = 0.0
    last_watched_at: datetime = Field(default_factory=utcnow)
    finished_at: datetime | None = None


class DiscoveryVideo(SQLModel, table=True):
    """A YouTube video found outside the library and the channel catalogs.

    The Recommended+ gatherer (``services/discovery/gather.py``) fills it from
    YouTube searches and "up next" lists; ``discovery_hits`` says for whom and why.
    Rows no hit points at any more are deleted.
    """

    __tablename__ = "discovery_videos"
    __table_args__ = (_AUTOINCREMENT,)

    id: int | None = Field(default=None, primary_key=True)
    yt_id: str = Field(index=True, unique=True)
    url: str
    title: str | None = None
    channel: str | None = None
    channel_url: str | None = Field(default=None, index=True)
    duration: float | None = None
    view_count: int | None = None
    #: ISO date when known (search results only give "3 weeks ago").
    published_at: str | None = None
    published_label: str | None = None
    thumbnail_url: str | None = None
    #: The snippet YouTube shows in search results (not the full description).
    description: str | None = None
    live_status: str | None = None
    found_at: datetime = Field(default_factory=utcnow)
    #: The text embedded for scoring (empty until the gatherer embeds it).
    embed_model: str = ""
    embed_dim: int = 0
    vector: bytes = Field(default=b"")


class DiscoveryHit(SQLModel, table=True):
    """Why a discovered video is a candidate for one user."""

    __tablename__ = "discovery_hits"
    __table_args__ = (
        UniqueConstraint("user_id", "discovery_video_id", "source"),
        _AUTOINCREMENT,
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    discovery_video_id: int = Field(
        foreign_key="discovery_videos.id", index=True, ondelete="CASCADE"
    )
    #: search (a query built from the user's interests) | related (a video's up next)
    source: str
    #: The query, or the YouTube id of the watched video it was related to.
    seed: str
    #: The watched video's title (related), for "Because you watched ...".
    seed_title: str | None = None
    #: recent | throwback: which part of the history the seed came from.
    era: str = "recent"
    #: Position in the source's results (0 = first).
    rank: int = 0
    found_at: datetime = Field(default_factory=utcnow)


class DiscoveryState(SQLModel, table=True):
    """Per user: when Recommended+ last looked outside, and what it asked."""

    __tablename__ = "discovery_state"

    user_id: int = Field(foreign_key="users.id", primary_key=True, ondelete="CASCADE")
    #: The user last opened Recommended+ (only active users are gathered for).
    last_viewed_at: datetime | None = None
    last_run_at: datetime | None = None
    #: A refresh the user asked for, picked up by the next worker pass.
    requested_at: datetime | None = None
    last_error: str | None = None
    #: JSON {query or seed id: ISO time it last ran}, so nothing repeats too soon.
    asked_json: str = Field(default="{}")


class RecFeedback(SQLModel, table=True):
    """What a user told recommendations to leave out.

    ``kind``: ``video`` (key: YouTube id, or ``video:<id>`` for a library video
    without one), ``channel`` (key: normalized channel URL, or ``name:<lowercased
    name>``) or ``suggestion`` (a suggested channel dismissed, same keys as channel).
    """

    __tablename__ = "rec_feedback"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "kind", "key", name="uq_rec_feedback_user_kind_key"
        ),
        _AUTOINCREMENT,
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    kind: str
    key: str
    #: What the user saw (a title or channel name), for the list in Account.
    label: str | None = None
    created_at: datetime = Field(default_factory=utcnow)


class RecImpression(SQLModel, table=True):
    """How often a recommendation was shown to a user without being watched."""

    __tablename__ = "rec_impressions"

    user_id: int = Field(foreign_key="users.id", primary_key=True, ondelete="CASCADE")
    #: Same keys as ``rec_feedback`` videos.
    key: str = Field(primary_key=True)
    #: Separate visits it was shown on (shows within an hour count once).
    shown_count: int = 0
    last_shown_at: datetime = Field(default_factory=utcnow)


class YoutubeWatchEvent(SQLModel, table=True):
    """One view in a user's YouTube watch history, read from a Google Takeout export.

    Kept apart from ``user_video_state`` (Horde's own history): these views never
    show in History or Continue watching. Recommendations, channel pages, the
    Download page and (when the user opts in) the History stats read them
    (``services/takeout/history.py``). One row per view, so importing an export
    that overlaps an earlier one only adds the views that are new.
    """

    __tablename__ = "youtube_watch_events"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "yt_id", "watched_at", name="uq_youtube_watch_events_view"
        ),
        Index("ix_youtube_watch_events_user_watched", "user_id", "watched_at"),
        Index("ix_youtube_watch_events_user_yt", "user_id", "yt_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", ondelete="CASCADE")
    yt_id: str
    watched_at: datetime
    title: str | None = None
    channel: str | None = None
    # Normalized (services/follows.normalize_channel_url).
    channel_url: str | None = None
    imported_at: datetime = Field(default_factory=utcnow)


class KbChannelStatus(str, Enum):
    queued = "queued"
    listing = "listing"
    indexing = "indexing"
    ready = "ready"
    paused = "paused"
    error = "error"


class KbChannel(SQLModel, table=True):
    """A YouTube channel whose captions Ask indexes (``services/knowledge``).

    Independent of the channel catalog: the catalog trims, merges and can be off,
    and captions take hours to fetch, so nothing here cascades from catalog rows.
    """

    __tablename__ = "kb_channels"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    channel_url: str = Field(index=True, unique=True)
    channel_name: str | None = None
    include_streams: bool = Field(default=False)
    # None = every upload.
    max_videos: int | None = None
    status: KbChannelStatus = Field(default=KbChannelStatus.queued, index=True)
    # Embedding model and dimension of this channel's vectors (one per channel).
    embed_model: str | None = None
    embed_dim: int = 0
    last_listed_at: datetime | None = None
    last_error: str | None = None
    added_by: int | None = Field(
        default=None, foreign_key="users.id", ondelete="SET NULL"
    )
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class KbVideo(SQLModel, table=True):
    """One upload of an Ask channel and the state of its captions."""

    __tablename__ = "kb_videos"
    __table_args__ = (
        UniqueConstraint("kb_channel_id", "yt_id"),
        Index("ix_kb_videos_channel_status", "kb_channel_id", "fetch_status"),
        _AUTOINCREMENT,
    )

    id: int | None = Field(default=None, primary_key=True)
    kb_channel_id: int = Field(
        foreign_key="kb_channels.id", index=True, ondelete="CASCADE"
    )
    yt_id: str = Field(index=True)
    title: str | None = None
    description: str | None = None
    published_at: str | None = None
    duration: float | None = None
    is_stream: bool = Field(default=False)
    # Order in the channel's feed, 0 = newest (fetched first).
    position: int = Field(default=0)
    # pending | fetched | no_captions | members_only | failed
    fetch_status: str = Field(default="pending")
    attempts: int = 0
    next_attempt_at: datetime | None = None
    caption_auto: bool | None = None
    # zlib-compressed JSON ``[[start_sec, text], ...]`` of the cleaned captions, kept
    # so re-chunking never fetches again and citations can find the exact line.
    cues: bytes | None = None
    # Model the chunks were embedded with (None until embedded).
    embedded_model: str | None = None
    updated_at: datetime = Field(default_factory=utcnow)


class KbChunk(SQLModel, table=True):
    """A time-aligned passage of a video's captions. ``chunk_index`` -1 is the
    title and description. ``kb_chunks_fts`` indexes ``text`` (triggers)."""

    __tablename__ = "kb_chunks"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    kb_video_id: int = Field(foreign_key="kb_videos.id", index=True, ondelete="CASCADE")
    kb_channel_id: int = Field(
        foreign_key="kb_channels.id", index=True, ondelete="CASCADE"
    )
    chunk_index: int = 0
    start_sec: float = 0.0
    end_sec: float = 0.0
    text: str = Field(default="")


class KbChunkVector(SQLModel, table=True):
    """A passage's embedding as float16 (model and dimension are on the channel)."""

    __tablename__ = "kb_chunk_vectors"

    chunk_id: int = Field(
        primary_key=True, foreign_key="kb_chunks.id", ondelete="CASCADE"
    )
    vector: bytes = Field(default=b"")


class AskThread(SQLModel, table=True):
    """One user's Ask conversation (private to that user)."""

    __tablename__ = "ask_threads"
    __table_args__ = _AUTOINCREMENT

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    title: str = Field(default="")
    # JSON ``{"channel_ids": [...], "auto": bool}``.
    scope: str = Field(default="{}")
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class AskMessage(SQLModel, table=True):
    """One turn of an Ask conversation. ``sources`` snapshots the references."""

    __tablename__ = "ask_messages"

    id: int | None = Field(default=None, primary_key=True)
    thread_id: int = Field(foreign_key="ask_threads.id", index=True, ondelete="CASCADE")
    role: str = Field(default="user")  # user | assistant
    content: str = Field(default="")
    # JSON list of references: [{n, channel, title, yt_id, start_sec, passage}].
    sources: str | None = None
    cost: float | None = None
    model: str | None = None
    created_at: datetime = Field(default_factory=utcnow)

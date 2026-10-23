from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from .models import (
    DownloadDestination,
    JobStatus,
    PlaylistSource,
    PlaylistVisibility,
    VideoStatus,
)

#: Largest list a bulk endpoint accepts (video ids, pasted URLs).
MAX_BULK_ITEMS = 1000
#: Playlist-sized lists (entries, ordering) can legitimately be much longer.
MAX_PLAYLIST_ITEMS = 5000


def _http_url(value: str | None) -> str | None:
    """Links stored from user input are rendered as <a href>: http(s) only.

    An empty string is kept (the UI sends it to clear a field).
    """
    if value is None:
        return None
    text = value.strip()
    if not text:
        return text
    try:
        parts = urlsplit(text)
    except ValueError as exc:
        raise ValueError("Not a valid URL") from exc
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise ValueError("Must be an http:// or https:// URL")
    return text


HttpUrl = Annotated[str, AfterValidator(_http_url)]


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
    compat: CompatState | None = None
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
    channel_url: HttpUrl | None = None
    tags: list[str] | None = None
    user_tag: str | None = None  # mark a newly added tag as user-defined
    description: str | None = None
    notes: str | None = None
    source_url: HttpUrl | None = None
    published_at: datetime | None = None
    # Setting a remote URL fetches and caches the image server-side.
    thumbnail_url: HttpUrl | None = None
    # Explicit clear/set for "Use source" / keep-custom flows.
    title_is_custom: bool | None = None
    description_is_custom: bool | None = None


class WatchProgressUpdate(BaseModel):
    # 1e7 s is about 115 days: beyond any video, and finite so it can be stored.
    position_sec: float = Field(ge=0, le=1e7, allow_inf_nan=False)
    watched_at: datetime | None = Field(
        default=None,
        description=(
            "When the position was reached, for a save sent late (queued on a "
            "device while the server was unreachable). It is applied only if "
            "the account has saved nothing newer since, from any device. "
            "Omitted: the position is current."
        ),
    )


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
    urls: list[str] = Field(max_length=MAX_BULK_ITEMS)
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
    published_label: str | None = None
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
    #: Live right now: play it through ``/api/live/{id}/master.m3u8``.
    is_live: bool = False
    #: A recording of a finished live stream (often hours long).
    was_live: bool = False


class StreamAiRead(BaseModel):
    """AI results saved for a streamed (not downloaded) video."""

    #: The YouTube id the results are kept under; None when the URL has none.
    youtube_id: str | None = None
    #: False for a source Horde cannot key (not a YouTube video).
    supported: bool = True
    summary: str | None = None
    summary_model: str | None = None
    summary_cost: float | None = None
    chapters: list[ChapterRead] = []
    #: Whether captions were found; None until something needed them.
    has_captions: bool | None = None
    #: When the saved results are deleted unless the stream is opened again or
    #: the video is downloaded (which moves them onto it). None: nothing saved.
    expires_at: datetime | None = None


class StreamAiAction(BaseModel):
    url: str = Field(..., min_length=1, max_length=4000)
    force: bool = False


class StreamAiChatRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=4000)
    message: str = Field(..., min_length=1, max_length=4000)


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
    destination: DownloadDestination = DownloadDestination.library
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
    #: Why a queued job is not starting: it is waiting for disk space.
    held_reason: str | None = None

    @field_validator("destination", mode="before")
    @classmethod
    def _known_destination(cls, value: object) -> DownloadDestination:
        # Rows from older versions may hold a value that is no longer valid;
        # list the job as a library download instead of failing the whole list.
        try:
            return DownloadDestination(value)
        except ValueError:
            return DownloadDestination.library

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
    #: Set while queued jobs wait for disk space: ``library_full``, ``would_exceed``,
    #: ``low_disk`` or ``disk_full``, with the sentence to show.
    held_code: str | None = None
    held_reason: str | None = None


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
    #: yt-dlp live_status: ``is_live`` (live now), ``was_live`` (a past stream), ...
    live_status: str | None = None


class NextPartRead(BaseModel):
    """The upload that clearly continues a video (same series), if there is one.

    ``entry`` is None when the channel's next upload is not clearly the next
    part, or the channel is unknown; ``reason`` says why it matched.
    """

    entry: ChannelFeedEntry | None = None
    reason: str | None = None


class StreamRelatedPage(BaseModel):
    """Related videos for a stream: library and not-downloaded ones, marked.

    One page; ``next_cursor`` is always None (kept for the list envelope).
    """

    items: list[ChannelFeedEntry]
    next_cursor: str | None = None


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
    # Deleted videos waiting in the trash (counted in total_bytes: they still use disk).
    trash_bytes: int = 0


class ChannelRename(BaseModel):
    old_name: str
    new_name: str


class PlaylistCreate(BaseModel):
    name: str
    description: str | None = None
    #: Omitted: public for holders of manage_playlists, private for everyone else.
    visibility: PlaylistVisibility | None = None


class PlaylistUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    subscribed: bool | None = None
    quality_preset: str | None = None
    cover_video_id: int | None = None
    #: Owner only; making a playlist public takes manage_playlists.
    visibility: PlaylistVisibility | None = None


class PlaylistOwner(BaseModel):
    id: int
    username: str


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
    visibility: PlaylistVisibility = PlaylistVisibility.public
    #: None for a playlist that predates accounts and has no owner yet.
    owner: PlaylistOwner | None = None
    #: Whether the requesting user may rename, change or delete it.
    can_edit: bool = False


class PlaylistDetail(PlaylistRead):
    videos: list[VideoRead]


class PlaylistItemAdd(BaseModel):
    video_id: int | None = None
    url: str | None = None


class PlaylistReorder(BaseModel):
    video_ids: list[int] = Field(max_length=MAX_PLAYLIST_ITEMS)


class PlaylistListReorder(BaseModel):
    playlist_ids: list[int] = Field(max_length=MAX_BULK_ITEMS)


class PlaylistImport(BaseModel):
    url: str
    quality_preset: str = "best"
    name: str | None = None
    entries: list[str] = Field(default=[], max_length=MAX_PLAYLIST_ITEMS)
    subscribe: bool = False
    #: Omitted: public for holders of manage_playlists, private for everyone else.
    visibility: PlaylistVisibility | None = None


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
    urls: list[str] = Field(max_length=MAX_BULK_ITEMS)


class PlaylistSizeEstimate(BaseModel):
    sizes: dict[str, dict[str, int]] = {}


class BulkVideoDelete(BaseModel):
    video_ids: list[int] = Field(max_length=MAX_BULK_ITEMS)
    delete_files: bool = False


class BulkVideoNotes(BaseModel):
    video_ids: list[int] = Field(max_length=MAX_BULK_ITEMS)
    notes: str


class BulkMetadataRefresh(BaseModel):
    video_ids: list[int] = Field(default=[], max_length=MAX_BULK_ITEMS)
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
    video_ids: list[int] = Field(max_length=MAX_BULK_ITEMS)


class ReadyResponse(BaseModel):
    """``GET /api/ready``: 200 when ``ready``, 503 otherwise."""

    ready: bool
    database: bool
    migrations: bool
    workers: dict[str, bool]
    problems: list[str]


# --- Accounts ---------------------------------------------------------------


class AuthUserRead(BaseModel):
    """The signed-in user. ``permissions`` is effective: all of them for an admin."""

    id: int
    username: str
    is_admin: bool
    permissions: list[str]
    #: Profile picture cache key; None when there is none.
    avatar_version: int | None = None
    #: Other accounts on a device may see this account's offline downloads there.
    share_downloads: bool = True


class AuthState(BaseModel):
    users_exist: bool
    authenticated: bool
    user: AuthUserRead | None = None
    setup_completed: bool


class LoginRequest(BaseModel):
    username: str = Field(max_length=200)
    password: str = Field(max_length=2000)


class BootstrapRequest(BaseModel):
    username: str = Field(max_length=200)
    password: str = Field(max_length=2000)
    share_downloads: bool = True


class MeUpdate(BaseModel):
    """Changes to your own account preferences."""

    share_downloads: bool
    #: Required to stop sharing: that password also unlocks your downloads offline.
    current_password: str | None = Field(default=None, max_length=2000)


class AuthLoginResult(BaseModel):
    user: AuthUserRead


class ForgotPasswordRequest(BaseModel):
    username: str = Field(max_length=200)


class PasswordResetRequest(BaseModel):
    username: str = Field(max_length=200)
    #: The code from the server log; case, spaces and dashes do not matter.
    code: str = Field(max_length=64)
    new_password: str = Field(max_length=2000)


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=2000)
    new_password: str = Field(max_length=2000)


class SessionRead(BaseModel):
    """One signed-in browser of an account."""

    id: int
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ip: str | None = None
    user_agent: str | None = None
    #: "Safari on iPhone", parsed from ``user_agent``.
    device: str
    #: The browser making this request.
    current: bool


class SessionList(BaseModel):
    items: list[SessionRead]


class MediaTokenRead(BaseModel):
    token: str
    expires_at: datetime


class PermissionInfo(BaseModel):
    name: str
    label: str
    description: str
    default: bool


class UserRead(BaseModel):
    id: int
    username: str
    is_admin: bool
    disabled: bool
    #: Effective permissions (all of them for an admin).
    permissions: list[str]
    created_at: datetime
    last_login_at: datetime | None = None
    #: Profile picture cache key; None when there is none.
    avatar_version: int | None = None
    share_downloads: bool = True


class UserCreate(BaseModel):
    username: str = Field(max_length=200)
    password: str = Field(max_length=2000)
    is_admin: bool = False
    #: Members only. Omitted = the default grants (see /api/users/permissions).
    permissions: list[str] | None = None
    share_downloads: bool = True


class UserUpdate(BaseModel):
    is_admin: bool | None = None
    disabled: bool | None = None
    password: str | None = Field(default=None, max_length=2000)
    permissions: list[str] | None = None
    share_downloads: bool | None = None


class FollowedChannelRead(BaseModel):
    channel_url: str
    channel_name: str | None = None
    #: download | manual | library
    source: str
    created_at: datetime


class FollowListResponse(BaseModel):
    """Every channel the signed-in user follows (one page; ``next_cursor`` is null)."""

    items: list[FollowedChannelRead] = []
    next_cursor: str | None = None


class FollowRequest(BaseModel):
    #: A channel URL or an ``@handle``.
    channel_url: str = Field(min_length=1, max_length=500)
    channel_name: str | None = Field(default=None, max_length=300)


class UnfollowResult(BaseModel):
    channel_url: str
    following: bool = False


class LiveChannelRead(BaseModel):
    channel_url: str
    channel_name: str | None = None
    video_id: str
    title: str | None = None
    #: The game card YouTube shows for Gaming streams, when there is one.
    game: str | None = None
    viewers: int | None = None
    started_at: datetime | None = None
    thumbnail_url: str
    watch_url: str


class ChannelLiveResponse(BaseModel):
    """The broadcast a channel is live with right now, or ``live: null``."""

    live: LiveChannelRead | None = None


class LiveListResponse(BaseModel):
    """Followed channels that are live now (one page; ``next_cursor`` is null)."""

    items: list[LiveChannelRead] = []
    next_cursor: str | None = None
    #: False when the server's live checks are turned off (``HORDE_LIVE_POLL_SEC=0``).
    enabled: bool = True


class TrashItemRead(BaseModel):
    """A deleted video in the trash."""

    id: int
    video_id: int
    youtube_id: str | None = None
    title: str
    channel: str | None = None
    size_bytes: int
    trashed_at: datetime
    #: When it is erased for good (``trashed_at`` plus ``HORDE_TRASH_DAYS``).
    expires_at: datetime
    #: Username of who deleted it (None when that account is gone).
    trashed_by: str | None = None
    #: Served by ``GET /api/trash/{id}/thumbnail``; None when it had none.
    thumbnail_url: str | None = None


class TrashPage(BaseModel):
    items: list[TrashItemRead]
    next_cursor: str | None = None


class TrashSummary(BaseModel):
    count: int
    total_bytes: int
    #: ``HORDE_TRASH_DAYS``: 0 means new deletes are immediate (entries already in the
    #: trash still expire after the default 7 days).
    retention_days: int


class TrashRestored(BaseModel):
    video_id: int
    title: str


class TrashEmptied(BaseModel):
    deleted: int
    freed_bytes: int

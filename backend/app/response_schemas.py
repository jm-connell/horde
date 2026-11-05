"""Response models for routes that used to return ad-hoc dicts, plus the error
envelope and the pagination wrapper.

Models that belong to one area of the API and already live in ``schemas.py`` stay
there; this module holds the ones added when every JSON route got a
``response_model``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .schemas import ChannelFeedEntry, TagStat, VideoRead
from .services.discovery.tuning import Tuning


class ErrorField(BaseModel):
    loc: list[str | int]
    msg: str


class ErrorResponse(BaseModel):
    """The body of every error response (see ``app/errors.py``)."""

    detail: str
    code: str
    fields: list[ErrorField] | None = None
    extra: dict[str, Any] | None = None
    request_id: str | None = Field(
        default=None, description="Echo of X-Request-ID, set on unhandled 500s."
    )


class VideoPage(BaseModel):
    """One page of videos. Pass ``next_cursor`` back as ``cursor`` for the next."""

    items: list[VideoRead]
    next_cursor: str | None = Field(
        default=None, description="Opaque token; null on the last page."
    )
    total: int | None = Field(
        default=None, description="Matching rows; only present with include_total=true."
    )


class TagPage(BaseModel):
    """Alphabetical tags; follow ``next_cursor`` for the rest."""

    items: list[str]
    next_cursor: str | None = None


class TagStatPage(BaseModel):
    """Tags with video counts, most used first."""

    items: list[TagStat]
    next_cursor: str | None = None


class OkResponse(BaseModel):
    ok: bool = True


class PausedResponse(BaseModel):
    paused: bool


# --- AI ----------------------------------------------------------------------


class AiModelRow(BaseModel):
    """A model an endpoint offers; prices only come from OpenRouter."""

    id: str
    name: str = ""
    prompt_per_million: float | None = None
    completion_per_million: float | None = None


class AiModelPreset(BaseModel):
    id: str
    label: str
    model: str


class AiConnectionTest(BaseModel):
    """Result of probing an OpenAI-compatible endpoint (``POST /api/ai/test``)."""

    ok: bool
    base_url: str | None = None
    detail: str | None = None
    #: ``openrouter`` | ``ollama`` | ``openai_compatible``
    kind: str | None = None
    models: list[AiModelRow] = Field(default_factory=list)
    embedding_models: list[AiModelRow] = Field(default_factory=list)
    presets: list[AiModelPreset] = Field(default_factory=list)


class AiDetectedServer(BaseModel):
    label: str
    base_url: str
    kind: str


class AiDetectResult(BaseModel):
    """Local AI servers found at the usual addresses (``POST /api/ai/detect``)."""

    servers: list[AiDetectedServer] = Field(default_factory=list)


class AiRuntimeRead(BaseModel):
    """The resolved workload profile (``RuntimeConfig`` in services/ai/workload)."""

    profile: str
    vram_tier: str
    embed_model: str
    chat_model: str
    invent_sample_size: int
    invent_budget_chars: int
    invent_desc_chars: int
    invent_sub_chars: int
    category_min_score: float
    enqueue_embed_limit: int
    enqueue_tag_limit: int
    recommended_profile: str
    profile_locked: bool
    lock_reason: str | None = None
    warning: str | None = None
    gpu_name: str | None = None
    vram_total_bytes: int | None = None
    gpu_source: str = "unknown"


class AiApplyWorkloadResult(BaseModel):
    ok: bool
    runtime: AiRuntimeRead
    embed_model_changed: bool
    pulled: bool
    detail: str


class AiRetryFailedResult(BaseModel):
    ok: bool = True
    retried: int


class AiClearFailedResult(BaseModel):
    ok: bool = True
    deleted: int


class AiJobAction(BaseModel):
    ok: bool = True
    id: int


class AiCategoriesRead(BaseModel):
    categories: list[str]


# --- Library media -----------------------------------------------------------


class SpriteMetaRead(BaseModel):
    interval_sec: int
    tile_width: int
    tile_height: int
    columns: int
    count: int
    duration_sec: float


class SpriteGenerateResult(BaseModel):
    status: Literal["ready", "generating"]


class ThumbnailCandidate(BaseModel):
    index: int
    at_seconds: float
    url: str


class ThumbnailCandidates(BaseModel):
    candidates: list[ThumbnailCandidate]


class VideoAiChatMessageRead(BaseModel):
    id: int | None = None
    role: Literal["user", "assistant"]
    content: str
    cost: float | None = None
    model: str | None = None
    created_at: str | None = None


class VideoAiChatHistory(BaseModel):
    messages: list[VideoAiChatMessageRead]


# --- Compat ------------------------------------------------------------------


class CompatSummaryRead(BaseModel):
    copy_cap: int
    videos: int
    library_bytes: int
    by_codec: dict[str, int]
    unprobed: int
    compat_ready: int
    compat_bytes: int
    compat_missing: int
    compat_missing_est_bytes: int
    convertible: int
    convertible_bytes: int
    queued: int
    running: int
    convert_queued: int
    convert_running: int


class CompatCancelResult(BaseModel):
    cancelled: int


# --- Channels ----------------------------------------------------------------


class ChannelRenameResult(BaseModel):
    updated: int
    retention_disabled: bool = Field(
        default=False,
        description=(
            "The rename merged two channels and a retention rule that was on "
            "was turned off, so it does not apply to the other channel's videos."
        ),
    )


# --- System ------------------------------------------------------------------


class DiskUsage(BaseModel):
    total_bytes: int
    used_bytes: int
    free_bytes: int


class GpuStats(BaseModel):
    name: str | None = None
    vendor: str | None = None
    util_percent: float | None = None
    temp_c: float | None = None
    vram_used_bytes: int | None = None
    vram_total_bytes: int | None = None


class EncodeStats(BaseModel):
    hw_h264: bool
    hw_hevc: bool
    ffmpeg_has_hw_encoder: bool
    gpu_name: str | None = None
    gpu_vendor: str | None = None
    encoder_h264: str | None = None
    encoder_hevc: str | None = None
    ffmpeg_bin: str | None = None


class SystemStatsRead(BaseModel):
    cpu_percent: float | None = None
    cpu_model: str | None = None
    cpu_temp_c: float | None = None
    cpu_count: int | None = None
    ram_used_bytes: int | None = None
    ram_total_bytes: int | None = None
    ram_percent: float | None = None
    gpu: GpuStats | None = None
    disk: DiskUsage | None = None
    encode: EncodeStats | None = None


class UpdateCheckRead(BaseModel):
    repo: str
    source: str | None = None
    current_sha: str
    current_short: str
    current_version: str | None = None
    latest_sha: str | None = None
    latest_short: str | None = None
    latest_version: str | None = None
    latest_html_url: str | None = None
    update_available: bool
    checked_at: str
    error: str | None = None


class UpdateControlRead(BaseModel):
    """The "Update now" button: whether the host watcher is set up, and progress."""

    watcher_connected: bool
    watcher_last_seen: str | None = None
    state: Literal[
        "idle",
        "requested",
        "running",
        "updated",
        "up_to_date",
        "rolled_back",
        "failed",
        "interrupted",
    ]
    request_id: str | None = None
    requested_at: str | None = None
    requested_by: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None
    log_tail: list[str] = Field(default_factory=list)


class PingResponse(BaseModel):
    ok: bool = True


# --- Health ------------------------------------------------------------------


class HealthPublic(BaseModel):
    """What an anonymous caller (a load balancer, the sign-in page) may see."""

    status: str
    setup_required: bool
    auth_required: bool


class FfmpegInfo(BaseModel):
    flavor: str | None = None
    version: str | None = None


class PotProviderStatus(BaseModel):
    status: str
    url: str | None = None
    version: str | None = None
    detail: str | None = None


class AiHealth(BaseModel):
    enabled: bool
    configured: bool = False
    #: ``openrouter`` | ``ollama`` | ``openai_compatible`` (from the last probe).
    provider: str | None = None
    reachable: bool
    base_url: str | None = None
    pulling: list[str] | None = None
    last_error: str | None = None


class HealthDownloads(BaseModel):
    active: int
    paused: bool
    #: Set while queued downloads wait for disk space (the library size limit or
    #: the free-space floor), with the sentence the UI shows.
    held_code: str | None = None
    held_reason: str | None = None


class HealthWorkers(BaseModel):
    ai_queue_depth: int
    ai_running: int
    ai_error_count: int
    ai_blocked_reason: str | None = None
    catalog_queue_depth: int
    catalog_indexing: bool


class ExtractFailure(BaseModel):
    kind: str
    message: str
    at: str
    target: str | None = None
    url: str | None = None


class HealthYoutube(BaseModel):
    cookies_configured: bool
    last_extract_failure: ExtractFailure | None = None


class HealthFull(BaseModel):
    """``GET /api/health`` for a signed-in user."""

    status: str
    horde_sha: str | None = None
    horde_version: str | None = None
    yt_dlp_version: str | None = None
    ffmpeg: FfmpegInfo | None = None
    pot_provider: PotProviderStatus | None = None
    ai: AiHealth | None = None
    disk: DiskUsage | None = None
    storage_warning: str | None = None
    library_video_count: int
    review_pending_count: int
    active_downloads: int
    wiki_available: bool
    downloads: HealthDownloads
    workers: HealthWorkers
    youtube: HealthYoutube


# --- Backgrounds and fonts ---------------------------------------------------


class BackgroundRead(BaseModel):
    id: str
    url: str
    mime: str
    animated: bool
    filename: str | None = None


class BackgroundList(BaseModel):
    items: list[BackgroundRead]


class BackgroundPalette(BaseModel):
    colors: list[str]


class FontRead(BaseModel):
    id: str
    url: str
    mime: str
    filename: str | None = None


class FontList(BaseModel):
    items: list[FontRead]


# --- Recommended+ ------------------------------------------------------------


class DiscoverReasonRead(BaseModel):
    #: subscription | similar | new_channel | throwback | library | live
    kind: str
    text: str
    #: A longer why (``Because you watched ...``) for a tooltip.
    detail: str | None = None


class DiscoverScorePartRead(BaseModel):
    label: str
    value: float


class DiscoverWhyRead(BaseModel):
    """How the feed placed one pick: its bucket and what its score is made of."""

    #: subscriptions | similar | new | throwback | rewatch
    bucket: str
    score: float
    #: The parts add up to ``score``.
    parts: list[DiscoverScorePartRead]
    #: Where it came from: a YouTube search, an up next list, the library, ...
    found_by: str | None = None
    #: False when it was not close enough to the user's taste for its bucket
    #: and waits at the end of the feed.
    eligible: bool = True


class DiscoverItemRead(BaseModel):
    """A library video (``video``) or a video that is not downloaded (``stream``)."""

    #: The YouTube id, or ``video:<id>`` for a library video without one. Feedback
    #: and impressions name the item by it.
    key: str
    video: VideoRead | None = None
    stream: ChannelFeedEntry | None = None
    reason: DiscoverReasonRead
    #: library (downloaded), channels (not downloaded, from a channel the user
    #: follows or that is indexed) or new (from any other channel).
    source: Literal["library", "channels", "new"]
    #: Why the feed placed it (live broadcasts have none).
    why: DiscoverWhyRead | None = None


class DiscoverStatusRead(BaseModel):
    #: Recommended+ may ask YouTube for videos (its switch and video search are on).
    enabled: bool
    #: The gatherer is working for this user right now, or will on its next pass.
    gathering: bool
    last_run_at: str | None = None
    #: Videos found outside the library and the catalogs for this user.
    found: int
    #: Too little watch history: the feed leans on the household and the library.
    cold: bool
    #: YouTube pushed back; the gatherer is waiting before it asks again.
    backing_off: bool


class DiscoverMixRead(BaseModel):
    bucket: str
    #: The share the user asked for (0..1).
    target: float
    #: The share it got among the top picks (0..1).
    actual: float


class DiscoverFeedRead(BaseModel):
    items: list[DiscoverItemRead]
    next_cursor: str | None = None
    status: DiscoverStatusRead
    #: Asked-for and actual share of each kind of pick (first page only).
    mix: list[DiscoverMixRead] = Field(default_factory=list)
    #: What each blocked topic left out (first page only).
    blocked: list[DiscoverBlockedRead] = Field(default_factory=list)
    #: The AI categories with picks in this feed, by name (first page only;
    #: empty without AI categories).
    categories: list[str] = Field(default_factory=list)


class HistoryWatchRead(BaseModel):
    """One video in the user's history, at its latest watch."""

    #: The YouTube id, or ``video:<id>`` for a library video without one.
    key: str
    watched_at: str
    #: Where it was watched, newest first: library, stream (played without
    #: downloading) or youtube (imported from Takeout).
    sources: list[Literal["library", "stream", "youtube"]]
    #: The library video, when it is downloaded.
    video: VideoRead | None = None
    #: How to show and play it otherwise.
    stream: ChannelFeedEntry | None = None
    #: How far the latest Horde watch got (0..1); unknown for a YouTube view.
    fraction: float | None = None
    #: Views imported from YouTube.
    youtube_views: int = 0
    #: Left out of recommendations by the user ("don't use for recommendations").
    excluded: bool = False


class HistoryWatchListRead(BaseModel):
    items: list[HistoryWatchRead]
    next_cursor: str | None = None
    #: Videos in the whole history (first page only).
    total: int | None = None


class HistoryRemovedRead(BaseModel):
    #: Videos asked for.
    videos: int
    #: Records removed: library progress, streamed watches, imported views.
    library: int
    streams: int
    youtube_views: int


class HistoryTasteRead(BaseModel):
    keys: list[str]
    excluded: bool


class ContinueYoutubeRead(BaseModel):
    """Videos watched on YouTube lately (from the import), for Continue watching."""

    items: list[ChannelFeedEntry]
    next_cursor: str | None = None


class RecTopicRead(BaseModel):
    id: int
    kind: Literal["interest", "block"]
    text: str
    match: Literal["words", "similar"]
    strength: Literal["low", "normal", "high"]
    expires_at: str | None = None
    #: False once it expired (it stays listed until turned on again or deleted).
    active: bool
    created_at: str


class RecTopicListRead(BaseModel):
    items: list[RecTopicRead]
    next_cursor: str | None = None


class DiscoverBlockedRead(BaseModel):
    topic_id: int
    #: Candidates the block left out of this ranking.
    count: int


class RecAlgorithmRead(BaseModel):
    id: int
    name: str
    shared: bool
    #: The owner's username.
    owner: str
    #: Your own (you may change or delete it).
    mine: bool
    values: Tuning
    updated_at: str


class RecAlgorithmListRead(BaseModel):
    """Your saved algorithms, then those others share."""

    items: list[RecAlgorithmRead]
    next_cursor: str | None = None


class RecTuningPresetRead(BaseModel):
    id: str
    name: str
    description: str
    values: Tuning


class RecTuningRead(BaseModel):
    """The user's Recommended+ settings and the presets they can pick from."""

    #: A preset id, "custom" or "algo:<id>".
    active: str
    #: What the feed ranks with now.
    values: Tuning
    #: The saved algorithm in use, when one is.
    algorithm: RecAlgorithmRead | None = None
    #: Your saved algorithm the own values started from ("Save" writes to it).
    based_on: RecAlgorithmRead | None = None
    #: The user's own values (kept while a preset is picked).
    custom: Tuning | None = None
    presets: list[RecTuningPresetRead]
    #: Balanced, for "reset".
    defaults: Tuning


class SuggestedChannelRead(BaseModel):
    name: str
    url: str
    reason: str | None = None
    #: Some of its videos the feed picked.
    videos: list[ChannelFeedEntry]
    #: Its catalog is indexed already (following adds its uploads at once).
    indexed: bool
    #: The median views and length (minutes) of the videos the feed picked.
    typical_views: int | None = None
    typical_minutes: int | None = None


class SuggestedChannelsRead(BaseModel):
    items: list[SuggestedChannelRead]


class RecFeedbackRead(BaseModel):
    id: int
    kind: str
    key: str
    label: str | None = None
    created_at: str


class RecFeedbackListRead(BaseModel):
    items: list[RecFeedbackRead]


class DiscoverRefreshRead(BaseModel):
    queued: bool
    detail: str


class StreamWatchRead(BaseModel):
    yt_id: str
    watched_sec: float
    finished: bool

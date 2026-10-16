"""Response models for routes that used to return ad-hoc dicts, plus the error
envelope and the pagination wrapper.

Models that belong to one area of the API and already live in ``schemas.py`` stay
there; this module holds the ones added when every JSON route got a
``response_model``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .schemas import TagStat, VideoRead


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


class AiConnectionTest(BaseModel):
    """Result of probing an Ollama base URL (``POST /api/ai/test``)."""

    ok: bool
    base_url: str | None = None
    detail: str | None = None
    models: list[str] | None = None


class OpenRouterConnectionTest(BaseModel):
    ok: bool
    detail: str | None = None
    model_count: int | None = None


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


class RecommendationSectionRead(BaseModel):
    title: str
    kind: str | None = None
    seed_video_id: int | None = None
    videos: list[VideoRead]


class RecommendationsRead(BaseModel):
    categories: list[str]
    sections: list[RecommendationSectionRead]
    hint: str | None = None
    has_more: bool = False


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


class OllamaHealth(BaseModel):
    enabled: bool
    ready: bool
    reachable: bool
    base_url: str | None = None
    pulling: list[str] | None = None
    last_error: str | None = None


class OpenRouterHealth(BaseModel):
    enabled: bool
    configured: bool | None = None
    api_key_set: bool | None = None
    model: str | None = None
    scope: str | None = None
    reachable: bool | None = None


class HealthDownloads(BaseModel):
    active: int
    paused: bool


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
    ollama: OllamaHealth | None = None
    openrouter: OpenRouterHealth | None = None
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

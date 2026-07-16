from typing import Any, Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..services import app_settings
from ..services.ai.provider import invalidate_resolved_url

router = APIRouter(prefix="/api/settings", tags=["settings"])


class AiSettingsRead(BaseModel):
    enabled: bool = True
    provider: str = "ollama"
    base_url: str = ""
    embed_model: str = "nomic-embed-text"
    chat_model: str = "llama3.2:3b"
    schedule: Literal["on_download", "on_request", "timer", "set_time"] = "on_download"
    timer_hours: float = 6
    schedule_time: str = "03:00"
    auto_pull_models: bool = True
    use_subtitles: bool = True
    enrich_tags: bool = True
    ai_summaries: bool = True
    ai_chat: bool = True
    summary_length: Literal["short", "medium", "long"] = "short"
    ai_duplicates: bool = True
    category_min_score: float = 0.55
    workload_profile: Literal["light", "normal", "heavy"] = "normal"
    vram_gb: Optional[float] = None
    paused: bool = False


class AiSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    provider: Optional[str] = None
    base_url: Optional[str] = None
    embed_model: Optional[str] = None
    chat_model: Optional[str] = None
    schedule: Optional[Literal["on_download", "on_request", "timer", "set_time"]] = None
    timer_hours: Optional[float] = Field(default=None, ge=0.25, le=168)
    schedule_time: Optional[str] = None
    auto_pull_models: Optional[bool] = None
    use_subtitles: Optional[bool] = None
    enrich_tags: Optional[bool] = None
    ai_summaries: Optional[bool] = None
    ai_chat: Optional[bool] = None
    summary_length: Optional[Literal["short", "medium", "long"]] = None
    ai_duplicates: Optional[bool] = None
    category_min_score: Optional[float] = Field(default=None, ge=0.20, le=0.90)
    workload_profile: Optional[Literal["light", "normal", "heavy"]] = None
    vram_gb: Optional[float] = Field(default=None, ge=0.5, le=256)
    paused: Optional[bool] = None


class AppSettingsRead(BaseModel):
    progress_expiry_days: int
    metadata_sync_interval_hours: int = 24
    channel_catalog_enabled: bool = True
    channel_catalog_max_videos: int = 1000
    ui: dict[str, Any] = Field(default_factory=dict)
    ai: AiSettingsRead = Field(default_factory=AiSettingsRead)


class AppSettingsUpdate(BaseModel):
    progress_expiry_days: Optional[int] = Field(default=None, ge=1, le=365)
    metadata_sync_interval_hours: Optional[int] = Field(default=None, ge=1, le=168)
    channel_catalog_enabled: Optional[bool] = None
    channel_catalog_max_videos: Optional[int] = Field(
        default=None,
        ge=app_settings.CHANNEL_CATALOG_MAX_MIN,
        le=app_settings.CHANNEL_CATALOG_MAX_MAX,
    )
    ui: Optional[dict[str, Any]] = None
    ai: Optional[AiSettingsUpdate] = None


def _ai_read(data: dict[str, Any]) -> AiSettingsRead:
    raw = data.get("ai") if isinstance(data.get("ai"), dict) else {}
    merged = {**app_settings.AI_DEFAULTS, **raw}
    # Drop internal-only keys (e.g. last_daily_run) before validating.
    allowed = set(AiSettingsRead.model_fields)
    filtered = {k: v for k, v in merged.items() if k in allowed}
    if "category_min_score" in filtered:
        filtered["category_min_score"] = app_settings.clamp_category_min_score(
            filtered["category_min_score"]
        )
    if "summary_length" in filtered:
        filtered["summary_length"] = app_settings.normalize_summary_length(
            filtered["summary_length"]
        )
    if "vram_gb" in filtered:
        filtered["vram_gb"] = app_settings.clamp_vram_gb(filtered["vram_gb"])
    return AiSettingsRead(**filtered)


def _settings_read(data: dict[str, Any]) -> AppSettingsRead:
    ui = data.get("ui") if isinstance(data.get("ui"), dict) else {}
    try:
        interval = int(data.get("metadata_sync_interval_hours") or 24)
    except (TypeError, ValueError):
        interval = 24
    interval = max(1, min(168, interval))
    return AppSettingsRead(
        progress_expiry_days=data["progress_expiry_days"],
        metadata_sync_interval_hours=interval,
        channel_catalog_enabled=bool(data.get("channel_catalog_enabled", True)),
        channel_catalog_max_videos=app_settings.clamp_catalog_max_videos(
            data.get("channel_catalog_max_videos")
        ),
        ui=ui,
        ai=_ai_read(data),
    )


@router.get("", response_model=AppSettingsRead)
def get_settings():
    return _settings_read(app_settings.load())


@router.patch("", response_model=AppSettingsRead)
def update_settings(payload: AppSettingsUpdate):
    updates: dict = {}
    if payload.progress_expiry_days is not None:
        updates["progress_expiry_days"] = payload.progress_expiry_days
    if payload.metadata_sync_interval_hours is not None:
        updates["metadata_sync_interval_hours"] = payload.metadata_sync_interval_hours
    if payload.channel_catalog_enabled is not None:
        updates["channel_catalog_enabled"] = payload.channel_catalog_enabled
    if payload.channel_catalog_max_videos is not None:
        updates["channel_catalog_max_videos"] = app_settings.clamp_catalog_max_videos(
            payload.channel_catalog_max_videos
        )
    if payload.ui is not None:
        updates["ui"] = payload.ui
    if payload.ai is not None:
        ai_updates = payload.ai.model_dump(exclude_unset=True)
        if "vram_gb" in ai_updates:
            # Allow clearing the override with null; Field ge=0.5 rejects 0.
            ai_updates["vram_gb"] = app_settings.clamp_vram_gb(ai_updates["vram_gb"])
        if "summary_length" in ai_updates:
            ai_updates["summary_length"] = app_settings.normalize_summary_length(
                ai_updates["summary_length"]
            )
        # Applying a workload profile resolves models + match score for Ollama GPU.
        if "workload_profile" in ai_updates:
            from ..services.ai import workload as ai_workload

            runtime = ai_workload.resolve_runtime(ai_updates["workload_profile"])
            ai_updates.update(ai_workload.settings_patch_for_runtime(runtime))
        updates["ai"] = ai_updates
        if "base_url" in ai_updates:
            invalidate_resolved_url()
    data = app_settings.save(updates) if updates else app_settings.load()
    return _settings_read(data)

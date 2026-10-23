import json
from typing import Any, Literal, cast

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..auth import current_user, ensure_admin, require_admin
from ..context import AppContext, get_ctx, get_session
from ..errors import CodedHTTPException
from ..services import app_settings, media_sidecars, user_settings
from ..services.ai.provider import (
    invalidate_resolved_url,
    mask_openrouter_api_key,
    normalize_openrouter_model,
    openrouter_api_key_set,
)
from ..services.auth import two_factor
from ..services.auth.accounts import AuthUser
from ..services.css_sanitize import sanitize_ui_css

router = APIRouter(prefix="/api/settings", tags=["settings"])

TwoFactorRequirement = Literal["off", "admins", "everyone"]

#: Largest the stored ``ui`` blob may grow to (all keys together, as JSON).
UI_MAX_BYTES = 256 * 1024


def _prepare_ui_update(ui: dict[str, Any], stored: dict[str, Any]) -> dict[str, Any]:
    """Sanitize a ``ui`` patch and refuse it if the merged blob would be too large."""
    cleaned: dict[str, Any] = sanitize_ui_css(ui)
    merged = {**stored, **cleaned}
    if len(json.dumps(merged, ensure_ascii=False).encode("utf-8")) > UI_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"UI settings are too large (max {UI_MAX_BYTES // 1024} KB)",
        )
    return cleaned


class AiSettingsRead(BaseModel):
    enabled: bool = True
    provider: str = "ollama"
    base_url: str = ""
    embed_model: str = "nomic-embed-text"
    chat_model: str = "llama3.2:3b"
    openrouter_enabled: bool = False
    openrouter_api_key: str = ""
    openrouter_api_key_set: bool = False
    openrouter_model: str = "google/gemini-2.5-flash-lite"
    openrouter_scope: Literal["specialized", "all"] = "specialized"
    openrouter_embed_model: str = "openai/text-embedding-3-small"
    ollama_prefer_embeddings: bool = False
    openrouter_show_costs: bool = False
    openrouter_weekly_budget_usd: float | None = None
    openrouter_budget_hard_limit: bool = False
    schedule: Literal["on_download", "on_request", "timer", "set_time"] = "on_download"
    timer_hours: float = 6
    schedule_time: str = "03:00"
    auto_pull_models: bool = True
    use_subtitles: bool = True
    enrich_tags: bool = True
    tag_rescan_days: int = 90
    ai_summaries: bool = True
    ai_chapters: bool = True
    ai_chapters_mode: Literal["on_download", "on_watch"] = "on_download"
    ai_chat: bool = True
    summary_length: Literal["short", "medium", "long"] = "short"
    ai_duplicates: bool = True
    category_min_score: float = 0.55
    workload_profile: Literal["light", "normal", "heavy"] = "normal"
    vram_gb: float | None = None
    paused: bool = False


class AiSettingsUpdate(BaseModel):
    enabled: bool | None = None
    provider: str | None = None
    base_url: str | None = None
    embed_model: str | None = None
    chat_model: str | None = None
    openrouter_enabled: bool | None = None
    openrouter_api_key: str | None = None
    openrouter_model: str | None = None
    openrouter_scope: Literal["specialized", "all"] | None = None
    openrouter_embed_model: str | None = None
    ollama_prefer_embeddings: bool | None = None
    openrouter_show_costs: bool | None = None
    # null clears; 0 / empty also cleared in clamp_weekly_budget_usd.
    openrouter_weekly_budget_usd: float | None = None
    openrouter_budget_hard_limit: bool | None = None
    schedule: Literal["on_download", "on_request", "timer", "set_time"] | None = None
    timer_hours: float | None = Field(default=None, ge=0.25, le=168)
    schedule_time: str | None = None
    auto_pull_models: bool | None = None
    use_subtitles: bool | None = None
    enrich_tags: bool | None = None
    tag_rescan_days: int | None = Field(
        default=None,
        ge=app_settings.TAG_RESCAN_DAYS_MIN,
        le=app_settings.TAG_RESCAN_DAYS_MAX,
    )
    ai_summaries: bool | None = None
    ai_chapters: bool | None = None
    ai_chapters_mode: Literal["on_download", "on_watch"] | None = None
    ai_chat: bool | None = None
    summary_length: Literal["short", "medium", "long"] | None = None
    ai_duplicates: bool | None = None
    category_min_score: float | None = Field(default=None, ge=0.20, le=0.90)
    workload_profile: Literal["light", "normal", "heavy"] | None = None
    vram_gb: float | None = Field(default=None, ge=0.5, le=256)
    paused: bool | None = None


class AppSettingsRead(BaseModel):
    progress_expiry_days: int
    metadata_sync_interval_hours: int = 24
    channel_catalog_enabled: bool = True
    channel_catalog_max_videos: int = 1000
    direct_youtube_search: bool = True
    youtube_video_search: bool = True
    # Downloads wait once the library takes this many bytes; null = no limit.
    max_library_bytes: int | None = None
    # Write Jellyfin / Kodi / Plex files (.nfo, -thumb.jpg) beside the media.
    media_server_sidecars: bool = False
    # Who must sign in with a second step (administrators only see this).
    require_two_factor: TwoFactorRequirement = "off"
    # True when app_settings.json is corrupt and unrecoverable (running on defaults).
    settings_degraded: bool = False
    setup_completed: bool = False
    ui: dict[str, Any] = Field(default_factory=dict)
    ai: AiSettingsRead = Field(default_factory=AiSettingsRead)


class AppSettingsUpdate(BaseModel):
    progress_expiry_days: int | None = Field(default=None, ge=1, le=365)
    metadata_sync_interval_hours: int | None = Field(default=None, ge=1, le=168)
    channel_catalog_enabled: bool | None = None
    channel_catalog_max_videos: int | None = Field(
        default=None,
        ge=app_settings.CHANNEL_CATALOG_MAX_MIN,
        le=app_settings.CHANNEL_CATALOG_MAX_MAX,
    )
    direct_youtube_search: bool | None = None
    youtube_video_search: bool | None = None
    # null (or 0) removes the limit.
    max_library_bytes: int | None = Field(
        default=None, ge=0, le=app_settings.MAX_LIBRARY_BYTES_MAX
    )
    media_server_sidecars: bool | None = None
    require_two_factor: TwoFactorRequirement | None = None
    setup_completed: bool | None = None
    ui: dict[str, Any] | None = None
    ai: AiSettingsUpdate | None = None


#: What a non-administrator gets of the AI settings: the switches the player and
#: library read to decide which features to show. Provider addresses, key tail,
#: models, budget and schedule are administrator business; the rest keep defaults.
MEMBER_VISIBLE_AI_FIELDS = frozenset(
    {
        "enabled",
        "paused",
        "openrouter_enabled",
        "openrouter_api_key_set",
        "openrouter_show_costs",
        "ai_summaries",
        "ai_chapters",
        "ai_chapters_mode",
        "ai_chat",
    }
)


#: Top-level fields only the administrator's settings screens read: how often
#: metadata and catalogs refresh, how large catalogs grow, whether indexing is on,
#: the library size limit, the media-server files switch, and whether the settings file is damaged. A member gets the defaults. (The
#: YouTube search switches and the progress expiry stay: member screens use them.)
MEMBER_HIDDEN_FIELDS = (
    "metadata_sync_interval_hours",
    "channel_catalog_enabled",
    "channel_catalog_max_videos",
    "max_library_bytes",
    "media_server_sidecars",
    "require_two_factor",
    "settings_degraded",
)


def _ai_read(data: dict[str, Any], *, admin: bool = True) -> AiSettingsRead:
    ai_value = data.get("ai")
    raw = ai_value if isinstance(ai_value, dict) else {}
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
        if "ai_chapters_mode" in filtered:
            filtered["ai_chapters_mode"] = app_settings.normalize_ai_chapters_mode(
                filtered["ai_chapters_mode"]
            )
    if "tag_rescan_days" in filtered:
        filtered["tag_rescan_days"] = app_settings.clamp_tag_rescan_days(
            filtered["tag_rescan_days"]
        )
    if "vram_gb" in filtered:
        filtered["vram_gb"] = app_settings.clamp_vram_gb(filtered["vram_gb"])
    stored_key = str(merged.get("openrouter_api_key") or "")
    filtered["openrouter_api_key"] = mask_openrouter_api_key(stored_key)
    filtered["openrouter_api_key_set"] = openrouter_api_key_set(stored_key)
    filtered["openrouter_model"] = normalize_openrouter_model(
        filtered.get("openrouter_model")
    )
    filtered["openrouter_scope"] = app_settings.normalize_openrouter_scope(
        filtered.get("openrouter_scope")
    )
    filtered["openrouter_embed_model"] = app_settings.normalize_openrouter_embed_model(
        filtered.get("openrouter_embed_model")
    )
    filtered["ollama_prefer_embeddings"] = bool(
        filtered.get("ollama_prefer_embeddings")
    )
    filtered["openrouter_show_costs"] = bool(
        filtered.get("openrouter_show_costs", False)
    )
    filtered["openrouter_weekly_budget_usd"] = app_settings.clamp_weekly_budget_usd(
        filtered.get("openrouter_weekly_budget_usd")
    )
    filtered["openrouter_budget_hard_limit"] = bool(
        filtered.get("openrouter_budget_hard_limit")
    )
    if not admin:
        filtered = {k: v for k, v in filtered.items() if k in MEMBER_VISIBLE_AI_FIELDS}
    return AiSettingsRead(**filtered)


def _settings_read(
    data: dict[str, Any], ui: dict[str, Any] | None = None, *, admin: bool = True
) -> AppSettingsRead:
    """``ui`` is the caller's effective preferences; default: the server-wide blob.

    ``admin=False`` trims the AI block to ``MEMBER_VISIBLE_AI_FIELDS`` and leaves
    the server-only fields (``MEMBER_HIDDEN_FIELDS``) at their defaults.
    """
    if ui is None:
        server_ui = data.get("ui")
        ui = server_ui if isinstance(server_ui, dict) else {}
    try:
        interval = int(data.get("metadata_sync_interval_hours") or 24)
    except TypeError, ValueError:
        interval = 24
    interval = max(1, min(168, interval))
    read = AppSettingsRead(
        progress_expiry_days=data["progress_expiry_days"],
        metadata_sync_interval_hours=interval,
        channel_catalog_enabled=bool(data.get("channel_catalog_enabled", True)),
        channel_catalog_max_videos=app_settings.clamp_catalog_max_videos(
            data.get("channel_catalog_max_videos")
        ),
        direct_youtube_search=app_settings.direct_youtube_search_system(data),
        youtube_video_search=app_settings.youtube_video_search_system(data),
        max_library_bytes=app_settings.clamp_max_library_bytes(
            data.get("max_library_bytes")
        ),
        media_server_sidecars=bool(data.get(media_sidecars.SETTING)),
        require_two_factor=cast(
            TwoFactorRequirement,
            two_factor.normalize_requirement(data.get("require_two_factor")),
        ),
        setup_completed=bool(data.get("setup_completed")),
        settings_degraded=app_settings.is_degraded(),
        ui=ui,
        ai=_ai_read(data, admin=admin),
    )
    if admin:
        return read
    fields = AppSettingsRead.model_fields
    return read.model_copy(
        update={name: fields[name].default for name in MEMBER_HIDDEN_FIELDS}
    )


@router.get("", response_model=AppSettingsRead)
def get_settings(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Server settings, with the caller's own ``ui`` preferences over the defaults."""
    return _settings_read(
        app_settings.load(),
        user_settings.effective_ui(session, user.id),
        admin=user.is_admin,
    )


@router.patch("", response_model=AppSettingsRead)
def update_settings(
    payload: AppSettingsUpdate,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
    ctx: AppContext = Depends(get_ctx),
):
    """Anyone may change their own ``ui`` preferences; every other field is
    server-wide and needs an administrator."""
    server_fields = payload.model_fields_set - {"ui"}
    if server_fields:
        ensure_admin(user)
    updates: dict = {}
    ui_patch: dict[str, Any] | None = None
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
    if payload.direct_youtube_search is not None:
        updates["direct_youtube_search"] = bool(payload.direct_youtube_search)
    if payload.youtube_video_search is not None:
        updates["youtube_video_search"] = bool(payload.youtube_video_search)
    if "max_library_bytes" in payload.model_fields_set:
        updates["max_library_bytes"] = app_settings.clamp_max_library_bytes(
            payload.max_library_bytes
        )
    if payload.media_server_sidecars is not None:
        updates[media_sidecars.SETTING] = payload.media_server_sidecars
    if payload.require_two_factor is not None:
        updates["require_two_factor"] = payload.require_two_factor
    if payload.setup_completed is False:
        raise HTTPException(
            status_code=400,
            detail="setup_completed can only be set to true; use POST /api/setup/reset to restart setup",
        )
    if payload.setup_completed is True:
        updates["setup_completed"] = True
    if payload.ui is not None:
        shared_ui, personal_ui = user_settings.split_ui(payload.ui)
        if shared_ui and user.is_admin:
            updates["ui"] = shared_ui
        elif user_settings.changes_shared_ui(shared_ui):
            # Server-owned keys (the download codec, the H.264 copy size) change
            # what the server does for everyone. A member's client may still echo
            # their current values, which is harmless; changing them is refused.
            ensure_admin(user)
        ui_patch = _prepare_ui_update(
            personal_ui, user_settings.stored_ui(session, user.id)
        )
    if payload.ai is not None:
        ai_updates = payload.ai.model_dump(exclude_unset=True)
        if "vram_gb" in ai_updates:
            # Allow clearing the override with null; Field ge=0.5 rejects 0.
            ai_updates["vram_gb"] = app_settings.clamp_vram_gb(ai_updates["vram_gb"])
        if "openrouter_weekly_budget_usd" in ai_updates:
            ai_updates["openrouter_weekly_budget_usd"] = (
                app_settings.clamp_weekly_budget_usd(
                    ai_updates["openrouter_weekly_budget_usd"]
                )
            )
        if "summary_length" in ai_updates:
            ai_updates["summary_length"] = app_settings.normalize_summary_length(
                ai_updates["summary_length"]
            )
        if "ai_chapters_mode" in ai_updates:
            ai_updates["ai_chapters_mode"] = app_settings.normalize_ai_chapters_mode(
                ai_updates["ai_chapters_mode"]
            )
        if "tag_rescan_days" in ai_updates:
            ai_updates["tag_rescan_days"] = app_settings.clamp_tag_rescan_days(
                ai_updates["tag_rescan_days"]
            )
        if "openrouter_model" in ai_updates:
            ai_updates["openrouter_model"] = normalize_openrouter_model(
                ai_updates["openrouter_model"]
            )
        if "openrouter_scope" in ai_updates:
            ai_updates["openrouter_scope"] = app_settings.normalize_openrouter_scope(
                ai_updates["openrouter_scope"]
            )
        if "openrouter_embed_model" in ai_updates:
            ai_updates["openrouter_embed_model"] = (
                app_settings.normalize_openrouter_embed_model(
                    ai_updates["openrouter_embed_model"]
                )
            )
        if "openrouter_api_key" in ai_updates:
            key = ai_updates["openrouter_api_key"]
            if key is None:
                del ai_updates["openrouter_api_key"]
            else:
                raw = str(key)
                # Ignore masked placeholders from the Settings form.
                if raw.startswith(("••••", "****")):
                    del ai_updates["openrouter_api_key"]
                else:
                    ai_updates["openrouter_api_key"] = raw.strip()
        # Applying a workload profile resolves models + match score for Ollama GPU.
        if "workload_profile" in ai_updates:
            from ..services.ai import workload as ai_workload

            runtime = ai_workload.resolve_runtime(ai_updates["workload_profile"])
            ai_updates.update(ai_workload.settings_patch_for_runtime(runtime))
        updates["ai"] = ai_updates
        if "base_url" in ai_updates:
            invalidate_resolved_url()
        if any(
            k in ai_updates
            for k in (
                "openrouter_enabled",
                "openrouter_api_key",
                "openrouter_model",
                "openrouter_scope",
                "openrouter_embed_model",
                "ollama_prefer_embeddings",
            )
        ):
            from ..services.ai import worker as ai_worker

            ai_worker.wake_worker()
    turned_on = (
        updates.get(media_sidecars.SETTING) is True and not media_sidecars.enabled()
    )
    data = app_settings.save(updates) if updates else app_settings.load()
    if turned_on:
        ctx.sidecars.write_all()
    if "max_library_bytes" in updates:
        # Held downloads may fit under the new limit now.
        ctx.download_queue.library_changed(room_made=True)
    if ui_patch is not None:
        ui = user_settings.save_ui(session, user.id, ui_patch)
    else:
        ui = user_settings.effective_ui(session, user.id)
    return _settings_read(data, ui, admin=user.is_admin)


class MediaSidecarsRemoval(BaseModel):
    queued: bool


@router.post(
    "/media-sidecars/remove",
    response_model=MediaSidecarsRemoval,
    status_code=202,
    dependencies=[Depends(require_admin)],
)
def remove_media_sidecars(ctx: AppContext = Depends(get_ctx)):
    """Delete the Jellyfin / Kodi / Plex files Horde wrote, in the background."""
    if media_sidecars.enabled():
        raise CodedHTTPException(
            409,
            "Turn the media-server files off first, or they would be written again.",
            "media_sidecars_enabled",
        )
    ctx.sidecars.remove_all()
    return MediaSidecarsRemoval(queued=True)

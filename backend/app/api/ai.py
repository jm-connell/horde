"""AI status, backlog controls, and recommendation endpoints."""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..auth import StreamAuthGuard, current_user, require_admin, require_permission
from ..context import get_session
from ..models import require_id
from ..openapi_responses import EVENT_STREAM, RAW
from ..response_schemas import (
    AiApplyWorkloadResult,
    AiCategoriesRead,
    AiClearFailedResult,
    AiConnectionTest,
    AiDetectResult,
    AiJobAction,
    AiRetryFailedResult,
    PausedResponse,
    RecommendationsRead,
)
from ..schemas import ChannelFeedEntry, HelpChatRequest
from ..services.ai import embeddings, help_chat, recommend, worker
from ..services.ai.provider import (
    build_status,
    detect_local_servers,
    invalidate_resolved_url,
    test_connection,
)
from ..services.auth.accounts import AuthUser
from ..services.discovery import feedback
from ..services.discovery.history import library_key
from .video_serialize import to_read_many as _to_read_many

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai", tags=["ai"])


class AiCurrentJob(BaseModel):
    id: int | None = None
    kind: str
    video_id: int | None = None
    title: str | None = None
    channel: str | None = None
    has_thumbnail: bool = False
    model: str | None = None
    attempts: int = 0
    error: str | None = None
    run_after: str | None = None


class AiJobFailure(BaseModel):
    id: int | None = None
    kind: str
    video_id: int | None = None
    catalog_video_id: int | None = None
    title: str | None = None
    attempts: int = 0
    error: str | None = None
    updated_at: str | None = None


class AiJobRow(BaseModel):
    id: int | None = None
    kind: str
    status: str
    video_id: int | None = None
    catalog_video_id: int | None = None
    title: str | None = None
    attempts: int = 0
    error: str | None = None
    run_after: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class AiStatusRead(BaseModel):
    enabled: bool
    #: A chat endpoint URL is set.
    configured: bool = False
    #: Chat endpoint kind: ``openrouter`` | ``ollama`` | ``openai_compatible`` | "".
    provider: str
    #: Semantic search works: the embedding endpoint answers and has the model.
    ready: bool
    #: The chat endpoint answers.
    reachable: bool
    base_url: str | None = None
    embed_model: str
    chat_model: str
    embed_model_present: bool
    chat_model_present: bool
    embed_provider: str = ""
    #: Set only when embeddings use their own endpoint.
    embed_base_url: str | None = None
    embed_reachable: bool = False
    #: The provider reports a cost per call (OpenRouter), so costs can show.
    reports_cost: bool = False
    pulling: list[str] = Field(default_factory=list)
    last_error: str | None = None
    paused: bool = False
    schedule: str = "on_download"
    indexed_videos: int = 0
    total_videos: int = 0
    queue_depth: int = 0
    queue_breakdown: dict[str, int] = Field(default_factory=dict)
    current_job: AiCurrentJob | None = None
    blocked_reason: str | None = None
    runnable_count: int = 0
    deferred_count: int = 0
    waiting_count: int = 0
    error_count: int = 0
    recent_failures: list[AiJobFailure] = Field(default_factory=list)
    workload_profile: str = "normal"
    recommended_profile: str = "normal"
    profile_locked: bool = False
    lock_reason: str | None = None
    workload_warning: str | None = None
    vram_tier: str = "unknown"
    gpu_name: str | None = None
    vram_total_bytes: int | None = None
    gpu_source: str = "unknown"
    invent_sample_size: int = 100
    invent_budget_chars: int = 28000
    models_match_profile: bool = True


class AiTestRequest(BaseModel):
    #: Which saved connection a blank URL or key falls back to.
    target: Literal["chat", "embed"] = "chat"
    base_url: str | None = Field(default=None, max_length=2048)
    api_key: str | None = Field(default=None, max_length=4096)


class AiApplyWorkloadRequest(BaseModel):
    profile: Literal["light", "normal", "heavy"] | None = None


class AiProcessRequest(BaseModel):
    action: Literal[
        "all",
        "all_recent",
        "all_full",
        "embeds",
        "reindex_embeds",
        "missing_tags",
        "full_tags",
        "categories",
    ] = "all"


class AiProcessResult(BaseModel):
    enqueued: int
    breakdown: dict[str, int] = Field(default_factory=dict)
    detail: str = ""


#: Setup details a member's screens never read, reset to their declared defaults.
#: Members keep ``enabled`` / ``ready`` / ``reachable`` / ``paused``, the queue
#: counts (the library's AI shelf) and ``reports_cost`` (the player decides which
#: AI features to offer).
_MEMBER_HIDDEN_DEFAULTS = (
    "schedule",
    "workload_profile",
    "recommended_profile",
    "profile_locked",
    "vram_tier",
    "gpu_source",
    "invent_sample_size",
    "invent_budget_chars",
    "models_match_profile",
    "configured",
    "embed_reachable",
)


def _member_view(status: AiStatusRead) -> AiStatusRead:
    """What a non-administrator sees: readiness and queue progress, not the setup.

    Provider type and address, schedule, model names, GPU details and error texts
    (which can quote a URL or a key fragment) stay with the administrator.
    """
    defaults = {
        name: AiStatusRead.model_fields[name].get_default(call_default_factory=True)
        for name in _MEMBER_HIDDEN_DEFAULTS
    }
    current = status.current_job
    if current is not None:
        current = current.model_copy(update={"error": None, "model": None})
    return status.model_copy(
        update={
            "base_url": None,
            "last_error": None,
            "embed_model": "",
            "chat_model": "",
            "embed_base_url": None,
            "embed_provider": "",
            "current_job": current,
            "recent_failures": [],
            "pulling": [],
            "blocked_reason": None,
            "workload_warning": None,
            "lock_reason": None,
            "gpu_name": None,
            "vram_total_bytes": None,
            "provider": "",
            **defaults,
        }
    )


@router.get("/status", response_model=AiStatusRead)
def ai_status(
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    from ..services import app_settings
    from ..services.ai import workload as ai_workload

    indexed, total = embeddings.indexed_count(session)
    status = build_status(
        indexed_videos=indexed,
        total_videos=total,
        queue_depth=worker.queue_depth(),
    )
    breakdown = worker.queue_breakdown()
    current = worker.current_job_info()
    stats = worker.queue_stats()
    ai = app_settings.ai_settings()
    runtime = ai_workload.resolve_runtime(ai.get("workload_profile"))
    # Only Ollama models are sized to the GPU; a hosted model always "matches".
    models_match = all(
        str(ai.get(field) or "") == wanted
        for field, wanted in ai_workload.settings_patch_for_runtime(runtime).items()
        if field in ("chat_model", "embed_model")
    )
    current_job = None
    if current:
        current_job = AiCurrentJob(
            id=current.get("id"),
            kind=current["kind"],
            video_id=current.get("video_id"),
            title=current.get("title"),
            channel=current.get("channel"),
            has_thumbnail=bool(current.get("has_thumbnail")),
            model=current.get("model"),
            attempts=int(current.get("attempts") or 0),
            error=current.get("error"),
            run_after=current.get("run_after"),
        )
    result = AiStatusRead(
        **status.__dict__,
        queue_breakdown=breakdown,
        current_job=current_job,
        blocked_reason=worker.blocked_reason(),
        runnable_count=int(stats.get("runnable_count") or 0),
        deferred_count=int(stats.get("deferred_count") or 0),
        waiting_count=int(stats.get("waiting_count") or 0),
        error_count=int(stats.get("error_count") or 0),
        recent_failures=[
            AiJobFailure(**row) for row in worker.recent_failures(limit=10)
        ],
        workload_profile=runtime.profile,
        recommended_profile=runtime.recommended_profile,
        profile_locked=runtime.profile_locked,
        lock_reason=runtime.lock_reason,
        workload_warning=runtime.warning,
        vram_tier=runtime.vram_tier,
        gpu_name=runtime.gpu_name,
        vram_total_bytes=runtime.vram_total_bytes,
        gpu_source=runtime.gpu_source,
        invent_sample_size=runtime.invent_sample_size,
        invent_budget_chars=runtime.invent_budget_chars,
        models_match_profile=models_match,
    )
    return result if user.is_admin else _member_view(result)


@router.post(
    "/apply-workload",
    response_model=AiApplyWorkloadResult,
    dependencies=[Depends(require_admin)],
)
def ai_apply_workload(payload: AiApplyWorkloadRequest = AiApplyWorkloadRequest()):
    """Apply a workload profile; on Ollama also pick and download GPU-sized models."""
    from ..services import app_settings
    from ..services.ai import workload as ai_workload
    from ..services.ai.provider import ensure_models

    ai = app_settings.ai_settings()
    profile = payload.profile or ai.get("workload_profile") or "normal"
    runtime = ai_workload.resolve_runtime(profile)
    prev_embed = str(ai.get("embed_model") or "")
    patch = ai_workload.settings_patch_for_runtime(runtime)
    app_settings.save({"ai": patch})
    invalidate_resolved_url()

    pulled = False
    if bool(ai.get("auto_pull_models", True)) and (
        "chat_model" in patch or "embed_model" in patch
    ):
        try:
            ensure_models()
            pulled = True
        except Exception:
            logger.warning(
                "could not pull the recommended AI models",
                exc_info=True,
            )

    embed_changed = prev_embed != patch.get("embed_model", prev_embed)
    return {
        "ok": True,
        "runtime": runtime.to_dict(),
        "embed_model_changed": embed_changed,
        "pulled": pulled,
        "detail": (
            f"Applied {runtime.profile} workload"
            + (f" ({runtime.gpu_name})" if runtime.gpu_name else "")
        ),
    }


@router.post(
    "/test",
    response_model=AiConnectionTest,
    response_model_exclude_unset=True,
    dependencies=[Depends(require_admin)],
)
def ai_test(payload: AiTestRequest = AiTestRequest()):
    """Probe an endpoint (or the saved one) and list the models it offers."""
    return test_connection(payload.target, payload.base_url, payload.api_key)


@router.post(
    "/detect",
    response_model=AiDetectResult,
    dependencies=[Depends(require_admin)],
)
def ai_detect():
    """Look for a local AI server at the usual addresses (Ollama, LM Studio, ...)."""
    return AiDetectResult.model_validate({"servers": detect_local_servers()})


class AiCostsRead(BaseModel):
    h24: float = 0.0
    d7: float = 0.0
    d30: float = 0.0
    y1: float = 0.0
    all: float = 0.0
    h24_calls: int = 0
    d7_calls: int = 0
    d30_calls: int = 0
    y1_calls: int = 0
    all_calls: int = 0
    weekly_budget_usd: float | None = None
    hard_limit: bool = False
    over_budget: bool = False
    blocked: bool = False


@router.get(
    "/costs",
    response_model=AiCostsRead,
    dependencies=[Depends(require_admin)],
)
def ai_costs():
    """Spend reported by the provider (only OpenRouter reports a cost per call)."""
    from ..services.ai.cost_ledger import budget_status, window_analytics

    stats = window_analytics()
    costs = {k: float(v["cost"]) for k, v in stats.items()}
    budget = budget_status(window_totals=costs)
    return AiCostsRead(
        h24=float(costs.get("h24") or 0.0),
        d7=float(costs.get("d7") or 0.0),
        d30=float(costs.get("d30") or 0.0),
        y1=float(costs.get("y1") or 0.0),
        all=float(costs.get("all") or 0.0),
        h24_calls=int(stats.get("h24", {}).get("calls") or 0),
        d7_calls=int(stats.get("d7", {}).get("calls") or 0),
        d30_calls=int(stats.get("d30", {}).get("calls") or 0),
        y1_calls=int(stats.get("y1", {}).get("calls") or 0),
        all_calls=int(stats.get("all", {}).get("calls") or 0),
        weekly_budget_usd=budget.get("weekly_budget_usd"),
        hard_limit=bool(budget.get("hard_limit")),
        over_budget=bool(budget.get("over_budget")),
        blocked=bool(budget.get("blocked")),
    )


@router.post(
    "/process", response_model=AiProcessResult, dependencies=[Depends(require_admin)]
)
def ai_process_library(payload: AiProcessRequest = AiProcessRequest()):
    invalidate_resolved_url()
    action = payload.action
    try:
        if action == "embeds":
            result = worker.enqueue_missing_embeds()
        elif action == "reindex_embeds":
            result = worker.enqueue_reindex_embeds()
        elif action == "missing_tags":
            result = worker.enqueue_missing_tags()
        elif action == "full_tags":
            result = worker.enqueue_full_tag_refresh()
        elif action == "categories":
            result = worker.enqueue_refresh_categories(force=True)
        elif action == "all_recent":
            result = worker.enqueue_all_recent()
        elif action in ("all_full", "all"):
            result = worker.enqueue_library_backlog(force=True)
        else:
            result = worker.enqueue_library_backlog(force=True)
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=str(exc) or "Enqueue failed"
        ) from exc
    return AiProcessResult(
        enqueued=result["enqueued"],
        breakdown=result["breakdown"],
        detail=result["detail"],
    )


@router.post(
    "/help/chat",
    response_class=RAW,
    responses=EVENT_STREAM,
    dependencies=[Depends(require_permission("use_ai"))],
)
def post_help_chat(
    request: Request,
    payload: HelpChatRequest,
    user: AuthUser = Depends(current_user),
):
    """Ask about Horde: answers from this server's docs and source (SSE)."""
    return StreamingResponse(
        help_chat.stream_help_events(
            payload.message,
            [turn.model_dump() for turn in payload.history],
            user.id,
            is_admin=user.is_admin,
            page=payload.page,
            authorized=StreamAuthGuard.of(request).still_valid,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/pause", response_model=PausedResponse, dependencies=[Depends(require_admin)]
)
def ai_pause():
    from ..services import app_settings

    app_settings.save({"ai": {"paused": True}})
    return {"paused": True}


@router.post(
    "/resume", response_model=PausedResponse, dependencies=[Depends(require_admin)]
)
def ai_resume():
    from ..services import app_settings

    app_settings.save({"ai": {"paused": False}})
    worker.wake_worker()
    return {"paused": False}


@router.get(
    "/jobs", response_model=list[AiJobRow], dependencies=[Depends(require_admin)]
)
def ai_list_jobs(
    status: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
):
    try:
        rows = worker.list_jobs(status=status, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [AiJobRow(**row) for row in rows]


@router.post(
    "/jobs/retry-failed",
    response_model=AiRetryFailedResult,
    dependencies=[Depends(require_admin)],
)
def ai_retry_failed():
    count = worker.retry_failed_jobs()
    return {"ok": True, "retried": count}


@router.post(
    "/jobs/clear-failed",
    response_model=AiClearFailedResult,
    dependencies=[Depends(require_admin)],
)
def ai_clear_failed(keep_days: int = Query(default=0, ge=0, le=365)):
    deleted = worker.clear_failed_jobs(keep_days=keep_days)
    return {"ok": True, "deleted": deleted}


@router.post(
    "/jobs/{job_id}/retry",
    response_model=AiJobAction,
    dependencies=[Depends(require_admin)],
)
def ai_retry_job(job_id: int):
    if not worker.retry_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found or not retryable")
    return {"ok": True, "id": job_id}


@router.post(
    "/jobs/{job_id}/cancel",
    response_model=AiJobAction,
    dependencies=[Depends(require_admin)],
)
def ai_cancel_job(job_id: int):
    if not worker.cancel_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found or not cancellable")
    return {"ok": True, "id": job_id}


@router.get("/recommendations", response_model=RecommendationsRead)
def ai_recommendations(
    category: str | None = Query(default=None),
    limit: int = Query(default=24, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    include_streams: bool = Query(
        default=False,
        description="Mix in indexed channels' uploads that are not downloaded.",
    ),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """The home page's "For you" shelf, or one category's videos.

    "For you" works without AI (ranked from the watch history alone); the
    category shelves need it.
    """
    ai_ready = build_status().ready
    if category:
        if not ai_ready:
            raise HTTPException(status_code=503, detail="AI not ready")
        result = recommend.videos_for_category(
            session, category, limit=limit, offset=offset
        )
        sections: list[dict[str, Any]] = []
        if result.videos:
            reads = _to_read_many(result.videos, session, viewer=user)
            sections.append(
                {
                    "title": "",
                    "kind": "category",
                    "seed_video_id": None,
                    "videos": reads,
                    "items": [{"video": r} for r in reads],
                }
            )
        return {
            "categories": result.categories,
            "sections": sections,
            "has_more": result.has_more,
        }

    page = recommend.homepage_recommendations_page(
        session,
        user_id=user.id,
        limit=limit,
        offset=offset,
        include_streams=include_streams,
    )
    reads = _to_read_many(page.videos, session, viewer=user)
    read_by_id = {r.id: r for r in reads}
    items: list[dict[str, Any]] = []
    for item in page.items:
        if item.video is not None:
            items.append({"video": read_by_id[require_id(item.video)]})
        elif item.stream is not None:
            items.append(
                {
                    "stream": ChannelFeedEntry(
                        id=item.stream.yt_id,
                        url=item.stream.url,
                        title=item.stream.title,
                        duration=item.stream.duration,
                        thumbnail_url=item.stream.thumbnail_url,
                        view_count=item.stream.view_count,
                        published_at=item.stream.published_at,
                        channel=item.channel or None,
                        live_status=item.stream.live_status,
                    )
                }
            )
    feedback.record_shown(
        session,
        user.id,
        [
            library_key(i.video.id, i.video.youtube_id)
            for i in page.items
            if i.video is not None
        ]
        + [i.stream.yt_id for i in page.items if i.stream is not None],
    )
    return {
        "categories": recommend.list_categories(session) if ai_ready else [],
        "sections": [
            {
                "title": "",
                "kind": "for_you",
                "seed_video_id": None,
                "videos": reads,
                "items": items,
            }
        ]
        if items
        else [],
        "has_more": page.has_more,
    }


@router.get("/categories", response_model=AiCategoriesRead)
def ai_categories(session: Session = Depends(get_session)):
    return {"categories": recommend.list_categories(session)}

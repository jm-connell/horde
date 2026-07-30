"""AI status, backlog controls, and recommendation endpoints."""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..database import get_session
from ..services.ai import embeddings, recommend, worker
from ..services.ai.provider import (
    build_status,
    invalidate_resolved_url,
    list_openrouter_embedding_models,
    list_openrouter_models,
    openrouter_preset_list,
    test_connection,
    test_openrouter_connection,
)
from .videos import _to_read

router = APIRouter(prefix="/api/ai", tags=["ai"])


class AiCurrentJob(BaseModel):
    id: Optional[int] = None
    kind: str
    video_id: Optional[int] = None
    title: Optional[str] = None
    channel: Optional[str] = None
    has_thumbnail: bool = False
    model: Optional[str] = None
    attempts: int = 0
    error: Optional[str] = None
    run_after: Optional[str] = None


class AiJobFailure(BaseModel):
    id: Optional[int] = None
    kind: str
    video_id: Optional[int] = None
    catalog_video_id: Optional[int] = None
    title: Optional[str] = None
    attempts: int = 0
    error: Optional[str] = None
    updated_at: Optional[str] = None


class AiJobRow(BaseModel):
    id: Optional[int] = None
    kind: str
    status: str
    video_id: Optional[int] = None
    catalog_video_id: Optional[int] = None
    title: Optional[str] = None
    attempts: int = 0
    error: Optional[str] = None
    run_after: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class AiStatusRead(BaseModel):
    enabled: bool
    provider: str
    ready: bool
    reachable: bool
    base_url: Optional[str] = None
    embed_model: str
    chat_model: str
    embed_model_present: bool
    chat_model_present: bool
    pulling: list[str] = Field(default_factory=list)
    last_error: Optional[str] = None
    paused: bool = False
    schedule: str = "on_download"
    indexed_videos: int = 0
    total_videos: int = 0
    queue_depth: int = 0
    queue_breakdown: dict[str, int] = Field(default_factory=dict)
    current_job: Optional[AiCurrentJob] = None
    blocked_reason: Optional[str] = None
    runnable_count: int = 0
    deferred_count: int = 0
    waiting_count: int = 0
    error_count: int = 0
    recent_failures: list[AiJobFailure] = Field(default_factory=list)
    workload_profile: str = "normal"
    recommended_profile: str = "normal"
    profile_locked: bool = False
    lock_reason: Optional[str] = None
    workload_warning: Optional[str] = None
    vram_tier: str = "unknown"
    gpu_name: Optional[str] = None
    vram_total_bytes: Optional[int] = None
    gpu_source: str = "unknown"
    invent_sample_size: int = 100
    invent_budget_chars: int = 28000
    models_match_profile: bool = True
    openrouter_enabled: bool = False
    openrouter_reachable: bool = False
    openrouter_model: str = "google/gemini-2.5-flash-lite"
    openrouter_api_key_set: bool = False
    openrouter_scope: str = "specialized"
    openrouter_embed_model: str = "openai/text-embedding-3-small"
    ollama_prefer_embeddings: bool = False
    llm_backend: Optional[str] = None
    embed_backend: Optional[str] = None


class AiTestRequest(BaseModel):
    base_url: Optional[str] = None


class OpenRouterTestRequest(BaseModel):
    api_key: Optional[str] = None


class OpenRouterModelRow(BaseModel):
    id: str
    name: str = ""


class OpenRouterModelsResponse(BaseModel):
    presets: list[dict[str, str]] = Field(default_factory=list)
    models: list[OpenRouterModelRow] = Field(default_factory=list)
    embedding_models: list[OpenRouterModelRow] = Field(default_factory=list)


class AiApplyWorkloadRequest(BaseModel):
    profile: Optional[Literal["light", "normal", "heavy"]] = None


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


@router.get("/status", response_model=AiStatusRead)
def ai_status(session: Session = Depends(get_session)):
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
    models_match = (
        str(ai.get("embed_model") or "") == runtime.embed_model
        and str(ai.get("chat_model") or "") == runtime.chat_model
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
    return AiStatusRead(
        **status.__dict__,
        queue_breakdown=breakdown,
        current_job=current_job,
        blocked_reason=worker.blocked_reason(),
        runnable_count=int(stats.get("runnable_count") or 0),
        deferred_count=int(stats.get("deferred_count") or 0),
        waiting_count=int(stats.get("waiting_count") or 0),
        error_count=int(stats.get("error_count") or 0),
        recent_failures=[AiJobFailure(**row) for row in worker.recent_failures(limit=10)],
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


@router.post("/apply-workload")
def ai_apply_workload(payload: AiApplyWorkloadRequest = AiApplyWorkloadRequest()):
    """Apply a workload profile: resolve models for the Ollama GPU, save, optional pull."""
    from ..services import app_settings
    from ..services.ai import workload as ai_workload
    from ..services.ai.provider import ensure_models, get_provider

    ai = app_settings.ai_settings()
    profile = payload.profile or ai.get("workload_profile") or "normal"
    runtime = ai_workload.resolve_runtime(profile)
    prev_embed = str(ai.get("embed_model") or "")
    patch = ai_workload.settings_patch_for_runtime(runtime)
    app_settings.save({"ai": patch})
    invalidate_resolved_url()

    pulled = False
    if bool(ai.get("auto_pull_models", True)):
        provider = get_provider()
        if provider is not None:
            try:
                ensure_models(provider)
                pulled = True
            except Exception:  # noqa: BLE001
                pass

    embed_changed = prev_embed != runtime.embed_model
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


@router.post("/test")
def ai_test(payload: AiTestRequest):
    return test_connection(payload.base_url)


@router.post("/openrouter/test")
def ai_openrouter_test(payload: OpenRouterTestRequest = OpenRouterTestRequest()):
    return test_openrouter_connection(payload.api_key)


@router.get("/openrouter/models", response_model=OpenRouterModelsResponse)
def ai_openrouter_models():
    try:
        models = list_openrouter_models()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc) or "Could not list models") from exc
    embed_models: list[dict[str, Any]] = []
    try:
        embed_models = list_openrouter_embedding_models()
    except Exception:  # noqa: BLE001
        embed_models = []
    return OpenRouterModelsResponse(
        presets=openrouter_preset_list(),
        models=[OpenRouterModelRow(id=m["id"], name=m.get("name") or m["id"]) for m in models],
        embedding_models=[
            OpenRouterModelRow(id=m["id"], name=m.get("name") or m["id"])
            for m in embed_models
        ],
    )


class OpenRouterCostsRead(BaseModel):
    h24: float = 0.0
    d7: float = 0.0
    d30: float = 0.0
    y1: float = 0.0
    all: float = 0.0
    weekly_budget_usd: Optional[float] = None
    hard_limit: bool = False
    over_budget: bool = False
    blocked: bool = False


@router.get("/openrouter/costs", response_model=OpenRouterCostsRead)
def ai_openrouter_costs():
    from ..services.ai.cost_ledger import budget_status, totals

    data = totals()
    budget = budget_status(window_totals=data)
    return OpenRouterCostsRead(
        h24=float(data.get("h24") or 0.0),
        d7=float(data.get("d7") or 0.0),
        d30=float(data.get("d30") or 0.0),
        y1=float(data.get("y1") or 0.0),
        all=float(data.get("all") or 0.0),
        weekly_budget_usd=budget.get("weekly_budget_usd"),
        hard_limit=bool(budget.get("hard_limit")),
        over_budget=bool(budget.get("over_budget")),
        blocked=bool(budget.get("blocked")),
    )


@router.post("/process", response_model=AiProcessResult)
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
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc) or "Enqueue failed") from exc
    return AiProcessResult(
        enqueued=result["enqueued"],
        breakdown=result["breakdown"],
        detail=result["detail"],
    )


@router.post("/pause")
def ai_pause():
    from ..services import app_settings

    app_settings.save({"ai": {"paused": True}})
    return {"paused": True}


@router.post("/resume")
def ai_resume():
    from ..services import app_settings

    app_settings.save({"ai": {"paused": False}})
    worker.wake_worker()
    return {"paused": False}


@router.get("/jobs", response_model=list[AiJobRow])
def ai_list_jobs(
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
):
    try:
        rows = worker.list_jobs(status=status, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [AiJobRow(**row) for row in rows]


@router.post("/jobs/retry-failed")
def ai_retry_failed():
    count = worker.retry_failed_jobs()
    return {"ok": True, "retried": count}


@router.post("/jobs/clear-failed")
def ai_clear_failed(keep_days: int = Query(default=0, ge=0, le=365)):
    deleted = worker.clear_failed_jobs(keep_days=keep_days)
    return {"ok": True, "deleted": deleted}


@router.post("/jobs/{job_id}/retry")
def ai_retry_job(job_id: int):
    if not worker.retry_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found or not retryable")
    return {"ok": True, "id": job_id}


@router.post("/jobs/{job_id}/cancel")
def ai_cancel_job(job_id: int):
    if not worker.cancel_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found or not cancellable")
    return {"ok": True, "id": job_id}


@router.get("/recommendations")
def ai_recommendations(
    category: Optional[str] = Query(default=None),
    limit: int = Query(default=24, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
):
    status = build_status()
    if not status.ready:
        raise HTTPException(status_code=503, detail="AI not ready")

    if category:
        result = recommend.videos_for_category(
            session, category, limit=limit, offset=offset
        )
        sections: list[dict[str, Any]] = []
        if result.videos:
            sections.append(
                {
                    "title": "",
                    "kind": "category",
                    "seed_video_id": None,
                    "videos": [_to_read(v, session) for v in result.videos],
                }
            )
        return {
            "categories": result.categories,
            "sections": sections,
            "has_more": result.has_more,
        }

    page = recommend.homepage_recommendations_page(
        session, limit=limit, offset=offset
    )
    return {
        "categories": recommend.list_categories(session),
        "sections": [
            {
                "title": "",
                "kind": "for_you",
                "seed_video_id": None,
                "videos": [_to_read(v, session) for v in page.videos],
            }
        ]
        if page.videos
        else [],
        "has_more": page.has_more,
    }


@router.get("/categories")
def ai_categories(session: Session = Depends(get_session)):
    return {"categories": recommend.list_categories(session)}

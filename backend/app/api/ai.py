"""AI status, backlog controls, and recommendation endpoints."""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..database import get_session
from ..services.ai import embeddings, recommend, worker
from ..services.ai.provider import build_status, invalidate_resolved_url, test_connection
from .videos import _to_read

router = APIRouter(prefix="/api/ai", tags=["ai"])


class AiCurrentJob(BaseModel):
    kind: str
    video_id: Optional[int] = None
    title: Optional[str] = None
    channel: Optional[str] = None
    has_thumbnail: bool = False
    model: Optional[str] = None


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


class AiTestRequest(BaseModel):
    base_url: Optional[str] = None


class AiProcessRequest(BaseModel):
    action: Literal[
        "all",
        "all_recent",
        "all_full",
        "embeds",
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
    indexed, total = embeddings.indexed_count(session)
    status = build_status(
        indexed_videos=indexed,
        total_videos=total,
        queue_depth=worker.queue_depth(),
    )
    breakdown = worker.queue_breakdown()
    current = worker.current_job_info()
    return AiStatusRead(
        **status.__dict__,
        queue_breakdown=breakdown,
        current_job=AiCurrentJob(**current) if current else None,
    )


@router.post("/test")
def ai_test(payload: AiTestRequest):
    return test_connection(payload.base_url)


@router.post("/process", response_model=AiProcessResult)
def ai_process_library(payload: AiProcessRequest = AiProcessRequest()):
    invalidate_resolved_url()
    action = payload.action
    try:
        if action == "embeds":
            result = worker.enqueue_missing_embeds()
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
        result = recommend.videos_for_category(session, category)
        sections: list[dict[str, Any]] = []
        if result.category_videos:
            sections.append(
                {
                    "title": "",
                    "kind": "category",
                    "seed_video_id": None,
                    "videos": [_to_read(v, session) for v in result.category_videos],
                }
            )
        if result.more_videos:
            sections.append(
                {
                    "title": "End of category — other recommendations",
                    "kind": "more",
                    "seed_video_id": None,
                    "videos": [_to_read(v, session) for v in result.more_videos],
                }
            )
        return {
            "categories": result.categories,
            "sections": sections,
            "has_more": False,
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

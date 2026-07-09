"""AI status, backlog controls, and recommendation endpoints."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..database import get_session
from ..services.ai import embeddings, recommend, worker
from ..services.ai.provider import build_status, invalidate_resolved_url, test_connection
from .videos import _to_read

router = APIRouter(prefix="/api/ai", tags=["ai"])


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
    current_job: Optional[str] = None


class AiTestRequest(BaseModel):
    base_url: Optional[str] = None


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
    current = worker.current_job_label()
    return AiStatusRead(
        **status.__dict__,
        queue_breakdown=breakdown,
        current_job=current,
    )


@router.post("/test")
def ai_test(payload: AiTestRequest):
    return test_connection(payload.base_url)


@router.post("/process", response_model=AiProcessResult)
def ai_process_library():
    invalidate_resolved_url()
    result = worker.enqueue_library_backlog(force=True)
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
            "hint": "Videos match this category by similarity to your library.",
        }

    sections_out = recommend.homepage_recommendations(session)
    return {
        "categories": recommend.list_categories(session),
        "sections": [
            {
                "title": "",
                "kind": s.kind,
                "seed_video_id": s.seed_video_id,
                "videos": [_to_read(v, session) for v in s.videos],
            }
            for s in sections_out
        ],
        "hint": "Based on recent watches and similarity across your library.",
    }


@router.get("/categories")
def ai_categories(session: Session = Depends(get_session)):
    return {"categories": recommend.list_categories(session)}

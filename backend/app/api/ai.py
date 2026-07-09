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


class AiTestRequest(BaseModel):
    base_url: Optional[str] = None


class AiProcessResult(BaseModel):
    enqueued: int


class RecommendationSectionRead(BaseModel):
    title: str
    seed_video_id: Optional[int] = None
    videos: list[Any]


@router.get("/status", response_model=AiStatusRead)
def ai_status(session: Session = Depends(get_session)):
    indexed, total = embeddings.indexed_count(session)
    status = build_status(
        indexed_videos=indexed,
        total_videos=total,
        queue_depth=worker.queue_depth(),
    )
    return AiStatusRead(**status.__dict__)


@router.post("/test")
def ai_test(payload: AiTestRequest):
    return test_connection(payload.base_url)


@router.post("/process", response_model=AiProcessResult)
def ai_process_library():
    invalidate_resolved_url()
    enqueued = worker.enqueue_library_backlog(force=True)
    return AiProcessResult(enqueued=enqueued)


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
        videos = recommend.videos_for_category(session, category)
        return {
            "categories": recommend.list_categories(session),
            "sections": [
                {
                    "title": category,
                    "seed_video_id": None,
                    "videos": [_to_read(v) for v in videos],
                }
            ],
        }

    sections = recommend.homepage_recommendations(session)
    return {
        "categories": recommend.list_categories(session),
        "sections": [
            {
                "title": s.title,
                "seed_video_id": s.seed_video_id,
                "videos": [_to_read(v) for v in s.videos],
            }
            for s in sections
        ],
    }


@router.get("/categories")
def ai_categories(session: Session = Depends(get_session)):
    return {"categories": recommend.list_categories(session)}

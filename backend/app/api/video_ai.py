import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..auth import StreamAuthGuard, current_user, require_permission
from ..context import get_session
from ..models import Video
from ..openapi_responses import (
    EVENT_STREAM,
    RAW,
)
from ..response_schemas import (
    OkResponse,
    VideoAiChatHistory,
)
from ..schemas import (
    VideoRead,
)
from ..services.ai.provider import format_provider_error
from ..services.auth.accounts import AuthUser
from .video_serialize import (
    to_read as _to_read,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["videos"])


@router.post(
    "/videos/{video_id}/ai/refresh-tags",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("use_ai"))],
)
def refresh_video_tags(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    try:
        from ..services.ai.worker import enqueue_video_tag_refresh

        ok = enqueue_video_tag_refresh(video_id)
        if not ok:
            raise HTTPException(status_code=400, detail="Could not queue tag refresh")
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("tag refresh failed video_id=%s", video_id, exc_info=True)
        raise HTTPException(status_code=400, detail=format_provider_error(exc)) from exc
    return _to_read(video, session, viewer=user)


@router.post(
    "/videos/{video_id}/ai/summarize",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("use_ai"))],
)
def summarize_video(
    video_id: int,
    force: bool = Query(False),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    try:
        from ..services.ai.tasks import SummarizeError, run_summarize

        run_summarize(session, video_id, force=force)
    except SummarizeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # Not str(exc): an httpx error quotes the provider URL.
        logger.warning("AI request failed video_id=%s", video_id, exc_info=True)
        raise HTTPException(status_code=502, detail=format_provider_error(exc)) from exc
    session.expire_all()
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _to_read(video, session, viewer=user, include_processing=True)


@router.post(
    "/videos/{video_id}/ai/chapters",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("use_ai"))],
)
def generate_video_chapters(
    video_id: int,
    force: bool = Query(False),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    try:
        from ..services.ai.tasks import ChaptersError, run_chapters

        run_chapters(session, video_id, force=force)
    except ChaptersError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # Not str(exc): an httpx error quotes the provider URL.
        logger.warning("AI request failed video_id=%s", video_id, exc_info=True)
        raise HTTPException(status_code=502, detail=format_provider_error(exc)) from exc
    session.expire_all()
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _to_read(video, session, viewer=user, include_processing=True)


class VideoAiChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)


@router.get(
    "/videos/{video_id}/ai/chat",
    response_model=VideoAiChatHistory,
    dependencies=[Depends(require_permission("use_ai"))],
)
def get_video_ai_chat(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    from ..services.ai import chat as ai_chat

    return {"messages": ai_chat.list_messages(session, video_id, user.id)}


@router.delete(
    "/videos/{video_id}/ai/chat",
    response_model=OkResponse,
    dependencies=[Depends(require_permission("use_ai"))],
)
def delete_video_ai_chat(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    from ..services.ai import chat as ai_chat

    ai_chat.clear_messages(session, video_id, user.id)
    return {"ok": True}


@router.post(
    "/videos/{video_id}/ai/chat",
    response_class=RAW,
    responses=EVENT_STREAM,
    dependencies=[Depends(require_permission("use_ai"))],
)
def post_video_ai_chat(
    request: Request,
    video_id: int,
    payload: VideoAiChatRequest,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    from ..services.ai import chat as ai_chat

    # Own session: request-scoped session closes before SSE finishes.
    return StreamingResponse(
        ai_chat.stream_chat_events(
            video_id,
            payload.message,
            user.id,
            StreamAuthGuard.of(request).still_valid,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

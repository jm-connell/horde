"""AI summary, chapters and chat for a streamed (not downloaded) video.

The library routes live under ``/api/videos/{id}/ai``; these take the stream's
URL instead. Results are saved per YouTube id (``services/stream_ai.py``).
"""

from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlmodel import Session
from starlette.concurrency import run_in_threadpool

from .. import config
from ..auth import StreamAuthGuard, current_user, require_permission
from ..context import get_engine, get_session
from ..errors import CodedHTTPException
from ..models import StreamAiState, as_utc, require_id
from ..openapi_responses import EVENT_STREAM, RAW
from ..response_schemas import OkResponse, VideoAiChatHistory
from ..schemas import ChapterRead, StreamAiAction, StreamAiChatRequest, StreamAiRead
from ..services import stream_ai, stream_preview
from ..services.ai.provider import format_provider_error
from ..services.ai.tasks import ChaptersError, SummarizeError
from ..services.auth.accounts import AuthUser
from ..services.url_clean import youtube_video_id
from .preview import (
    _in_ytdlp_thread,
    _require_video_url,
    fetch_preview_vtt,
    preview_extraction_error,
)

router = APIRouter(
    prefix="/api/preview/ai",
    tags=["preview"],
    dependencies=[Depends(require_permission("use_ai"))],
)
logger = logging.getLogger(__name__)


async def _youtube_id(url: str) -> tuple[str, str | None]:
    cleaned = await run_in_threadpool(_require_video_url, url)
    return cleaned, youtube_video_id(cleaned)


def _read(state: StreamAiState | None, youtube_id: str | None) -> StreamAiRead:
    if youtube_id is None:
        return StreamAiRead(supported=False)
    if state is None:
        return StreamAiRead(youtube_id=youtube_id)
    has_captions = (
        None if state.captions_vtt is None else bool(stream_ai.caption_text(state))
    )
    return StreamAiRead(
        youtube_id=youtube_id,
        summary=state.summary,
        summary_model=state.summary_model,
        summary_cost=state.summary_cost,
        chapters=[ChapterRead(**c) for c in stream_ai.chapters_of(state)],
        has_captions=has_captions,
        expires_at=as_utc(state.last_used_at)
        + timedelta(days=config.STREAM_AI_RETENTION_DAYS),
    )


def _require_supported(youtube_id: str | None) -> str:
    if youtube_id is None:
        raise CodedHTTPException(
            400, "AI for streams needs a YouTube video", "unsupported_source"
        )
    return youtube_id


async def _prepared_state(request: Request, url: str) -> tuple[str, int]:
    """Save (or refresh) the stream's row with its metadata and captions.

    Returns ``(youtube_id, row id)``. Captions are fetched once; a stream
    without English captions stores an empty track so it is not asked again.
    """
    cleaned, youtube_id = await _youtube_id(url)
    youtube_id = _require_supported(youtube_id)
    ready = await run_in_threadpool(_ready_state_id, youtube_id)
    if ready is not None:
        return youtube_id, ready
    try:
        meta = await _in_ytdlp_thread(
            request, stream_preview.extract_stream_preview_meta, cleaned
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise preview_extraction_error(exc, cleaned) from exc
    state_id, need_captions = await run_in_threadpool(_upsert, youtube_id, meta)
    if need_captions:
        vtt = ""
        tracks = meta.get("subtitles") or []
        if tracks:
            lang = str(tracks[0].get("lang") or "en")
            try:
                vtt = (await fetch_preview_vtt(request, cleaned, lang)).decode(
                    "utf-8", errors="replace"
                )
            except HTTPException as exc:
                # Retry next time: a 502 is usually a passing upstream hiccup.
                logger.info("stream AI: no captions for %s (%s)", youtube_id, exc)
                if exc.status_code != 404:
                    return youtube_id, state_id
        await run_in_threadpool(_store_captions, state_id, vtt)
    return youtube_id, state_id


def _ready_state_id(youtube_id: str) -> int | None:
    """The row id when the stream is saved with its captions (nothing to fetch).

    Opening it restarts its retention period, as a read does.
    """
    with Session(get_engine()) as session:
        state = stream_ai.find_state(session, youtube_id)
        if state is None or state.captions_vtt is None:
            return None
        stream_ai.touch(session, state)
        return require_id(state)


def _refuse_if_off(feature: str) -> None:
    refused = stream_ai.check_allowed(feature)
    if refused:
        raise CodedHTTPException(*refused)


def _upsert(youtube_id: str, meta: dict) -> tuple[int, bool]:
    """Row id, and whether its captions still have to be fetched."""
    with Session(get_engine()) as session:
        state = stream_ai.upsert_state(session, youtube_id, meta)
        return require_id(state), state.captions_vtt is None


def _store_captions(state_id: int, vtt: str) -> None:
    with Session(get_engine()) as session:
        state = session.get(StreamAiState, state_id)
        if state is not None:
            stream_ai.store_captions(session, state, vtt)


def _read_by_id(state_id: int, youtube_id: str) -> StreamAiRead:
    with Session(get_engine()) as session:
        return _read(session.get(StreamAiState, state_id), youtube_id)


def _run_ai(state_id: int, action: str, force: bool) -> None:
    with Session(get_engine()) as session:
        state = session.get(StreamAiState, state_id)
        if state is None:
            raise CodedHTTPException(404, "Video not found", "not_found")
        try:
            if action == "summary":
                stream_ai.summarize(session, state, force=force)
            else:
                stream_ai.generate_stream_chapters(session, state, force=force)
        except (SummarizeError, ChaptersError) as exc:
            raise CodedHTTPException(
                exc.status_code, str(exc), exc.code or "ai_failed"
            ) from exc
        except HTTPException:
            raise
        except Exception as exc:
            # Not str(exc): an httpx error quotes the provider URL.
            logger.warning("stream AI request failed (%s)", action, exc_info=True)
            raise CodedHTTPException(
                502, format_provider_error(exc), "ai_provider_error"
            ) from exc


def _youtube_id_of(url: str) -> str | None:
    """For the ``def`` routes (they run in a worker thread already)."""
    return youtube_video_id(_require_video_url(url))


@router.get("", response_model=StreamAiRead)
def get_stream_ai(
    url: str = Query(..., max_length=4000),
    session: Session = Depends(get_session),
):
    """Saved results for the stream (nothing is generated or fetched).

    Opening a stream that has saved results restarts their retention period.
    """
    youtube_id = _youtube_id_of(url)
    if youtube_id is None:
        return _read(None, None)
    state = stream_ai.find_state(session, youtube_id)
    if state is not None:
        stream_ai.touch(session, state)
        session.refresh(state)
    return _read(state, youtube_id)


async def _act(request: Request, payload: StreamAiAction, action: str):
    feature = "summaries" if action == "summary" else "chapters"
    await run_in_threadpool(_refuse_if_off, feature)
    youtube_id, state_id = await _prepared_state(request, payload.url)
    await run_in_threadpool(_run_ai, state_id, action, payload.force)
    return await run_in_threadpool(_read_by_id, state_id, youtube_id)


@router.post("/summarize", response_model=StreamAiRead)
async def summarize_stream(request: Request, payload: StreamAiAction):
    return await _act(request, payload, "summary")


@router.post("/chapters", response_model=StreamAiRead)
async def chapters_for_stream(request: Request, payload: StreamAiAction):
    return await _act(request, payload, "chapters")


@router.get("/chat", response_model=VideoAiChatHistory)
def get_stream_chat(
    url: str = Query(..., max_length=4000),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    youtube_id = _youtube_id_of(url)
    state = stream_ai.find_state(session, youtube_id) if youtube_id else None
    if state is None:
        return {"messages": []}
    return {"messages": stream_ai.list_messages(session, state, user.id)}


@router.delete("/chat", response_model=OkResponse)
def delete_stream_chat(
    url: str = Query(..., max_length=4000),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    youtube_id = _youtube_id_of(url)
    state = stream_ai.find_state(session, youtube_id) if youtube_id else None
    if state is not None:
        stream_ai.clear_messages(session, state, user.id)
    return {"ok": True}


@router.post("/chat", response_class=RAW, responses=EVENT_STREAM)
async def post_stream_chat(
    request: Request,
    payload: StreamAiChatRequest,
    user: AuthUser = Depends(current_user),
) -> Response:
    await run_in_threadpool(_refuse_if_off, "chat")
    youtube_id, state_id = await _prepared_state(request, payload.url)
    return StreamingResponse(
        stream_ai.stream_chat_events(
            state_id,
            youtube_id,
            payload.message,
            user.id,
            StreamAuthGuard.of(request).still_valid,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

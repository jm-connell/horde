"""Per-video AI chat: persistence, context, and streaming replies."""

from __future__ import annotations

import json
import logging
from typing import Any, Generator

from sqlmodel import Session, select

from ...database import engine
from ...models import Video, VideoAiChat, VideoAiChatMessage, utcnow
from .. import app_settings
from . import embeddings as ai_embeddings
from . import text as ai_text
from .provider import (
    OpenRouterProvider,
    get_llm_provider,
    llm_features_allowed,
    require_llm_chat_model,
    resolve_llm_model,
)
from .workload import ensure_quality_chat_model

logger = logging.getLogger(__name__)

_MAX_HISTORY = 24
_CHAT_TIMEOUT = 180.0
_NUM_PREDICT = 1024


class ChatError(Exception):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _get_or_create_thread(session: Session, video_id: int) -> VideoAiChat:
    row = session.get(VideoAiChat, video_id)
    if row is None:
        row = VideoAiChat(video_id=video_id)
        session.add(row)
        session.flush()
    return row


def list_messages(session: Session, video_id: int) -> list[dict[str, Any]]:
    rows = session.exec(
        select(VideoAiChatMessage)
        .where(VideoAiChatMessage.video_id == video_id)
        .order_by(VideoAiChatMessage.created_at.asc(), VideoAiChatMessage.id.asc())
    ).all()
    return [
        {
            "id": r.id,
            "role": r.role,
            "content": r.content,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


def clear_messages(session: Session, video_id: int) -> None:
    rows = session.exec(
        select(VideoAiChatMessage).where(VideoAiChatMessage.video_id == video_id)
    ).all()
    for row in rows:
        session.delete(row)
    thread = session.get(VideoAiChat, video_id)
    if thread is not None:
        session.delete(thread)
    session.commit()


def _history_for_prompt(
    session: Session, video_id: int
) -> list[dict[str, str]]:
    rows = session.exec(
        select(VideoAiChatMessage)
        .where(VideoAiChatMessage.video_id == video_id)
        .order_by(VideoAiChatMessage.created_at.asc(), VideoAiChatMessage.id.asc())
    ).all()
    # Drop the just-persisted latest user message — it is passed as ``prompt``.
    if rows and rows[-1].role == "user":
        rows = rows[:-1]
    trimmed = rows[-_MAX_HISTORY:]
    out: list[dict[str, str]] = []
    for row in trimmed:
        role = str(row.role or "")
        content = str(row.content or "").strip()
        if role in {"user", "assistant"} and content:
            out.append({"role": role, "content": content})
    return out


def _validate_chat_request(session: Session, video_id: int, message: str) -> Video:
    ai = app_settings.ai_settings()
    allowed, reason = llm_features_allowed()
    if not allowed:
        raise ChatError(reason or "AI is disabled", status_code=409 if ai.get("paused") else 400)
    if not ai.get("ai_chat", True):
        raise ChatError("AI video chat is disabled", status_code=400)

    text = (message or "").strip()
    if not text:
        raise ChatError("Message is empty", status_code=400)
    if len(text) > 4000:
        raise ChatError("Message is too long", status_code=400)

    video = session.get(Video, video_id)
    if video is None:
        raise ChatError("Video not found", status_code=404)
    if video.needs_review:
        raise ChatError("Video is still in review", status_code=400)

    has_meta = bool((video.title or "").strip() or (video.description or "").strip())
    has_subs = ai_text.has_subtitle_text(video)
    if not has_meta and not has_subs:
        raise ChatError(
            "Chat needs video metadata or downloaded subtitles",
            status_code=400,
        )
    return video


def stream_chat_events(video_id: int, message: str) -> Generator[str, None, None]:
    """SSE generator that owns its DB session for the full stream lifetime."""
    with Session(engine) as session:
        yield from stream_chat(session, video_id, message)


def stream_chat(
    session: Session, video_id: int, message: str
) -> Generator[str, None, None]:
    """Yield SSE event strings for a chat turn.

    Events:
    - ``data: {"type":"token","text":"..."}\n\n``
    - ``data: {"type":"done","message":{...}}\n\n``
    - ``data: {"type":"error","detail":"..."}\n\n``
    """
    try:
        video = _validate_chat_request(session, video_id, message)
    except ChatError as exc:
        yield _sse({"type": "error", "detail": str(exc), "status": exc.status_code})
        return

    user_text = message.strip()
    provider = get_llm_provider()
    if provider is None:
        yield _sse(
            {
                "type": "error",
                "detail": "No LLM available (enable OpenRouter or Ollama)",
                "status": 503,
            }
        )
        return
    if isinstance(provider, OpenRouterProvider):
        chat_model = resolve_llm_model(provider)
    else:
        chat_model = ensure_quality_chat_model()
    missing = require_llm_chat_model(provider, chat_model)
    if missing:
        yield _sse({"type": "error", "detail": missing, "status": 503})
        return

    _get_or_create_thread(session, video_id)
    user_row = VideoAiChatMessage(
        video_id=video_id,
        role="user",
        content=user_text,
        created_at=utcnow(),
    )
    session.add(user_row)
    thread = session.get(VideoAiChat, video_id)
    if thread is not None:
        thread.updated_at = utcnow()
        session.add(thread)
    session.commit()
    session.refresh(user_row)
    # Re-load video after commit (expire_on_commit) before building context.
    video = session.get(Video, video_id)
    if video is None:
        yield _sse({"type": "error", "detail": "Video not found", "status": 404})
        return

    yield _sse(
        {
            "type": "user",
            "message": {
                "id": user_row.id,
                "role": "user",
                "content": user_row.content,
                "created_at": (
                    user_row.created_at.isoformat() if user_row.created_at else None
                ),
            },
        }
    )

    context = ai_embeddings.build_chat_context(session, video, user_text)
    system = ai_text.chat_system_prompt() + "\n\n" + context
    history = _history_for_prompt(session, video_id)

    assistant_parts: list[str] = []
    try:
        for delta in provider.chat_stream(
            user_text,
            chat_model,
            system=system,
            messages=history,
            num_predict=_NUM_PREDICT,
            timeout=_CHAT_TIMEOUT,
            temperature=0.4,
        ):
            if not delta:
                continue
            assistant_parts.append(delta)
            yield _sse({"type": "token", "text": delta})
    except Exception as exc:  # noqa: BLE001
        logger.warning("chat stream failed video_id=%s: %s", video_id, exc)
        yield _sse({"type": "error", "detail": str(exc), "status": 502})
        return

    reply = "".join(assistant_parts).strip()
    if not reply:
        yield _sse(
            {
                "type": "error",
                "detail": "Model returned an empty reply",
                "status": 502,
            }
        )
        return

    assistant_row = VideoAiChatMessage(
        video_id=video_id,
        role="assistant",
        content=reply,
        created_at=utcnow(),
    )
    session.add(assistant_row)
    thread = session.get(VideoAiChat, video_id)
    if thread is not None:
        thread.updated_at = utcnow()
        session.add(thread)
    session.commit()
    session.refresh(assistant_row)

    yield _sse(
        {
            "type": "done",
            "message": {
                "id": assistant_row.id,
                "role": "assistant",
                "content": assistant_row.content,
                "created_at": (
                    assistant_row.created_at.isoformat()
                    if assistant_row.created_at
                    else None
                ),
            },
            "model": chat_model,
        }
    )


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


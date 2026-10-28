"""Per-video AI chat: persistence, context, and streaming replies."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Generator
from typing import Any, Protocol

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from ...context import get_engine
from ...models import Video, VideoAiChatMessage, utcnow
from .. import app_settings
from . import embeddings as ai_embeddings
from . import text as ai_text
from .provider import (
    format_provider_error,
    get_llm_provider,
    llm_features_allowed,
    require_llm_chat_model,
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


def list_messages(
    session: Session, video_id: int, user_id: int
) -> list[dict[str, Any]]:
    rows = session.exec(
        select(VideoAiChatMessage)
        .where(
            VideoAiChatMessage.video_id == video_id,
            VideoAiChatMessage.user_id == user_id,
        )
        .order_by(
            col(VideoAiChatMessage.created_at).asc(), col(VideoAiChatMessage.id).asc()
        )
    ).all()
    return [
        {
            "id": r.id,
            "role": r.role,
            "content": r.content,
            "cost": r.cost if r.role == "assistant" else None,
            "model": r.model if r.role == "assistant" else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


def clear_messages(session: Session, video_id: int, user_id: int) -> None:
    """Delete this user's conversation about the video (nobody else's)."""
    rows = session.exec(
        select(VideoAiChatMessage).where(
            VideoAiChatMessage.video_id == video_id,
            VideoAiChatMessage.user_id == user_id,
        )
    ).all()
    for row in rows:
        session.delete(row)
    session.commit()


def _history_for_prompt(
    session: Session, video_id: int, user_id: int
) -> list[dict[str, str]]:
    rows = session.exec(
        select(VideoAiChatMessage)
        .where(
            VideoAiChatMessage.video_id == video_id,
            VideoAiChatMessage.user_id == user_id,
        )
        .order_by(
            col(VideoAiChatMessage.created_at).asc(), col(VideoAiChatMessage.id).asc()
        )
    ).all()
    return history_from_rows(list(rows))


def history_from_rows(rows: list[Any]) -> list[dict[str, str]]:
    """Prompt history from oldest-first message rows (``role`` / ``content``)."""
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


def validate_chat_message(message: str) -> None:
    """Refuse a turn when chat is off or the message is empty or too long."""
    ai = app_settings.ai_settings()
    allowed, reason = llm_features_allowed()
    if not allowed:
        raise ChatError(
            reason or "AI is disabled", status_code=409 if ai.get("paused") else 400
        )
    if not ai.get("ai_chat", True):
        raise ChatError("AI video chat is disabled", status_code=400)

    text = (message or "").strip()
    if not text:
        raise ChatError("Message is empty", status_code=400)
    if len(text) > 4000:
        raise ChatError("Message is too long", status_code=400)


def _validate_chat_request(session: Session, video_id: int, message: str) -> Video:
    validate_chat_message(message)
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


#: ``authorized(force=...)``: whether the caller may still receive this stream
#: (throttled unless forced). See ``StreamAuthGuard.still_valid``.
Authorized = Callable[..., bool]


def stream_chat_events(
    video_id: int,
    message: str,
    user_id: int,
    authorized: Authorized | None = None,
) -> Generator[str]:
    """SSE generator that owns its DB session for the full stream lifetime."""
    with Session(get_engine()) as session:
        yield from stream_chat(session, video_id, message, user_id, authorized)


class ChatTarget(Protocol):
    """What a chat turn is about: a library video or a stream."""

    #: For log lines.
    label: str
    #: Attributed in the cost ledger (None for a stream).
    usage_video_id: int | None

    def validate(self, session: Session, message: str) -> None:
        """Raise ``ChatError`` when this turn may not run."""

    def add_message(
        self,
        session: Session,
        *,
        role: str,
        content: str,
        cost: float | None = None,
        model: str | None = None,
    ) -> Any:
        """Persist one turn and return the refreshed row (``id``, ``created_at``)."""

    def history(self, session: Session) -> list[dict[str, str]]:
        """Earlier turns for the prompt, without the just-added user message."""

    def context(self, session: Session, question: str) -> str | None:
        """System context for the reply, or None when the subject is gone."""

    def exists(self, session: Session) -> bool:
        """Whether the video (or stream) the chat is about still exists."""


class _LibraryChat:
    def __init__(self, video_id: int, user_id: int) -> None:
        self.video_id = video_id
        self.user_id = user_id
        self.label = f"video_id={video_id}"
        self.usage_video_id: int | None = video_id

    def validate(self, session: Session, message: str) -> None:
        _validate_chat_request(session, self.video_id, message)

    def add_message(
        self,
        session: Session,
        *,
        role: str,
        content: str,
        cost: float | None = None,
        model: str | None = None,
    ) -> VideoAiChatMessage:
        row = VideoAiChatMessage(
            video_id=self.video_id,
            user_id=self.user_id,
            role=role,
            content=content,
            cost=cost,
            model=model,
            created_at=utcnow(),
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row

    def history(self, session: Session) -> list[dict[str, str]]:
        return _history_for_prompt(session, self.video_id, self.user_id)

    def context(self, session: Session, question: str) -> str | None:
        # Re-load video after commit (expire_on_commit) before building context.
        video = session.get(Video, self.video_id)
        if video is None:
            return None
        return ai_embeddings.build_chat_context(session, video, question)

    def exists(self, session: Session) -> bool:
        return session.get(Video, self.video_id) is not None


def stream_chat(
    session: Session,
    video_id: int,
    message: str,
    user_id: int,
    authorized: Authorized | None = None,
) -> Generator[str]:
    """Yield SSE event strings for a chat turn about a library video."""
    yield from run_chat_turn(
        session, _LibraryChat(video_id, user_id), message, user_id, authorized
    )


def run_chat_turn(
    session: Session,
    target: ChatTarget,
    message: str,
    user_id: int,
    authorized: Authorized | None = None,
    *,
    system_prompt: str | None = None,
) -> Generator[str]:
    """Yield SSE event strings for a chat turn.

    ``system_prompt`` replaces the video-chat persona (the context still follows).

    Events:
    - ``data: {"type":"token","text":"..."}\n\n``
    - ``data: {"type":"done","message":{...}}\n\n``
    - ``data: {"type":"error","detail":"..."}\n\n``
    """
    try:
        target.validate(session, message)
    except ChatError as exc:
        yield _sse({"type": "error", "detail": str(exc), "status": exc.status_code})
        return

    user_text = message.strip()
    provider = get_llm_provider()
    if provider is None:
        yield _sse(
            {
                "type": "error",
                "detail": "No AI chat provider is reachable (Settings → AI)",
                "status": 503,
            }
        )
        return
    chat_model = ensure_quality_chat_model()
    missing = require_llm_chat_model(provider, chat_model)
    if missing:
        yield _sse({"type": "error", "detail": missing, "status": 503})
        return

    try:
        user_row = target.add_message(session, role="user", content=user_text)
    except IntegrityError:
        session.rollback()
        logger.warning("chat turn not stored (%s)", target.label, exc_info=True)
        yield _sse(_gone_event(session, target))
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

    context = target.context(session, user_text)
    if context is None:
        yield _sse(_subject_gone_event())
        return
    system = (system_prompt or ai_text.chat_system_prompt()) + "\n\n" + context
    history = target.history(session)
    session.commit()

    assistant_parts: list[str] = []
    revoked = False
    stream = provider.chat_stream(
        user_text,
        chat_model,
        system=system,
        messages=history,
        num_predict=_NUM_PREDICT,
        timeout=_CHAT_TIMEOUT,
        temperature=0.4,
        usage_kind="chat",
        video_id=target.usage_video_id,
    )
    try:
        for delta in stream:
            if not delta:
                continue
            if authorized is not None and not authorized():
                # Stop reading: closing the generator drops the upstream request.
                # The turn's cost is not booked (the provider only learns it from
                # the final usage chunk); a client disconnect loses it the same way.
                revoked = True
                yield _sse(_revoked_event())
                break
            assistant_parts.append(delta)
            yield _sse({"type": "token", "text": delta})
    except Exception as exc:
        logger.warning("chat stream failed %s", target.label, exc_info=True)
        # Not str(exc): an httpx error quotes the provider URL.
        yield _sse(
            {"type": "error", "detail": format_provider_error(exc), "status": 502}
        )
        return
    finally:
        close = getattr(stream, "close", None)
        if close is not None:
            close()

    if revoked:
        logger.warning(
            "chat stream ended: caller lost access user_id=%s %s",
            user_id,
            target.label,
        )
        return
    if authorized is not None and not authorized(force=True):
        logger.warning(
            "chat reply dropped: caller lost access user_id=%s %s",
            user_id,
            target.label,
        )
        yield _sse(_revoked_event())
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

    turn_cost = getattr(provider, "last_cost", None)
    turn_cost = float(turn_cost) if isinstance(turn_cost, (int, float)) else None

    try:
        assistant_row = target.add_message(
            session,
            role="assistant",
            content=reply,
            cost=turn_cost,
            model=(chat_model or "").strip() or None,
        )
    except IntegrityError:
        # The account (or the stream's saved state) was deleted while the model
        # answered. The provider already booked the spend in the cost ledger;
        # only the reply has nowhere to go.
        session.rollback()
        logger.warning(
            "chat reply not stored: user %s or its subject no longer exists (%s)",
            user_id,
            target.label,
            exc_info=True,
        )
        yield _sse(_gone_event(session, target))
        return

    yield _sse(
        {
            "type": "done",
            "message": {
                "id": assistant_row.id,
                "role": "assistant",
                "content": assistant_row.content,
                "cost": assistant_row.cost,
                "model": assistant_row.model,
                "created_at": (
                    assistant_row.created_at.isoformat()
                    if assistant_row.created_at
                    else None
                ),
            },
            "model": chat_model,
            "cost": assistant_row.cost,
        }
    )


def _subject_gone_event() -> dict[str, Any]:
    # A stream's chat moves to the library video when it is downloaded.
    return {
        "type": "error",
        "detail": "This video was downloaded or removed; reopen it to keep chatting",
        "status": 409,
    }


def _gone_event(session: Session, target: ChatTarget) -> dict[str, Any]:
    """After a failed insert: the subject is gone, else the account is."""
    try:
        exists = target.exists(session)
    except Exception:
        logger.warning("chat: could not check %s", target.label, exc_info=True)
        exists = True
    return _revoked_event() if exists else _subject_gone_event()


def _revoked_event() -> dict[str, Any]:
    return {"type": "error", "detail": "Your session has ended", "status": 401}


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

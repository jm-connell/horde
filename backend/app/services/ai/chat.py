"""AI chat turns: the runner Ask's video and channel turns use, and their checks."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Generator
from typing import Any, Protocol

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from ...models import Video
from .. import app_settings
from . import text as ai_text
from .provider import (
    format_provider_error,
    get_llm_provider,
    llm_features_allowed,
    require_llm_chat_model,
)
from .workload import ensure_quality_chat_model

logger = logging.getLogger(__name__)

_CHAT_TIMEOUT = 180.0
_NUM_PREDICT = 1024


class ChatError(Exception):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


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


def library_video_for_chat(session: Session, video_id: int) -> Video:
    """The library video a chat turn is about; ``ChatError`` when it cannot be asked."""
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


class ChatTarget(Protocol):
    """What a chat turn is about, and where it is saved (an Ask thread)."""

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


def run_chat_turn(
    session: Session,
    target: ChatTarget,
    message: str,
    user_id: int,
    authorized: Authorized | None = None,
    *,
    system_prompt: str | None = None,
    model: str | None = None,
    num_predict: int = _NUM_PREDICT,
) -> Generator[str]:
    """Yield SSE event strings for a chat turn.

    ``system_prompt`` replaces the video-chat persona (the context still follows);
    ``model`` replaces the chat model and ``num_predict`` the reply length cap.

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
    chat_model = model or ensure_quality_chat_model()
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
        num_predict=num_predict,
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

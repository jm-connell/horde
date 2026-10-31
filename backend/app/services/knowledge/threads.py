"""Each user's saved Ask conversations (``ask_threads`` / ``ask_messages``)."""

from __future__ import annotations

import json
from typing import Any

from sqlmodel import Session, col, select

from ...errors import CodedHTTPException
from ...models import AskMessage, AskThread, require_id, utcnow

# Earlier turns sent back to the model with a question (question and answer text).
HISTORY_TURNS = 12
_TITLE_CHARS = 120


def owned_or_404(session: Session, thread_id: int, user_id: int) -> AskThread:
    thread = session.get(AskThread, thread_id)
    if thread is None or thread.user_id != user_id:
        raise CodedHTTPException(404, "Conversation not found", "not_found")
    return thread


def start(session: Session, user_id: int, first_question: str) -> AskThread:
    title = " ".join(first_question.split())
    if len(title) > _TITLE_CHARS:
        title = title[: _TITLE_CHARS - 1].rstrip() + "…"
    thread = AskThread(user_id=user_id, title=title)
    session.add(thread)
    session.commit()
    session.refresh(thread)
    return thread


def set_scope(session: Session, thread: AskThread, scope: dict[str, Any]) -> None:
    thread.scope = json.dumps(scope)
    thread.updated_at = utcnow()
    session.add(thread)
    session.commit()


def add(
    session: Session,
    thread_id: int,
    *,
    role: str,
    content: str,
    sources: Any = None,
    cost: float | None = None,
    model: str | None = None,
) -> AskMessage:
    row = AskMessage(
        thread_id=thread_id,
        role=role,
        content=content,
        sources=json.dumps(sources, ensure_ascii=False)
        if sources is not None
        else None,
        cost=cost,
        model=model,
    )
    session.add(row)
    thread = session.get(AskThread, thread_id)
    if thread is not None:
        thread.updated_at = utcnow()
        session.add(thread)
    session.commit()
    session.refresh(row)
    return row


def messages(session: Session, thread_id: int) -> list[AskMessage]:
    return list(
        session.exec(
            select(AskMessage)
            .where(AskMessage.thread_id == thread_id)
            .order_by(col(AskMessage.id))
        ).all()
    )


def history(session: Session, thread_id: int) -> list[dict[str, str]]:
    """The last turns as ``{role, content}``, oldest first."""
    rows = messages(session, thread_id)[-HISTORY_TURNS:]
    return [{"role": r.role, "content": r.content} for r in rows]


def list_threads(
    session: Session, user_id: int, *, limit: int, offset: int
) -> list[AskThread]:
    return list(
        session.exec(
            select(AskThread)
            .where(AskThread.user_id == user_id)
            .order_by(col(AskThread.updated_at).desc(), col(AskThread.id).desc())
            .offset(offset)
            .limit(limit)
        ).all()
    )


def delete(session: Session, thread: AskThread) -> None:
    require_id(thread)
    session.delete(thread)
    session.commit()


def parse_sources(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None

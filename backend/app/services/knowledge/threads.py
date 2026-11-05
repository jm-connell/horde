"""Each user's saved Ask conversations (``ask_threads`` / ``ask_messages``)."""

from __future__ import annotations

import json
from typing import Any

from sqlmodel import Session, col, select

from ...errors import CodedHTTPException
from ...models import (
    AskMessage,
    AskThread,
    Video,
    VideoAiChatMessage,
    require_id,
    utcnow,
)
from ..url_clean import youtube_video_id

# Earlier turns sent back to the model with a question (question and answer text).
HISTORY_TURNS = 12
_TITLE_CHARS = 120


def owned_or_404(session: Session, thread_id: int, user_id: int) -> AskThread:
    thread = session.get(AskThread, thread_id)
    if thread is None or thread.user_id != user_id:
        raise CodedHTTPException(404, "Conversation not found", "not_found")
    return thread


def _title(text: str) -> str:
    title = " ".join(text.split())
    if len(title) > _TITLE_CHARS:
        title = title[: _TITLE_CHARS - 1].rstrip() + "…"
    return title


def start(session: Session, user_id: int, first_question: str) -> AskThread:
    thread = AskThread(user_id=user_id, title=_title(first_question))
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


def adopt_video_chats(session: Session, user_id: int) -> None:
    """Give chats about videos from before accounts (no owner) to ``user_id``.

    Each video's chat becomes one Ask conversation about that video, as
    revision ``0029_video_chats_to_ask`` does for owned ones, and the old rows
    go. The caller commits.
    """
    rows = session.exec(
        select(VideoAiChatMessage)
        .where(col(VideoAiChatMessage.user_id).is_(None))
        .order_by(
            col(VideoAiChatMessage.video_id),
            col(VideoAiChatMessage.created_at),
            col(VideoAiChatMessage.id),
        )
    ).all()
    by_video: dict[int, list[VideoAiChatMessage]] = {}
    for row in rows:
        by_video.setdefault(row.video_id, []).append(row)
    for video_id, chat in by_video.items():
        video = session.get(Video, video_id)
        source = (video.source_url if video else None) or ""
        title = (video.title if video else "") or ""
        ref = {
            "library_id": video_id,
            "youtube_id": youtube_video_id(source) if source else None,
            "url": None,
            "title": title,
        }
        thread = AskThread(
            user_id=user_id,
            title=_title(title) or "Video",
            scope=json.dumps({"video": ref}),
            created_at=chat[0].created_at,
            updated_at=chat[-1].created_at,
        )
        session.add(thread)
        session.flush()
        for row in chat:
            session.add(
                AskMessage(
                    thread_id=require_id(thread),
                    role=row.role,
                    content=row.content,
                    sources=json.dumps({"kind": "video", "video": ref})
                    if row.role == "assistant"
                    else None,
                    cost=row.cost,
                    model=row.model,
                    created_at=row.created_at,
                )
            )
            session.delete(row)

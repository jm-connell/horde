"""One chat for Ask about Horde and Ask channels, saved per user.

Each turn picks its source (``routing``): channels the question names, else the
channels the client says the chat is about (opened on a channel page, or the
previous answer's channels), else Ask about Horde. Both kinds are saved in the
user's thread (``threads``), so the chat panel has one history.

A channel turn retrieves numbered excerpts (``retrieval``), streams the answer
through ``ai.chat.run_chat_turn`` with a prompt that requires ``[n]`` citations,
and saves it with its references (``references``). Events, in order: ``thread``,
``scope``, ``status`` (while searching), then the chat turn's own ``user`` /
``token`` / ``done`` / ``error``, with ``references`` just before ``done``.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Generator
from typing import Any

from sqlmodel import Session, col, func, select

from ...context import current, get_engine
from ...models import (
    AskMessage,
    KbChannel,
    KbChannelStatus,
    KbChunk,
    KbVideo,
    require_id,
)
from ..ai import chat as ai_chat
from ..ai import help_chat, help_model
from ..ai.provider import get_llm_provider, llm_features_allowed, require_llm_chat_model
from ..auth.accounts import AuthUser
from . import chunking, references, retrieval, routing, threads

logger = logging.getLogger(__name__)

_NUM_PREDICT = 1400
_BUDGET = {"small": 6000, "medium": 12000, "large": 20000}
MAX_CHANNELS = {"small": 2, "medium": 4, "large": 4}

SYSTEM_PROMPT = """You answer questions about what YouTube channels say in their videos, \
using only the numbered excerpts below. They come from the videos' captions, which are \
often generated automatically and may misspell names.

Rules:
- Every sentence that says what a channel or its host said, recommends, thinks or showed \
ends with the number of the excerpt it comes from in square brackets, like [3] or [3][7]. \
Use only the numbers given. Never write times or timestamps; the app links each number \
to the exact moment.
- Use nothing but the excerpts for what a channel says. If they do not answer the \
question, say so plainly and say what they do cover.
- Name the channel when you report what it says. When several channels cover the \
question, say where they agree and where they disagree, and why each says what it says.
- When a channel's view changed over time, say so with the years (excerpts are in \
date order).
- Short exact quotes are welcome. Be concise; use short paragraphs or bullet points."""


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _event_type(event: str) -> str | None:
    try:
        kind = json.loads(event.removeprefix("data: ")).get("type")
    except ValueError:
        return None
    return kind if isinstance(kind, str) else None


def searchable_channels(session: Session) -> list[KbChannel]:
    """Channels with at least one indexed passage."""
    with_passages = select(KbChunk.kb_channel_id).distinct()
    return list(
        session.exec(
            select(KbChannel)
            .where(col(KbChannel.id).in_(with_passages))
            .order_by(col(KbChannel.channel_name))
        ).all()
    )


def pick_scope(
    session: Session, message: str, channel_ids: list[int] | None
) -> list[KbChannel]:
    """The channels this turn answers from; empty for Ask about Horde."""
    channels = searchable_channels(session)
    if routing.asks_all_channels(message):
        return channels
    named = routing.named_channels(message, channels)
    if named:
        return named
    wanted = set(channel_ids or [])
    return [c for c in channels if c.id in wanted]


def _progress_note(session: Session, channels: list[KbChannel]) -> str:
    notes = []
    for channel in channels:
        if channel.status == KbChannelStatus.ready:
            continue
        total, done = session.exec(
            select(
                func.count(col(KbVideo.id)),
                func.count(col(KbVideo.id)).filter(
                    col(KbVideo.fetch_status) != "pending"
                ),
            ).where(KbVideo.kb_channel_id == channel.id)
        ).one()
        notes.append(
            f"{channel.channel_name} is still being indexed: {done} of {total} videos so far."
        )
    return " ".join(notes)


class _ChannelChat:
    """``ai.chat.ChatTarget`` for a channel turn, saved in an Ask thread."""

    usage_video_id: int | None = None

    def __init__(
        self,
        thread_id: int,
        history: list[dict[str, str]],
        excerpts: list[retrieval.Excerpt],
        context: str,
        channels: list[KbChannel],
        extra_cost: float | None,
    ) -> None:
        self.label = f"ask thread={thread_id}"
        self.thread_id = thread_id
        self._history = history
        self._excerpts = excerpts
        self._context = context
        self._channels = [{"id": c.id, "name": c.channel_name} for c in channels]
        self._extra_cost = extra_cost
        self.references: list[references.Reference] = []

    def validate(self, session: Session, message: str) -> None:
        if len(message.strip()) > 4000:
            raise ai_chat.ChatError("Message is too long", status_code=400)

    def add_message(
        self,
        session: Session,
        *,
        role: str,
        content: str,
        cost: float | None = None,
        model: str | None = None,
    ) -> AskMessage:
        if role != "assistant":
            return threads.add(session, self.thread_id, role=role, content=content)
        lines: dict[int, list[chunking.Line]] = {}

        def lines_of(video_id: int) -> list[chunking.Line]:
            if video_id not in lines:
                video = session.get(KbVideo, video_id)
                lines[video_id] = chunking.unpack_lines(video.cues if video else None)
            return lines[video_id]

        content, self.references = references.resolve(content, self._excerpts, lines_of)
        if self._extra_cost is not None:
            cost = (cost or 0.0) + self._extra_cost
        sources = {
            "kind": "channels",
            "channels": self._channels,
            "references": [r.as_dict() for r in self.references],
        }
        return threads.add(
            session,
            self.thread_id,
            role=role,
            content=content,
            sources=sources,
            cost=cost,
            model=model,
        )

    def history(self, session: Session) -> list[dict[str, str]]:
        return self._history

    def context(self, session: Session, question: str) -> str | None:
        return self._context

    def exists(self, session: Session) -> bool:
        return True


def _canned_turn(
    session: Session, thread_id: int, message: str, reply: str, sources: dict
) -> Generator[str]:
    """A turn answered without the model (nothing to answer from)."""
    user = threads.add(session, thread_id, role="user", content=message)
    yield _sse(
        {"type": "user", "message": {"id": user.id, "role": "user", "content": message}}
    )
    row = threads.add(
        session, thread_id, role="assistant", content=reply, sources=sources
    )
    yield _sse(
        {"type": "references", "references": [], "channels": sources["channels"]}
    )
    yield _sse(
        {
            "type": "done",
            "message": {"id": row.id, "role": "assistant", "content": reply},
            "cost": None,
        }
    )


def _channel_turn(
    session: Session,
    thread_id: int,
    message: str,
    channels: list[KbChannel],
    user: AuthUser,
    authorized: ai_chat.Authorized | None,
) -> Generator[str]:
    allowed, reason = llm_features_allowed()
    if not allowed:
        yield _sse(
            {"type": "error", "detail": reason or "AI is disabled", "status": 409}
        )
        return
    provider = get_llm_provider()
    if provider is None:
        yield _sse(
            {
                "type": "error",
                "detail": "No AI chat provider is reachable",
                "status": 503,
            }
        )
        return
    model = help_model.assistant_model()
    missing = require_llm_chat_model(provider, model)
    if missing:
        yield _sse({"type": "error", "detail": missing, "status": 503})
        return
    strength = help_model.tier(model)
    channels = channels[: MAX_CHANNELS[strength]]
    names = [c.channel_name or c.channel_url for c in channels]
    history = threads.history(session, thread_id)
    yield _sse({"type": "status", "text": f"Searching {', '.join(names)}"})

    expansion = retrieval.Expansion()
    extra_cost: float | None = None
    if strength != "small":
        expansion = retrieval.expand(provider, model, message, names)
        last = getattr(provider, "last_cost", None)
        extra_cost = float(last) if isinstance(last, int | float) else None
    if authorized is not None and not authorized():
        yield _sse({"type": "revoked"})
        return
    excerpts = retrieval.retrieve(
        session,
        current().knowledge.vectors,
        channels,
        message,
        expansion,
        budget_chars=_BUDGET[strength],
    )
    scope = {"channels": [{"id": c.id, "name": c.channel_name} for c in channels]}
    if not excerpts:
        note = _progress_note(session, channels)
        reply = (
            f"I couldn't find anything about that in what {' or '.join(names)} "
            "said in the indexed videos." + (f" {note}" if note else "")
        )
        yield from _canned_turn(
            session,
            thread_id,
            message,
            reply,
            {"kind": "channels", "channels": scope["channels"], "references": []},
        )
        return
    yield _sse({"type": "status", "text": f"Reading {len(excerpts)} passages"})
    context_parts = [
        "Channels: " + ", ".join(names),
        _progress_note(session, channels),
        "Excerpts:\n\n" + retrieval.format_excerpts(excerpts),
    ]
    target = _ChannelChat(
        thread_id,
        history,
        excerpts,
        "\n\n".join(p for p in context_parts if p),
        channels,
        extra_cost,
    )
    for event in ai_chat.run_chat_turn(
        session,
        target,
        message,
        user.id,
        authorized,
        system_prompt=SYSTEM_PROMPT,
        model=model,
        num_predict=_NUM_PREDICT,
    ):
        if _event_type(event) == "done":
            yield _sse(
                {
                    "type": "references",
                    "references": [r.as_dict() for r in target.references],
                    "channels": scope["channels"],
                }
            )
        yield event


def stream_ask_events(
    user: AuthUser,
    message: str,
    *,
    thread_id: int | None,
    channel_ids: list[int] | None,
    page: str | None,
    data_consent: str,
    authorized: ai_chat.Authorized | None = None,
) -> Generator[str]:
    """SSE events for one turn (the route has checked ``thread_id`` belongs to ``user``)."""
    with Session(get_engine()) as session:
        channels = pick_scope(session, message, channel_ids)
        if thread_id is None:
            thread_id = require_id(threads.start(session, user.id, message))
        thread = threads.owned_or_404(session, thread_id, user.id)
        yield _sse({"type": "thread", "id": thread_id, "title": thread.title})
        scope = {"channels": [{"id": c.id, "name": c.channel_name} for c in channels]}
        threads.set_scope(session, thread, scope if channels else {"help": True})
        yield _sse({"type": "scope", **scope})
        if channels:
            yield from _channel_turn(
                session, thread_id, message, channels, user, authorized
            )
            return
        history = threads.history(session, thread_id)

    def store(**fields: Any) -> AskMessage:
        with Session(get_engine()) as s:
            return threads.add(s, thread_id, **fields)

    yield from help_chat.stream_help_events(
        message,
        history,
        user,
        page=page,
        data_consent=data_consent,
        authorized=authorized,
        store=store,
    )

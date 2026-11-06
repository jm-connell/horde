"""Ask: one chat that answers from Horde, from channels or from a video, saved per user.

Each turn picks its source (``pick_route``): channels the question names, else
the channels the client says the chat is about (opened on a channel page, or
the previous answer's channels), else the video the chat is about (picked, or
the watch page's) unless the question is about Horde, the user's own things or
the whole channel, else Horde (``help_chat``). When the user picked Horde as
the source (``horde_only``), it is Horde whatever the question names. Every
kind is saved in the user's thread (``threads``), so Ask has one history.

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
from dataclasses import dataclass, field, replace
from typing import Any

from sqlmodel import Session, col, func, select

from ...context import current, get_engine
from ...models import (
    AskMessage,
    AskThread,
    KbChannel,
    KbChannelStatus,
    KbChunk,
    KbVideo,
    StreamAiState,
    Video,
    require_id,
)
from .. import stream_ai
from ..ai import chat as ai_chat
from ..ai import embeddings as ai_embeddings
from ..ai import help_chat, help_data, help_model
from ..ai.provider import get_llm_provider, llm_features_allowed, require_llm_chat_model
from ..auth.accounts import AuthUser
from ..url_clean import youtube_video_id
from . import chunking, references, retrieval, routing, threads
from . import search as kb_search

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


@dataclass(frozen=True)
class VideoRef:
    """A video a turn may answer from: a library video, or a stream by its URL."""

    library_id: int | None = None
    youtube_id: str | None = None
    #: The watch URL of a stream (None for a library video).
    url: str | None = None
    title: str = ""
    #: The stream's ``stream_ai_states`` row, once prepared (streams only).
    stream_id: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "library_id": self.library_id,
            "youtube_id": self.youtube_id,
            "url": self.url,
            "title": self.title,
        }


@dataclass
class Route:
    """Where a turn is answered from: channels, a video, or (neither) Horde."""

    channels: list[KbChannel] = field(default_factory=list)
    video: VideoRef | None = None
    #: The video the user picked: the conversation's source, whatever answered.
    picked: VideoRef | None = None


def resolve_video(
    session: Session, library_id: int | None, url: str | None
) -> VideoRef | None:
    """The video the client says the chat is about, or None when it cannot be
    asked: AI or video chat off, the video gone or in review, not a YouTube URL.

    A stream that has been downloaded since is the library copy, so a
    conversation about it carries on there.
    """
    if stream_ai.check_allowed("chat") is not None:
        return None
    if library_id is not None:
        video = session.get(Video, library_id)
    else:
        youtube_id = youtube_video_id(url or "")
        if youtube_id is None:
            return None
        video = session.exec(
            select(Video).where(col(Video.youtube_id) == youtube_id)
        ).first()
        if video is None:
            state = stream_ai.find_state(session, youtube_id)
            return VideoRef(
                youtube_id=youtube_id,
                url=url,
                title=(state.title if state else "") or "",
            )
    if video is None or video.needs_review:
        return None
    return VideoRef(
        library_id=require_id(video),
        youtube_id=video.youtube_id,
        title=video.title or "",
    )


def with_stream(video: VideoRef, stream_id: int) -> VideoRef:
    """``video`` once its stream row is ready (it has the title by then)."""
    with Session(get_engine()) as session:
        state = session.get(StreamAiState, stream_id)
        title = (state.title if state else "") or video.title
    return replace(video, stream_id=stream_id, title=title)


def pick_route(
    session: Session,
    message: str,
    *,
    channel_ids: list[int] | None,
    page_channel_id: int | None = None,
    video: VideoRef | None = None,
    video_picked: bool = False,
    horde_only: bool = False,
) -> Route:
    """Where this turn is answered from.

    In order: Horde when the user picked it; every channel ("all my
    channels"); the channels the question names; the channels the chat is
    about. Then, with a video (picked, or the watch page's): Horde when the
    question names Horde or asks about the user's own things (unless it is
    about the video), the page's channel for one about the whole channel,
    Horde for one about Horde's features that is not about the video (once
    the video is picked, only a how-to: "how do I change the theme?"), else
    the video. Without one: the page's channel unless the question is about
    Horde. Else Horde.
    """
    picked = video if video_picked else None
    if horde_only:
        return Route()
    channels = searchable_channels(session)
    if routing.asks_all_channels(message):
        return Route(channels, picked=picked)
    named = routing.named_channels(message, channels)
    if named:
        return Route(named, picked=picked)
    wanted = set(channel_ids or [])
    chosen = [c for c in channels if c.id in wanted]
    if chosen:
        return Route(chosen, picked=picked)
    page = [c for c in channels if c.id == page_channel_id]
    if video is not None:
        on_video = routing.about_video(message)
        if routing.names_horde(message) or (help_data.topics(message) and not on_video):
            return Route(picked=picked)
        if page and routing.about_channel(message):
            return Route(page, picked=picked)
        if (
            routing.about_horde(message)
            and not on_video
            and (not video_picked or routing.asks_how_to(message))
        ):
            return Route(picked=picked)
        return Route(video=video, picked=picked)
    if page and not routing.about_horde(message):
        return Route(page)
    return Route()


def most_relevant(
    session: Session, channels: list[KbChannel], question: str, limit: int
) -> list[KbChannel]:
    """At most ``limit`` channels, those with the most passages matching ``question``."""
    if len(channels) <= limit:
        return channels
    hits = kb_search.search(
        session,
        kb_search.query_terms(question),
        channel_ids=[require_id(c) for c in channels],
        limit=400,
    )
    counts: dict[int, int] = {}
    for hit in hits:
        counts[hit.kb_channel_id] = counts.get(hit.kb_channel_id, 0) + 1
    ranked = sorted(channels, key=lambda c: -counts.get(c.id or 0, 0))
    return [c for c in ranked if counts.get(c.id or 0)][:limit] or ranked[:limit]


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


class _VideoChat:
    """``ai.chat.ChatTarget`` for a turn about one video, saved in an Ask thread.

    The context is what the per-video chat always used: the video's details,
    its captions (the passages that match, when it has embeddings) and its
    saved comments; a stream's details and captions.
    """

    def __init__(
        self, thread_id: int, history: list[dict[str, str]], video: VideoRef
    ) -> None:
        self.label = f"ask thread={thread_id}"
        self.thread_id = thread_id
        self.usage_video_id = video.library_id
        self._history = history
        self._video = video

    def _stream(self, session: Session) -> StreamAiState | None:
        if self._video.stream_id is None:
            return None
        return session.get(StreamAiState, self._video.stream_id)

    def validate(self, session: Session, message: str) -> None:
        ai_chat.validate_chat_message(message)
        if self._video.library_id is not None:
            ai_chat.library_video_for_chat(session, self._video.library_id)
            return
        state = self._stream(session)
        if state is None:
            raise ai_chat.ChatError("Video not found", status_code=404)
        refused = stream_ai.chat_refusal(state)
        if refused:
            raise ai_chat.ChatError(refused, status_code=400)

    def add_message(
        self,
        session: Session,
        *,
        role: str,
        content: str,
        cost: float | None = None,
        model: str | None = None,
    ) -> AskMessage:
        sources = (
            {"kind": "video", "video": self._video.as_dict()}
            if role == "assistant"
            else None
        )
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
        if self._video.library_id is not None:
            video = session.get(Video, self._video.library_id)
            if video is None:
                return None
            return ai_embeddings.build_chat_context(session, video, question)
        state = self._stream(session)
        return stream_ai.chat_context(state) if state is not None else None

    def exists(self, session: Session) -> bool:
        if self._video.library_id is not None:
            return session.get(Video, self._video.library_id) is not None
        return self._stream(session) is not None


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
    focus_yt_id: str | None = None,
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
    channels = most_relevant(session, channels, message, MAX_CHANNELS[strength])
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
        focus_yt_id=focus_yt_id,
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
    route: Route,
    page: str | None,
    data_consent: str,
    authorized: ai_chat.Authorized | None = None,
    page_video_id: str | None = None,
) -> Generator[str]:
    """SSE events for one turn (the route has checked ``thread_id`` belongs to
    ``user`` and picked ``route``; a stream video's row is ready).

    A conversation started here that ends without a message (AI off, model
    missing, an error) is deleted again, so History holds no empty ones.
    """
    started: int | None = None
    try:
        for event in _turn_events(
            user,
            message,
            thread_id=thread_id,
            route=route,
            page=page,
            data_consent=data_consent,
            authorized=authorized,
            page_video_id=page_video_id,
        ):
            if started is None and thread_id is None and _event_type(event) == "thread":
                started = json.loads(event.removeprefix("data: "))["id"]
            yield event if user.is_admin else _for_member(event)
    finally:
        if started is not None:
            _drop_if_empty(started)


def _turn_events(
    user: AuthUser,
    message: str,
    *,
    thread_id: int | None,
    route: Route,
    page: str | None,
    data_consent: str,
    authorized: ai_chat.Authorized | None,
    page_video_id: str | None,
) -> Generator[str]:
    with Session(get_engine()) as session:
        # Picked in another session: read them again in this one.
        channels = [
            c for c in (session.get(KbChannel, ch.id) for ch in route.channels) if c
        ]
        video = route.video
        about = route.picked or video
        if thread_id is None:
            # A conversation about a video is titled with it, so History tells
            # them apart ("What is this video about?" would not).
            title = (about.title if about else "") or message
            thread_id = require_id(threads.start(session, user.id, title))
        thread = threads.owned_or_404(session, thread_id, user.id)
        yield _sse({"type": "thread", "id": thread_id, "title": thread.title})
        scope = {"channels": [{"id": c.id, "name": c.channel_name} for c in channels]}
        video_dict = video.as_dict() if video and not channels else None
        saved: dict[str, Any] = (
            scope
            if channels
            else {"video": video_dict}
            if video_dict
            else {"help": True}
        )
        if route.picked is not None:
            # The picked video stays the source of the conversation.
            saved["video"] = route.picked.as_dict()
        threads.set_scope(session, thread, saved)
        yield _sse({"type": "scope", **scope, "video": video_dict})
        if video is not None and not channels:
            target = _VideoChat(thread_id, threads.history(session, thread_id), video)
            yield from ai_chat.run_chat_turn(
                session,
                target,
                message,
                user.id,
                authorized,
                model=help_model.assistant_model(),
            )
            return
        if channels:
            try:
                yield from _channel_turn(
                    session,
                    thread_id,
                    message,
                    channels,
                    user,
                    authorized,
                    focus_yt_id=page_video_id,
                )
            except Exception:
                logger.warning("Ask: channel turn failed", exc_info=True)
                session.rollback()
                yield _sse(
                    {
                        "type": "error",
                        "detail": "Answering failed; try again",
                        "status": 500,
                    }
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


#: Shown to members instead of an error that names the model or the server.
_MEMBER_AI_ERROR = "The AI is not available right now; ask the administrator"


def _for_member(event: str) -> str:
    """Members see no model names or costs (``docs/architecture/ai-pipeline.md``)."""
    kind = _event_type(event)
    if kind not in ("done", "error"):
        return event
    payload = json.loads(event.removeprefix("data: "))
    if kind == "done":
        payload.pop("model", None)
        payload.pop("cost", None)
        if isinstance(payload.get("message"), dict):
            payload["message"].pop("model", None)
            payload["message"].pop("cost", None)
    elif payload.get("status") == 503:
        payload["detail"] = _MEMBER_AI_ERROR
    return _sse(payload)


def _drop_if_empty(thread_id: int) -> None:
    with Session(get_engine()) as session:
        thread = session.get(AskThread, thread_id)
        if thread is not None and not threads.messages(session, thread_id):
            threads.delete(session, thread)

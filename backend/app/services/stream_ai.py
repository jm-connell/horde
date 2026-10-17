"""AI summary, chapters and chat for a streamed (not downloaded) video.

Results live in ``stream_ai_state`` / ``stream_ai_chat_messages``, keyed by the
YouTube id. When the video is downloaded they move onto the library video
(``adopt_for_video``); rows nobody opened for ``STREAM_AI_RETENTION_DAYS`` are
deleted (``purge_expired``). A small worker does both periodically.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, delete, select

from .. import config
from ..context import get_engine
from ..models import (
    StreamAiChatMessage,
    StreamAiState,
    Video,
    VideoAiChatMessage,
    VideoAiMeta,
    as_utc,
    require_id,
    utcnow,
)
from . import app_settings, library
from . import chapters as chapters_svc
from .ai import chat as ai_chat
from .ai import text as ai_text
from .ai.provider import llm_features_allowed
from .ai.tasks import (
    ChaptersError,
    SummarizeError,
    SummaryResult,
    generate_chapters,
    generate_summary,
)
from .workers import BackgroundWorker

logger = logging.getLogger(__name__)

# The worker adopts and purges this often; nothing about it is urgent.
SWEEP_INTERVAL_SEC = 3600
STARTUP_DELAY_SEC = 60


# --- state -------------------------------------------------------------------


def find_state(session: Session, youtube_id: str) -> StreamAiState | None:
    return session.exec(
        select(StreamAiState).where(col(StreamAiState.youtube_id) == youtube_id)
    ).first()


def touch(session: Session, state: StreamAiState) -> None:
    """Mark the stream as opened now, restarting its retention period."""
    state.last_used_at = utcnow()
    session.add(state)
    session.commit()


def upsert_state(
    session: Session, youtube_id: str, meta: dict[str, Any]
) -> StreamAiState:
    """The row for ``youtube_id``, created or refreshed from preview metadata."""
    state = find_state(session, youtube_id)
    if state is None:
        try:
            # Two first requests for one stream (Summarize and Chat at once)
            # race to insert; the loser re-reads the winner's row.
            session.add(StreamAiState(youtube_id=youtube_id))
            session.commit()
        except IntegrityError:
            session.rollback()
        state = find_state(session, youtube_id)
        if state is None:  # purged in between; vanishingly unlikely
            raise RuntimeError(f"stream AI row for {youtube_id} disappeared")
    state.source_url = str(meta.get("source_url") or state.source_url or "")
    state.title = str(meta.get("title") or state.title or "")
    state.channel = meta.get("channel") or state.channel
    state.description = meta.get("description") or state.description
    duration = meta.get("duration")
    if isinstance(duration, (int, float)):
        state.duration_sec = float(duration)
    state.last_used_at = utcnow()
    session.add(state)
    session.commit()
    session.refresh(state)
    return state


def store_captions(session: Session, state: StreamAiState, vtt: str) -> None:
    state.captions_vtt = vtt
    session.add(state)
    session.commit()


def as_video(state: StreamAiState) -> Video:
    """A transient (never saved) ``Video`` the prompt builders can read."""
    return Video(
        file_path="",
        title=state.title,
        channel=state.channel,
        description=state.description,
        duration_sec=state.duration_sec,
        source_url=state.source_url,
    )


def caption_text(state: StreamAiState) -> str:
    return ai_text.strip_vtt(state.captions_vtt or "")


def caption_cues(state: StreamAiState) -> list[tuple[float, str]]:
    return chapters_svc.parse_vtt_cues(state.captions_vtt or "")


def chapters_of(state: StreamAiState) -> list[dict]:
    return chapters_svc.parse_chapter_list(state.chapters or "[]")


# --- summary and chapters ----------------------------------------------------


def check_allowed(feature: str) -> tuple[int, str, str] | None:
    """Why the AI ``feature`` (summaries / chapters / chat) may not run now.

    ``(status, message, code)`` or None. Cheap: checked before any network work.
    """
    ai = app_settings.ai_settings()
    allowed, reason = llm_features_allowed()
    if not allowed:
        if ai.get("paused"):
            return 409, reason or "AI is paused", "ai_paused"
        return 400, reason or "AI is disabled", "ai_disabled"
    setting, label = {
        "summaries": ("ai_summaries", "AI video summaries"),
        "chapters": ("ai_chapters", "AI video chapters"),
        "chat": ("ai_chat", "AI video chat"),
    }[feature]
    if not ai.get(setting, True):
        return 400, f"{label} are disabled", "ai_disabled"
    return None


def _require_captions(
    state: StreamAiState, error: type[SummarizeError] | type[ChaptersError]
) -> None:
    if state.captions_vtt is None:
        # The caption fetch failed for a passing reason; the next try repeats it.
        raise error(
            "Could not load this video's captions; try again",
            status_code=502,
            code="captions_unavailable",
        )


def summarize(session: Session, state: StreamAiState, *, force: bool = False) -> str:
    refused = check_allowed("summaries")
    if refused:
        raise SummarizeError(refused[1], status_code=refused[0], code=refused[2])
    if not force and state.summary and state.summary.strip():
        return state.summary.strip()
    _require_captions(state, SummarizeError)
    text = caption_text(state)
    if not text.strip():
        raise SummarizeError(
            "Summaries need captions, and this video has none",
            status_code=400,
            code="no_captions",
        )
    youtube_id = state.youtube_id
    video = as_video(state)
    session.commit()
    result = generate_summary(
        video, subtitle_text=text, log_id=f"youtube_id={youtube_id}"
    )
    fresh = find_state(session, youtube_id)
    if fresh is None:
        # Downloaded while the model answered: the summary belongs to the video.
        if _save_on_library_video(session, youtube_id, summary=result):
            return result.text
        raise SummarizeError("This video's AI data was removed", status_code=409)
    fresh.summary = result.text
    fresh.summary_length = result.length
    fresh.summary_cost = result.cost
    fresh.summary_model = result.model
    fresh.last_used_at = utcnow()
    session.add(fresh)
    session.commit()
    return result.text


def _save_on_library_video(
    session: Session,
    youtube_id: str,
    *,
    summary: SummaryResult | None = None,
    chapters: list[dict] | None = None,
) -> bool:
    """Store a result on the library copy of a stream adopted mid-request."""
    video = library.find_video_by_youtube_id(session, youtube_id)
    if video is None:
        return False
    video_id = require_id(video)
    meta = session.get(VideoAiMeta, video_id) or VideoAiMeta(video_id=video_id)
    if summary is not None and not (meta.summary or "").strip():
        meta.summary = summary.text
        meta.summary_length = summary.length
        meta.summary_cost = summary.cost
        meta.summary_model = summary.model
    if chapters and not chapters_svc.ai_chapters_for(meta):
        meta.chapters = chapters_svc.dump_chapter_list(chapters)
        meta.chapters_skip_reason = None
    meta.updated_at = utcnow()
    session.add(meta)
    session.commit()
    return True


_CHAPTER_SKIPS = {
    "description_chapters": "Video description already has chapters",
    "no_subtitles": "Chapters need captions, and this video has none",
    "too_short": "Video is shorter than 3 minutes",
    "music_like": "Captions look like music or lyrics",
}


def generate_stream_chapters(
    session: Session, state: StreamAiState, *, force: bool = False
) -> list[dict]:
    refused = check_allowed("chapters")
    if refused:
        raise ChaptersError(refused[1], status_code=refused[0], code=refused[2])
    existing = chapters_of(state)
    if existing and not force:
        return existing
    video = as_video(state)
    if not chapters_svc.parse_chapters(video.description):
        _require_captions(state, ChaptersError)
    cues = caption_cues(state)
    skip = chapters_svc.skip_reason(video, None, force=force, cues=cues)
    if skip:
        raise ChaptersError(
            _CHAPTER_SKIPS.get(skip, skip.replace("_", " ")),
            status_code=400,
            code=skip,
        )
    youtube_id = state.youtube_id
    session.commit()
    cleaned = generate_chapters(video, cues, log_id=f"youtube_id={youtube_id}")
    fresh = find_state(session, youtube_id)
    if fresh is None:
        if _save_on_library_video(session, youtube_id, chapters=cleaned):
            return cleaned
        raise ChaptersError("This video's AI data was removed", status_code=409)
    fresh.chapters = chapters_svc.dump_chapter_list(cleaned)
    fresh.last_used_at = utcnow()
    session.add(fresh)
    session.commit()
    return cleaned


# --- chat --------------------------------------------------------------------


def _message_rows(
    session: Session, stream_id: int, user_id: int
) -> list[StreamAiChatMessage]:
    return list(
        session.exec(
            select(StreamAiChatMessage)
            .where(
                col(StreamAiChatMessage.stream_id) == stream_id,
                col(StreamAiChatMessage.user_id) == user_id,
            )
            .order_by(
                col(StreamAiChatMessage.created_at).asc(),
                col(StreamAiChatMessage.id).asc(),
            )
        ).all()
    )


def list_messages(
    session: Session, state: StreamAiState, user_id: int
) -> list[dict[str, Any]]:
    return [
        {
            "id": r.id,
            "role": r.role,
            "content": r.content,
            "cost": r.cost if r.role == "assistant" else None,
            "model": r.model if r.role == "assistant" else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in _message_rows(session, require_id(state), user_id)
    ]


def clear_messages(session: Session, state: StreamAiState, user_id: int) -> None:
    """Delete this user's conversation about the stream (nobody else's)."""
    session.execute(
        delete(StreamAiChatMessage).where(
            col(StreamAiChatMessage.stream_id) == require_id(state),
            col(StreamAiChatMessage.user_id) == user_id,
        )
    )
    session.commit()


class _StreamChat:
    """``ai_chat.ChatTarget`` for a stream: context is metadata plus captions."""

    usage_video_id: int | None = None

    def __init__(self, stream_id: int, youtube_id: str, user_id: int) -> None:
        self.stream_id = stream_id
        self.user_id = user_id
        self.label = f"youtube_id={youtube_id}"

    def _state(self, session: Session) -> StreamAiState | None:
        return session.get(StreamAiState, self.stream_id)

    def validate(self, session: Session, message: str) -> None:
        ai_chat.validate_chat_message(message)
        state = self._state(session)
        if state is None:
            raise ai_chat.ChatError("Video not found", status_code=404)
        has_meta = bool((state.title or "").strip() or (state.description or ""))
        if not has_meta and not caption_text(state).strip():
            raise ai_chat.ChatError(
                "Chat needs video metadata or captions", status_code=400
            )

    def add_message(
        self,
        session: Session,
        *,
        role: str,
        content: str,
        cost: float | None = None,
        model: str | None = None,
    ) -> StreamAiChatMessage:
        row = StreamAiChatMessage(
            stream_id=self.stream_id,
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

    def exists(self, session: Session) -> bool:
        return self._state(session) is not None

    def history(self, session: Session) -> list[dict[str, str]]:
        return ai_chat.history_from_rows(
            _message_rows(session, self.stream_id, self.user_id)
        )

    def context(self, session: Session, question: str) -> str | None:
        state = self._state(session)
        if state is None:
            return None
        return ai_text.format_chat_context(
            metadata=ai_text.metadata_document(as_video(state)),
            caption_chunks=ai_text.chat_captions(caption_text(state)),
            summary=state.summary,
        )


def stream_chat_events(
    stream_id: int,
    youtube_id: str,
    message: str,
    user_id: int,
    authorized: ai_chat.Authorized | None = None,
):
    """SSE generator that owns its DB session for the full stream lifetime."""
    with Session(get_engine()) as session:
        yield from ai_chat.run_chat_turn(
            session,
            _StreamChat(stream_id, youtube_id, user_id),
            message,
            user_id,
            authorized,
        )


# --- carry-over and expiry ---------------------------------------------------


def adopt_for_video(session: Session, video: Video) -> bool:
    """Move a stream's AI results onto the downloaded ``video``.

    The video's own results win: a summary or AI chapters it already has are
    kept, and the stream's copy is dropped. Chat turns are appended to each
    user's conversation about the video. Returns whether a stream row existed.
    """
    youtube_id = video.youtube_id
    if not youtube_id:
        return False
    state = find_state(session, youtube_id)
    if state is None:
        return False
    video_id = require_id(video)
    meta = session.get(VideoAiMeta, video_id)
    if meta is None:
        meta = VideoAiMeta(video_id=video_id)
    if state.summary and not (meta.summary or "").strip():
        meta.summary = state.summary
        meta.summary_length = state.summary_length
        meta.summary_cost = state.summary_cost
        meta.summary_model = state.summary_model
    if state.chapters and not chapters_svc.ai_chapters_for(meta):
        meta.chapters = state.chapters
        meta.chapters_skip_reason = None
    meta.updated_at = utcnow()
    session.add(meta)
    for row in session.exec(
        select(StreamAiChatMessage).where(
            col(StreamAiChatMessage.stream_id) == require_id(state)
        )
    ).all():
        session.add(
            VideoAiChatMessage(
                video_id=video_id,
                user_id=row.user_id,
                role=row.role,
                content=row.content,
                cost=row.cost,
                model=row.model,
                created_at=row.created_at,
            )
        )
    session.delete(state)  # chat rows go with it (ON DELETE CASCADE)
    session.commit()
    logger.info("moved stream AI results for %s onto video %s", youtube_id, video_id)
    return True


def adopt_video_id(video_id: int) -> bool:
    """``adopt_for_video`` in its own session (download finalize)."""
    with Session(get_engine()) as session:
        video = session.get(Video, video_id)
        return video is not None and adopt_for_video(session, video)


def adopt_downloaded(session: Session) -> int:
    """Adopt every stream row whose video is now in the library."""
    ids = session.exec(
        select(StreamAiState.youtube_id)
        .join(Video, col(Video.youtube_id) == col(StreamAiState.youtube_id))
        .distinct()
    ).all()
    moved = 0
    for youtube_id in ids:
        video = library.find_video_by_youtube_id(session, youtube_id)
        if video is not None and adopt_for_video(session, video):
            moved += 1
    return moved


def purge_expired(session: Session, *, now: datetime | None = None) -> int:
    """Delete stream rows nobody opened within the retention period."""
    cutoff = as_utc(now or utcnow()) - timedelta(days=config.STREAM_AI_RETENTION_DAYS)
    # One statement: loading the rows would read their stored captions too. The
    # chat rows go with them (ON DELETE CASCADE).
    result = session.execute(
        delete(StreamAiState).where(col(StreamAiState.last_used_at) < cutoff)
    )
    session.commit()
    removed = int(getattr(result, "rowcount", 0) or 0)
    if removed:
        logger.info("deleted AI results of %s expired stream(s)", removed)
    return removed


def sweep() -> None:
    with Session(get_engine()) as session:
        adopt_downloaded(session)
        purge_expired(session)


def _worker_loop(worker: BackgroundWorker) -> None:
    if worker.sleep(STARTUP_DELAY_SEC):
        return
    while not worker.stopping:
        try:
            sweep()
        except Exception:
            logger.warning("stream AI sweep failed", exc_info=True)
        if worker.sleep(SWEEP_INTERVAL_SEC):
            return


def create_worker() -> BackgroundWorker:
    return BackgroundWorker("stream-ai", _worker_loop)

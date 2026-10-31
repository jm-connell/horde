"""Embed Ask passages: one AI job (``embed_kb_channel``) per channel batch.

A job embeds up to ``BATCH_VIDEOS`` videos whose passages are not embedded with
the current embedding model, then queues the next batch. The AI worker runs these
after library work (``ai/worker._next_job``). Vectors are float16; the channel
records the model and dimension, and only videos embedded with that model are
searched, so changing the model re-embeds without mixing vector spaces. Requests
carry at most ``REQUEST_PASSAGES`` passages. A video that fails while others in
its batch succeed is marked ``failed:<model>`` and skipped until the model
changes; a batch where nothing succeeds fails the job, and the channel then waits
``RETRY_AFTER`` before another is queued.
"""

from __future__ import annotations

import logging
from datetime import timedelta

import numpy as np
from sqlalchemy import delete
from sqlmodel import Session, col, or_, select

from ...context import get_engine
from ...models import (
    AiJob,
    AiJobKind,
    AiJobStatus,
    KbChannel,
    KbChunk,
    KbChunkVector,
    KbVideo,
    require_id,
    utcnow,
)
from ..ai.provider import (
    OpenAICompatProvider,
    embeddings_configured,
    get_embed_provider,
    resolve_embed_model,
)
from . import captions

logger = logging.getLogger(__name__)

BATCH_VIDEOS = 25
# Passages per embedding request: a multi-hour stream has hundreds.
REQUEST_PASSAGES = 48
# After a failed job, a channel waits this long before another is queued.
RETRY_AFTER = timedelta(hours=6)
_FAILED_PREFIX = "failed:"
_EMBEDDABLE = (captions.FETCHED, captions.NO_CAPTIONS)


def _needing_embed(model: str):
    """Not embedded with ``model``, and not given up on with it."""
    return or_(
        col(KbVideo.embedded_model).is_(None),
        col(KbVideo.embedded_model).not_in([model, _FAILED_PREFIX + model]),
    )


def pack(vector: list[float]) -> bytes:
    return np.asarray(vector, dtype=np.float16).tobytes()


def _passage_text(channel: KbChannel, video: KbVideo, chunk: KbChunk) -> str:
    """The passage with its channel, title and year, so it keeps its context."""
    year = (video.published_at or "")[:4]
    head = " · ".join(
        p for p in (channel.channel_name or "", video.title or "", year) if p
    )
    return f"{head}\n{chunk.text}" if head else chunk.text


def embed_channel_batch(session: Session, channel_id: int) -> str | None:
    """Embed one batch of the channel's videos. Returns a skip reason or None."""
    provider = get_embed_provider()
    model = resolve_embed_model(provider)
    if provider is None or not model:
        return "no embedding model"
    channel = session.get(KbChannel, channel_id)
    if channel is None:
        return "channel removed"
    videos = session.exec(
        select(KbVideo)
        .where(
            KbVideo.kb_channel_id == channel_id,
            col(KbVideo.fetch_status).in_(_EMBEDDABLE),
            _needing_embed(model),
        )
        .order_by(col(KbVideo.position))
        .limit(BATCH_VIDEOS)
    ).all()
    video_ids = [require_id(v) for v in videos]
    done: list[int] = []
    failed: list[int] = []
    for video_id in video_ids:
        try:
            if _embed_video(session, provider, model, channel_id, video_id):
                done.append(video_id)
        except Exception:
            session.rollback()
            logger.warning("Ask: embedding video %s failed", video_id, exc_info=True)
            failed.append(video_id)
    if failed and not done:
        # Nothing worked: likely the provider, so the job fails and is retried.
        raise RuntimeError(f"embedding failed for {len(failed)} videos")
    for video_id in failed:
        # Others in the batch worked, so this video is the problem: skip it
        # until the embedding model changes.
        video = session.get(KbVideo, video_id)
        if video is not None:
            video.embedded_model = _FAILED_PREFIX + model
            session.add(video)
    session.commit()
    if _has_work(session, channel_id, model):
        _enqueue(channel_id, force=True)
    return None


def _embed_video(
    session: Session,
    provider: OpenAICompatProvider,
    model: str,
    channel_id: int,
    video_id: int,
) -> bool:
    """Embed one video's passages. False when it or its channel is gone."""
    video = session.get(KbVideo, video_id)
    channel = session.get(KbChannel, channel_id)
    if video is None or channel is None:
        return False
    chunks = session.exec(
        select(KbChunk).where(KbChunk.kb_video_id == video_id).order_by(col(KbChunk.id))
    ).all()
    texts = [_passage_text(channel, video, c) for c in chunks]
    chunk_ids = [require_id(c) for c in chunks]
    # Nothing may hold the SQLite write lock across the HTTP call (the cost
    # ledger writes on another session).
    session.commit()
    vectors: list[list[float]] = []
    for i in range(0, len(texts), REQUEST_PASSAGES):
        vectors += provider.embed_many(
            texts[i : i + REQUEST_PASSAGES], model, usage_kind="ask_embed"
        )
    video = session.get(KbVideo, video_id)
    channel = session.get(KbChannel, channel_id)
    if video is None or channel is None:
        return False
    session.execute(
        delete(KbChunkVector).where(col(KbChunkVector.chunk_id).in_(chunk_ids))
    )
    for chunk_id, vector in zip(chunk_ids, vectors, strict=True):
        session.add(KbChunkVector(chunk_id=chunk_id, vector=pack(vector)))
    if vectors and (
        channel.embed_model != model or channel.embed_dim != len(vectors[0])
    ):
        channel.embed_model = model
        channel.embed_dim = len(vectors[0])
        session.add(channel)
    video.embedded_model = model
    session.add(video)
    session.commit()
    return True


def _has_work(session: Session, channel_id: int, model: str) -> bool:
    return (
        session.exec(
            select(KbVideo.id)
            .where(
                KbVideo.kb_channel_id == channel_id,
                col(KbVideo.fetch_status).in_(_EMBEDDABLE),
                _needing_embed(model),
            )
            .limit(1)
        ).first()
        is not None
    )


def _enqueue(channel_id: int, *, force: bool = False) -> None:
    from ..ai.worker import enqueue_job

    enqueue_job(AiJobKind.embed_kb_channel, kb_channel_id=channel_id, force=force)


def ensure_jobs() -> int:
    """Queue an embedding job for every channel with passages left to embed."""
    if not embeddings_configured():
        return 0
    model = resolve_embed_model()
    if not model:
        return 0
    queued = 0
    with Session(get_engine()) as session:
        recent_failures = set(
            session.exec(
                select(AiJob.kb_channel_id).where(
                    AiJob.kind == AiJobKind.embed_kb_channel,
                    AiJob.status == AiJobStatus.error,
                    col(AiJob.updated_at) > utcnow() - RETRY_AFTER,
                )
            ).all()
        )
        for channel_id in session.exec(select(KbChannel.id)).all():
            if channel_id is None or channel_id in recent_failures:
                continue
            if _has_work(session, channel_id, model):
                _enqueue(channel_id)
                queued += 1
    return queued

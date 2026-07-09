"""Background AI job queue (single-flight worker)."""

from __future__ import annotations

import logging
import threading
import time
from datetime import timedelta
from typing import Optional

from sqlmodel import Session, select

from ...database import engine
from ...models import AiJob, AiJobKind, AiJobStatus, Video, VideoAiMeta, utcnow
from .. import app_settings
from . import embeddings, tasks
from .provider import get_provider

logger = logging.getLogger(__name__)

_stop = threading.Event()
_thread: Optional[threading.Thread] = None
_timer_thread: Optional[threading.Thread] = None
_wake = threading.Event()


def _active_job_exists(
    session: Session, kind: AiJobKind, video_id: Optional[int]
) -> bool:
    statement = select(AiJob).where(
        AiJob.kind == kind,
        AiJob.status.in_([AiJobStatus.queued, AiJobStatus.running]),  # type: ignore[attr-defined]
    )
    if video_id is None:
        statement = statement.where(AiJob.video_id.is_(None))  # type: ignore[attr-defined]
    else:
        statement = statement.where(AiJob.video_id == video_id)
    return session.exec(statement).first() is not None


def enqueue_job(
    kind: AiJobKind,
    video_id: Optional[int] = None,
    *,
    force: bool = False,
) -> Optional[int]:
    with Session(engine) as session:
        if not force and _active_job_exists(session, kind, video_id):
            return None
        job = AiJob(
            kind=kind,
            video_id=video_id,
            status=AiJobStatus.queued,
            run_after=utcnow(),
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id
    _wake.set()
    return job_id


def enqueue_for_video(
    video_id: int,
    *,
    include_tags: bool = True,
    force: bool = False,
) -> None:
    """Queue embed (+ optional tag enrich) for a video per schedule settings."""
    ai = app_settings.ai_settings()
    if not ai.get("enabled", True) or ai.get("paused"):
        return
    schedule = str(ai.get("schedule") or "on_download")
    # Automatic per-video enqueue only in on_download mode (timer uses sweeps).
    if schedule != "on_download" and not force:
        return
    # Still enqueue when Ollama is temporarily down; the worker retries later.
    enqueue_job(AiJobKind.embed_video, video_id, force=force)
    if include_tags and ai.get("enrich_tags", True):
        enqueue_job(AiJobKind.enrich_tags, video_id, force=force)


def enqueue_library_backlog(*, force: bool = True) -> int:
    """Enqueue missing embeds/tags for the whole library. Returns jobs created."""
    del force  # reserved for future "reprocess all" behavior
    created = 0
    with Session(engine) as session:
        need = embeddings.videos_needing_embed(session, limit=2000)
    for video_id in need:
        if enqueue_job(AiJobKind.embed_video, video_id, force=False) is not None:
            created += 1

    ai = app_settings.ai_settings()
    if ai.get("enrich_tags", True):
        with Session(engine) as session:
            videos = session.exec(
                select(Video).where(Video.needs_review == False)  # noqa: E712
            ).all()
            pending_tag_ids: list[int] = []
            for video in videos:
                if video.id is None:
                    continue
                meta = session.get(VideoAiMeta, video.id)
                if meta is not None and (meta.tags_locked or meta.tags_enriched_at):
                    continue
                pending_tag_ids.append(video.id)
        for video_id in pending_tag_ids:
            if enqueue_job(AiJobKind.enrich_tags, video_id, force=False) is not None:
                created += 1

    if enqueue_job(AiJobKind.refresh_categories, None, force=False) is not None:
        created += 1
    return created


def queue_depth() -> int:
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(
                AiJob.status.in_([AiJobStatus.queued, AiJobStatus.running])  # type: ignore[attr-defined]
            )
        ).all()
        return len(rows)


def _next_job(session: Session) -> Optional[AiJob]:
    now = utcnow()
    return session.exec(
        select(AiJob)
        .where(AiJob.status == AiJobStatus.queued)
        .where((AiJob.run_after.is_(None)) | (AiJob.run_after <= now))  # type: ignore[attr-defined]
        .order_by(AiJob.created_at.asc())
        .limit(1)
    ).first()


def _process_one() -> bool:
    ai = app_settings.ai_settings()
    if not ai.get("enabled", True) or ai.get("paused"):
        return False
    if get_provider() is None:
        return False

    with Session(engine) as session:
        job = _next_job(session)
        if job is None:
            return False
        job.status = AiJobStatus.running
        job.attempts += 1
        job.updated_at = utcnow()
        session.add(job)
        session.commit()
        job_id = job.id
        kind = job.kind
        video_id = job.video_id

    try:
        with Session(engine) as session:
            tasks.dispatch(session, kind, video_id)
        with Session(engine) as session:
            job = session.get(AiJob, job_id)
            if job is not None:
                job.status = AiJobStatus.completed
                job.error = None
                job.updated_at = utcnow()
                session.add(job)
                session.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI job %s failed: %s", job_id, exc)
        with Session(engine) as session:
            job = session.get(AiJob, job_id)
            if job is not None:
                job.error = str(exc)[:500]
                if job.attempts >= 3:
                    job.status = AiJobStatus.error
                else:
                    job.status = AiJobStatus.queued
                    job.run_after = utcnow() + timedelta(minutes=2 * job.attempts)
                job.updated_at = utcnow()
                session.add(job)
                session.commit()
    return True


def _worker_loop() -> None:
    while not _stop.is_set():
        try:
            worked = _process_one()
        except Exception:  # noqa: BLE001
            logger.exception("AI worker loop error")
            worked = False
        if worked:
            continue
        _wake.wait(timeout=2.0)
        _wake.clear()


def _timer_loop() -> None:
    while not _stop.is_set():
        try:
            ai = app_settings.ai_settings()
            hours = float(ai.get("timer_hours") or 6)
            hours = max(0.25, min(hours, 168.0))
            if (
                ai.get("enabled", True)
                and not ai.get("paused")
                and str(ai.get("schedule") or "") == "timer"
            ):
                enqueue_library_backlog(force=False)
                enqueue_job(AiJobKind.refresh_categories, None, force=False)
            deadline = time.time() + hours * 3600
            while time.time() < deadline and not _stop.is_set():
                time.sleep(5)
        except Exception:  # noqa: BLE001
            logger.exception("AI timer loop error")
            time.sleep(30)


def start_ai_worker() -> None:
    global _thread, _timer_thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_worker_loop, name="horde-ai-worker", daemon=True)
    _thread.start()
    _timer_thread = threading.Thread(
        target=_timer_loop, name="horde-ai-timer", daemon=True
    )
    _timer_thread.start()


def stop_ai_worker() -> None:
    _stop.set()
    _wake.set()


def wake_worker() -> None:
    _wake.set()

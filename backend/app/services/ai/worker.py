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


def enqueue_missing_embeds(*, limit: int = 2000) -> dict:
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    with Session(engine) as session:
        need = embeddings.videos_needing_embed(session, limit=limit)
    for video_id in need:
        if enqueue_job(AiJobKind.embed_video, video_id, force=False) is not None:
            breakdown["embed"] += 1
    return _result(breakdown, empty="No missing embeds")


def enqueue_missing_tags(*, limit: int = 2000) -> dict:
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    ai = app_settings.ai_settings()
    if not ai.get("enrich_tags", True):
        return _result(breakdown, empty="Tag enrichment is disabled")
    pending: list[int] = []
    with Session(engine) as session:
        videos = session.exec(
            select(Video).where(Video.needs_review == False)  # noqa: E712
        ).all()
        for video in videos:
            if video.id is None:
                continue
            meta = session.get(VideoAiMeta, video.id)
            if meta is not None and (meta.tags_locked or meta.tags_enriched_at):
                continue
            pending.append(video.id)
            if len(pending) >= limit:
                break
    for video_id in pending:
        if enqueue_job(AiJobKind.enrich_tags, video_id, force=False) is not None:
            breakdown["tags"] += 1
    return _result(breakdown, empty="No videos missing AI tags")


def enqueue_full_tag_refresh(*, limit: int = 2000) -> dict:
    """Re-queue tag enrich for unlocked videos (clears tags_enriched_at)."""
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    ai = app_settings.ai_settings()
    if not ai.get("enrich_tags", True):
        return _result(breakdown, empty="Tag enrichment is disabled")
    ids: list[int] = []
    with Session(engine) as session:
        videos = session.exec(
            select(Video).where(Video.needs_review == False)  # noqa: E712
        ).all()
        for video in videos:
            if video.id is None:
                continue
            meta = session.get(VideoAiMeta, video.id)
            if meta is not None and meta.tags_locked:
                continue
            if meta is None:
                meta = VideoAiMeta(video_id=video.id)
            meta.tags_enriched_at = None
            meta.updated_at = utcnow()
            session.add(meta)
            ids.append(video.id)
            if len(ids) >= limit:
                break
        session.commit()
    for video_id in ids:
        if enqueue_job(AiJobKind.enrich_tags, video_id, force=True) is not None:
            breakdown["tags"] += 1
    return _result(breakdown, empty="No unlocked videos to refresh")


def enqueue_refresh_categories(*, force: bool = True) -> dict:
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    if enqueue_job(AiJobKind.refresh_categories, None, force=force) is not None:
        breakdown["categories"] += 1
    return _result(breakdown, empty="Category refresh already queued")


def enqueue_library_backlog(*, force: bool = True) -> dict:
    """Default process: missing embeds + missing tags + categories."""
    del force
    a = enqueue_missing_embeds()
    b = enqueue_missing_tags()
    c = enqueue_refresh_categories(force=True)
    breakdown = {
        "embed": a["breakdown"]["embed"],
        "tags": b["breakdown"]["tags"],
        "categories": c["breakdown"]["categories"],
    }
    return _result(breakdown, empty="Nothing new to process (library already indexed)")


def enqueue_video_tag_refresh(video_id: int) -> bool:
    with Session(engine) as session:
        video = session.get(Video, video_id)
        if video is None or video.needs_review:
            return False
        meta = session.get(VideoAiMeta, video_id)
        if meta is None:
            meta = VideoAiMeta(video_id=video_id)
        meta.tags_locked = False
        meta.tags_enriched_at = None
        meta.updated_at = utcnow()
        session.add(meta)
        session.commit()
    return enqueue_job(AiJobKind.enrich_tags, video_id, force=True) is not None


def _result(breakdown: dict[str, int], *, empty: str) -> dict:
    enqueued = sum(breakdown.values())
    parts: list[str] = []
    if breakdown.get("embed"):
        parts.append(f"{breakdown['embed']} embed")
    if breakdown.get("tags"):
        parts.append(f"{breakdown['tags']} tag enrich")
    if breakdown.get("categories"):
        parts.append(f"{breakdown['categories']} category refresh")
    detail = ", ".join(parts) if parts else empty
    return {"enqueued": enqueued, "breakdown": breakdown, "detail": detail}


def queue_depth() -> int:
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(
                AiJob.status.in_([AiJobStatus.queued, AiJobStatus.running])  # type: ignore[attr-defined]
            )
        ).all()
        return len(rows)


def queue_breakdown() -> dict[str, int]:
    counts: dict[str, int] = {
        "embed_video": 0,
        "enrich_tags": 0,
        "refresh_categories": 0,
        "score_duplicates": 0,
        "running": 0,
    }
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(
                AiJob.status.in_([AiJobStatus.queued, AiJobStatus.running])  # type: ignore[attr-defined]
            )
        ).all()
        for job in rows:
            key = job.kind.value if hasattr(job.kind, "value") else str(job.kind)
            counts[key] = counts.get(key, 0) + 1
            if job.status == AiJobStatus.running:
                counts["running"] += 1
    return counts


def current_job_info() -> Optional[dict]:
    with Session(engine) as session:
        job = session.exec(
            select(AiJob)
            .where(AiJob.status == AiJobStatus.running)
            .order_by(AiJob.updated_at.desc())
            .limit(1)
        ).first()
        if job is None:
            return None
        kind = job.kind.value if hasattr(job.kind, "value") else str(job.kind)
        info: dict = {
            "kind": kind,
            "video_id": job.video_id,
            "title": None,
            "channel": None,
            "has_thumbnail": False,
        }
        if job.video_id:
            video = session.get(Video, job.video_id)
            if video is not None:
                info["title"] = video.title
                info["channel"] = video.channel
                info["has_thumbnail"] = bool(video.thumbnail_path)
        return info


def current_job_label() -> Optional[str]:
    info = current_job_info()
    if info is None:
        return None
    if info.get("title"):
        return f"{info['kind']}: {info['title']}"
    if info.get("video_id"):
        return f"{info['kind']} (video {info['video_id']})"
    return str(info["kind"])


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


def _maybe_run_daily() -> None:
    """Run backlog once per local calendar day at schedule_time (HH:MM)."""
    from datetime import datetime

    ai = app_settings.ai_settings()
    if not ai.get("enabled", True) or ai.get("paused"):
        return
    if str(ai.get("schedule") or "") != "set_time":
        return
    raw = str(ai.get("schedule_time") or "03:00").strip()
    try:
        hour_s, minute_s = raw.split(":", 1)
        hour, minute = int(hour_s), int(minute_s)
    except ValueError:
        hour, minute = 3, 0
    now = datetime.now().astimezone()
    today = now.strftime("%Y-%m-%d")
    if str(ai.get("last_daily_run") or "") == today:
        return
    if now.hour > hour or (now.hour == hour and now.minute >= minute):
        enqueue_library_backlog(force=False)
        app_settings.save({"ai": {"last_daily_run": today}})


def _timer_loop() -> None:
    while not _stop.is_set():
        try:
            ai = app_settings.ai_settings()
            schedule = str(ai.get("schedule") or "")
            if ai.get("enabled", True) and not ai.get("paused"):
                if schedule == "timer":
                    hours = float(ai.get("timer_hours") or 6)
                    hours = max(0.25, min(hours, 168.0))
                    enqueue_library_backlog(force=False)
                    enqueue_job(AiJobKind.refresh_categories, None, force=False)
                    deadline = time.time() + hours * 3600
                    while time.time() < deadline and not _stop.is_set():
                        time.sleep(5)
                    continue
                if schedule == "set_time":
                    _maybe_run_daily()
            # Poll frequently for set_time / schedule changes
            for _ in range(12):
                if _stop.is_set():
                    break
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

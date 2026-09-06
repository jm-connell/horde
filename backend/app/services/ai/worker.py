"""Background AI job queue (single-flight worker)."""

from __future__ import annotations

import logging
import threading
import time
from datetime import timedelta
from typing import Optional

from sqlmodel import Session, select

from ...database import engine
from ...models import AiJob, AiJobKind, AiJobStatus, Video, VideoAiMeta, as_utc, utcnow
from .. import app_settings
from . import embeddings, tasks, text as ai_text
from .provider import (
    get_embed_provider,
    get_llm_provider,
    openrouter_configured,
    openrouter_owns_embeddings,
)

logger = logging.getLogger(__name__)

_stop = threading.Event()
_thread: Optional[threading.Thread] = None
_timer_thread: Optional[threading.Thread] = None
_wake = threading.Event()
_blocked_reason: Optional[str] = None
_WAITING_NOTE_PREFIX = "waiting: "
_WAITING_STAMP_AGE_SEC = 120


def _active_job_exists(
    session: Session,
    kind: AiJobKind,
    video_id: Optional[int],
    catalog_video_id: Optional[int] = None,
) -> bool:
    statement = select(AiJob).where(
        AiJob.kind == kind,
        AiJob.status.in_([AiJobStatus.queued, AiJobStatus.running]),  # type: ignore[attr-defined]
    )
    if catalog_video_id is not None:
        statement = statement.where(AiJob.catalog_video_id == catalog_video_id)
    elif video_id is None:
        statement = statement.where(AiJob.video_id.is_(None))  # type: ignore[attr-defined]
        statement = statement.where(AiJob.catalog_video_id.is_(None))  # type: ignore[attr-defined]
    else:
        statement = statement.where(AiJob.video_id == video_id)
    return session.exec(statement).first() is not None


def enqueue_job(
    kind: AiJobKind,
    video_id: Optional[int] = None,
    *,
    catalog_video_id: Optional[int] = None,
    force: bool = False,
) -> Optional[int]:
    with Session(engine) as session:
        if not force and _active_job_exists(
            session, kind, video_id, catalog_video_id=catalog_video_id
        ):
            return None
        job = AiJob(
            kind=kind,
            video_id=video_id,
            catalog_video_id=catalog_video_id,
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
    """Queue embed (+ optional tag enrich, summary, and chapters) for a video per schedule settings."""
    ai = app_settings.ai_settings()
    if ai.get("paused"):
        return
    ollama_on = bool(ai.get("enabled", True))
    or_on = openrouter_configured()
    if not ollama_on and not or_on:
        return
    schedule = str(ai.get("schedule") or "on_download")
    # Automatic per-video enqueue only in on_download mode (timer uses sweeps).
    if schedule != "on_download" and not force:
        return
    # Enqueue embeds only when a backend can eventually serve them (Ollama
    # enabled, or OpenRouter scope=all). Temporary unreachability is fine —
    # the worker waits with blocked_reason instead of burning attempts.
    can_embed = ollama_on or openrouter_owns_embeddings()
    if can_embed:
        enqueue_job(AiJobKind.embed_video, video_id, force=force)
    if include_tags and ai.get("enrich_tags", True) and (ollama_on or or_on):
        enqueue_job(AiJobKind.enrich_tags, video_id, force=force)
    if ai.get("ai_summaries", True) and (ollama_on or or_on):
        should_summarize = False
        with Session(engine) as session:
            video = session.get(Video, video_id)
            if video is not None and ai_text.has_subtitle_text(video):
                meta = session.get(VideoAiMeta, video_id)
                has_summary = bool(
                    meta is not None
                    and meta.summary
                    and str(meta.summary).strip()
                )
                should_summarize = not has_summary
        if should_summarize:
            enqueue_job(AiJobKind.summarize, video_id, force=force)
    chapters_mode = str(ai.get("ai_chapters_mode") or "on_download")
    if (
        ai.get("ai_chapters", True)
        and chapters_mode == "on_download"
        and (ollama_on or or_on)
    ):
        should_chapters = False
        with Session(engine) as session:
            video = session.get(Video, video_id)
            if video is not None:
                from ..chapters import skip_reason as chapters_skip_reason

                meta = session.get(VideoAiMeta, video_id)
                should_chapters = chapters_skip_reason(video, meta, force=False) is None
        if should_chapters:
            enqueue_job(AiJobKind.chapters, video_id, force=force)


def _runtime_limits() -> tuple[int, int]:
    from . import workload as ai_workload

    ai = app_settings.ai_settings()
    runtime = ai_workload.resolve_runtime(ai.get("workload_profile"))
    return runtime.enqueue_embed_limit, runtime.enqueue_tag_limit


def _failed_video_ids(session: Session, kind: AiJobKind) -> set[int]:
    rows = session.exec(
        select(AiJob.video_id).where(
            AiJob.kind == kind,
            AiJob.status == AiJobStatus.error,
            AiJob.video_id.is_not(None),  # type: ignore[attr-defined]
        )
    ).all()
    return {vid for vid in rows if vid is not None}


def enqueue_missing_embeds(
    *,
    limit: Optional[int] = None,
    skip_failed: bool = False,
    skip_empty_document: bool = False,
) -> dict:
    """Queue embeds for videos needing index; loops until drained or cap iterations."""
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    ai = app_settings.ai_settings()
    if not (bool(ai.get("enabled", True)) or openrouter_owns_embeddings()):
        return _result(
            breakdown,
            empty="No embed provider configured (enable Ollama or OpenRouter All)",
        )
    batch_limit, _ = _runtime_limits()
    if limit is not None:
        batch_limit = limit
    # Multiple passes so large libraries don't stop after one batch.
    for _ in range(50):
        with Session(engine) as session:
            exclude = (
                _failed_video_ids(session, AiJobKind.embed_video)
                if skip_failed
                else set()
            )
            need = embeddings.videos_needing_embed(
                session,
                limit=batch_limit,
                exclude_ids=exclude,
                skip_empty_document=skip_empty_document,
            )
        if not need:
            break
        added = 0
        for video_id in need:
            if enqueue_job(AiJobKind.embed_video, video_id, force=False) is not None:
                breakdown["embed"] += 1
                added += 1
        if added == 0 or len(need) < batch_limit:
            break
    return _result(breakdown, empty="No missing embeds")


def maybe_enqueue_index_catchup() -> dict:
    """Queue missing search indexes under the default on-download schedule.

    Per-video enqueue only runs when a download (or review) finishes, so
    imported/scanned library videos and missed jobs would otherwise sit
    unindexed forever with an idle GPU queue. Timer / set-time already sweep;
    on_request stays manual.
    """
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    ai = app_settings.ai_settings()
    if ai.get("paused"):
        return _result(breakdown, empty="AI queue is paused")
    if str(ai.get("schedule") or "on_download") != "on_download":
        return _result(breakdown, empty="Schedule does not auto-index")
    return enqueue_missing_embeds(skip_failed=True, skip_empty_document=True)


def enqueue_reindex_embeds(*, limit: Optional[int] = None) -> dict:
    """Queue embeds for missing, stale, or wrong-model indexes (e.g. after model change)."""
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    ai = app_settings.ai_settings()
    if not (bool(ai.get("enabled", True)) or openrouter_owns_embeddings()):
        return _result(
            breakdown,
            empty="No embed provider configured (enable Ollama or OpenRouter All)",
        )
    batch_limit, _ = _runtime_limits()
    if limit is not None:
        batch_limit = limit
    for _ in range(50):
        with Session(engine) as session:
            need = embeddings.videos_needing_embed(session, limit=batch_limit)
            # Clear stale embed_error so retry/reindex starts clean.
            for video_id in need:
                meta = session.get(VideoAiMeta, video_id)
                if meta is not None and meta.embed_error:
                    meta.embed_error = None
                    meta.embed_status = "pending"
                    meta.updated_at = utcnow()
                    session.add(meta)
            session.commit()
        if not need:
            break
        added = 0
        for video_id in need:
            if enqueue_job(AiJobKind.embed_video, video_id, force=True) is not None:
                breakdown["embed"] += 1
                added += 1
        if added == 0 or len(need) < batch_limit:
            break
    if breakdown["embed"] > 0:
        app_settings.save({"ai": {"pending_category_refresh": True}})
    return _result(
        breakdown,
        empty="Search indexes already match the current embed model",
    )


def enqueue_missing_tags(*, limit: Optional[int] = None) -> dict:
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    ai = app_settings.ai_settings()
    if not ai.get("enrich_tags", True):
        return _result(breakdown, empty="Tag enrichment is disabled")
    _, tag_limit = _runtime_limits()
    if limit is not None:
        tag_limit = limit
    rescan_days = app_settings.clamp_tag_rescan_days(ai.get("tag_rescan_days"))
    now = utcnow()
    cutoff = now - timedelta(days=rescan_days)
    # (priority, enriched_at_or_min, video_id) — missing first, then oldest stale.
    candidates: list[tuple[int, object, int]] = []
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
            enriched_at = (
                as_utc(meta.tags_enriched_at) if meta is not None else None
            )
            if enriched_at is None:
                candidates.append((0, now, video.id))
            elif enriched_at < cutoff:
                candidates.append((1, enriched_at, video.id))
    candidates.sort(key=lambda row: (row[0], row[1]))
    pending = [vid for _, _, vid in candidates[:tag_limit]]
    for video_id in pending:
        if enqueue_job(AiJobKind.enrich_tags, video_id, force=False) is not None:
            breakdown["tags"] += 1
    return _result(breakdown, empty="No videos needing AI tag review")


def enqueue_full_tag_refresh(*, limit: Optional[int] = None) -> dict:
    """Re-queue tag enrich for unlocked videos (clears tags_enriched_at)."""
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    ai = app_settings.ai_settings()
    if not ai.get("enrich_tags", True):
        return _result(breakdown, empty="Tag enrichment is disabled")
    _, tag_limit = _runtime_limits()
    if limit is not None:
        tag_limit = limit
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
            if len(ids) >= tag_limit:
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
    """Default / full process: missing embeds + missing tags + categories."""
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


def enqueue_all_recent(*, days: int = 30, limit: int = 2000) -> dict:
    """Missing embeds/tags for videos watched or added recently, plus categories."""
    from sqlalchemy import or_

    cutoff = utcnow() - timedelta(days=days)
    breakdown = {"embed": 0, "tags": 0, "categories": 0}
    ai = app_settings.ai_settings()
    enrich = bool(ai.get("enrich_tags", True))

    need_embed: list[int] = []
    need_tags: list[int] = []
    with Session(engine) as session:
        recent_ids = list(
            session.exec(
                select(Video.id).where(
                    Video.needs_review == False,  # noqa: E712
                    or_(
                        Video.added_at >= cutoff,
                        Video.last_watched_at >= cutoff,
                    ),
                )
            ).all()
        )
        recent_ids = [vid for vid in recent_ids if vid is not None]

        need_embed_all = set(embeddings.videos_needing_embed(session, limit=limit * 2))
        for vid in recent_ids:
            if vid in need_embed_all:
                need_embed.append(vid)
                if len(need_embed) >= limit:
                    break

        if enrich:
            rescan_days = app_settings.clamp_tag_rescan_days(ai.get("tag_rescan_days"))
            now = utcnow()
            tag_cutoff = now - timedelta(days=rescan_days)
            tag_candidates: list[tuple[int, object, int]] = []
            for vid in recent_ids:
                meta = session.get(VideoAiMeta, vid)
                if meta is not None and meta.tags_locked:
                    continue
                enriched_at = (
                    as_utc(meta.tags_enriched_at) if meta is not None else None
                )
                if enriched_at is None:
                    tag_candidates.append((0, now, vid))
                elif enriched_at < tag_cutoff:
                    tag_candidates.append((1, enriched_at, vid))
            tag_candidates.sort(key=lambda row: (row[0], row[1]))
            need_tags = [vid for _, _, vid in tag_candidates[:limit]]

    for video_id in need_embed:
        if enqueue_job(AiJobKind.embed_video, video_id, force=False) is not None:
            breakdown["embed"] += 1
    for video_id in need_tags:
        if enqueue_job(AiJobKind.enrich_tags, video_id, force=False) is not None:
            breakdown["tags"] += 1
    cats = enqueue_refresh_categories(force=True)
    breakdown["categories"] = cats["breakdown"]["categories"]
    return _result(
        breakdown,
        empty="Nothing recent to process (last 30 days already indexed)",
    )


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
        "embed_catalog_video": 0,
        "summarize": 0,
        "chapters": 0,
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


def error_count() -> int:
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(AiJob.status == AiJobStatus.error)
        ).all()
        return len(rows)


def blocked_reason() -> Optional[str]:
    return _blocked_reason


def _set_blocked_reason(reason: Optional[str]) -> None:
    global _blocked_reason
    _blocked_reason = reason


def _job_title(session: Session, job: AiJob) -> Optional[str]:
    if job.video_id:
        video = session.get(Video, job.video_id)
        if video is not None:
            return video.title
    if job.catalog_video_id:
        from ...models import ChannelCatalogVideo

        cv = session.get(ChannelCatalogVideo, job.catalog_video_id)
        if cv is not None:
            return cv.title
    return None


def queue_stats() -> dict:
    """Breakdown of queued work: runnable / deferred / waiting (+ error count)."""
    now = utcnow()
    llm = get_llm_provider()
    embed = get_embed_provider()
    llm_ok = llm is not None
    embed_ok = embed is not None
    runnable = 0
    deferred = 0
    waiting = 0
    running = 0
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(
                AiJob.status.in_([AiJobStatus.queued, AiJobStatus.running])  # type: ignore[attr-defined]
            )
        ).all()
        for job in rows:
            if job.status == AiJobStatus.running:
                running += 1
                continue
            run_after = as_utc(job.run_after)
            due = run_after is None or run_after <= now
            if not due:
                deferred += 1
                continue
            if _job_runnable(job.kind, llm_ok=llm_ok, embed_ok=embed_ok):
                runnable += 1
            else:
                waiting += 1
    return {
        "runnable_count": runnable,
        "deferred_count": deferred,
        "waiting_count": waiting,
        "running_count": running,
        "error_count": error_count(),
    }


def recent_failures(*, limit: int = 10) -> list[dict]:
    limit = max(1, min(int(limit), 50))
    out: list[dict] = []
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob)
            .where(AiJob.status == AiJobStatus.error)
            .order_by(AiJob.updated_at.desc())
            .limit(limit)
        ).all()
        for job in rows:
            kind = job.kind.value if hasattr(job.kind, "value") else str(job.kind)
            out.append(
                {
                    "id": job.id,
                    "kind": kind,
                    "video_id": job.video_id,
                    "catalog_video_id": job.catalog_video_id,
                    "title": _job_title(session, job),
                    "attempts": job.attempts,
                    "error": job.error,
                    "updated_at": job.updated_at.isoformat() if job.updated_at else None,
                }
            )
    return out


def list_jobs(
    *,
    status: Optional[str] = None,
    limit: int = 50,
) -> list[dict]:
    limit = max(1, min(int(limit), 200))
    with Session(engine) as session:
        statement = select(AiJob).order_by(AiJob.updated_at.desc()).limit(limit)
        if status:
            try:
                st = AiJobStatus(status)
            except ValueError as exc:
                raise ValueError(f"Unknown status: {status}") from exc
            statement = (
                select(AiJob)
                .where(AiJob.status == st)
                .order_by(AiJob.updated_at.desc())
                .limit(limit)
            )
        rows = session.exec(statement).all()
        out: list[dict] = []
        for job in rows:
            kind = job.kind.value if hasattr(job.kind, "value") else str(job.kind)
            st_val = job.status.value if hasattr(job.status, "value") else str(job.status)
            out.append(
                {
                    "id": job.id,
                    "kind": kind,
                    "status": st_val,
                    "video_id": job.video_id,
                    "catalog_video_id": job.catalog_video_id,
                    "title": _job_title(session, job),
                    "attempts": job.attempts,
                    "error": job.error,
                    "run_after": job.run_after.isoformat() if job.run_after else None,
                    "created_at": job.created_at.isoformat() if job.created_at else None,
                    "updated_at": job.updated_at.isoformat() if job.updated_at else None,
                }
            )
        return out


def retry_job(job_id: int) -> bool:
    with Session(engine) as session:
        job = session.get(AiJob, job_id)
        if job is None:
            return False
        if job.status not in (AiJobStatus.error, AiJobStatus.cancelled):
            return False
        job.status = AiJobStatus.queued
        job.attempts = 0
        job.run_after = utcnow()
        job.error = None
        job.updated_at = utcnow()
        session.add(job)
        session.commit()
    _wake.set()
    return True


def retry_failed_jobs() -> int:
    reset = 0
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(AiJob.status == AiJobStatus.error)
        ).all()
        for job in rows:
            job.status = AiJobStatus.queued
            job.attempts = 0
            job.run_after = utcnow()
            job.error = None
            job.updated_at = utcnow()
            session.add(job)
            reset += 1
        if reset:
            session.commit()
    if reset:
        _wake.set()
    return reset


def cancel_job(job_id: int) -> bool:
    with Session(engine) as session:
        job = session.get(AiJob, job_id)
        if job is None:
            return False
        if job.status != AiJobStatus.queued:
            return False
        job.status = AiJobStatus.cancelled
        job.error = "cancelled_by_user"
        job.updated_at = utcnow()
        session.add(job)
        session.commit()
    return True


def clear_failed_jobs(*, keep_days: int = 0) -> int:
    """Delete terminal error/cancelled jobs older than keep_days (0 = all)."""
    keep_days = max(0, int(keep_days))
    cutoff = utcnow() - timedelta(days=keep_days) if keep_days else None
    deleted = 0
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(
                AiJob.status.in_([AiJobStatus.error, AiJobStatus.cancelled])  # type: ignore[attr-defined]
            )
        ).all()
        for job in rows:
            if (
                cutoff is not None
                and job.updated_at
                and as_utc(job.updated_at) > cutoff
            ):
                continue
            session.delete(job)
            deleted += 1
        if deleted:
            session.commit()
    return deleted


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
        ai = app_settings.ai_settings()
        if kind in (
            AiJobKind.embed_video.value,
            "embed_video",
            AiJobKind.embed_catalog_video.value,
            "embed_catalog_video",
        ):
            model = str(ai.get("embed_model") or "")
        else:
            model = str(ai.get("chat_model") or "")
        info: dict = {
            "id": job.id,
            "kind": kind,
            "video_id": job.video_id,
            "catalog_video_id": job.catalog_video_id,
            "title": None,
            "channel": None,
            "has_thumbnail": False,
            "model": model or None,
            "attempts": job.attempts,
            "error": job.error,
            "run_after": job.run_after.isoformat() if job.run_after else None,
        }
        if job.video_id:
            video = session.get(Video, job.video_id)
            if video is not None:
                info["title"] = video.title
                info["channel"] = video.channel
                info["has_thumbnail"] = bool(video.thumbnail_path)
        elif job.catalog_video_id:
            from ...models import ChannelCatalog, ChannelCatalogVideo

            cv = session.get(ChannelCatalogVideo, job.catalog_video_id)
            if cv is not None:
                info["title"] = cv.title
                catalog = session.get(ChannelCatalog, cv.catalog_id)
                if catalog is not None:
                    info["channel"] = catalog.channel_name
        return info


def current_job_label() -> Optional[str]:
    info = current_job_info()
    if info is None:
        return None
    if info.get("title"):
        return f"{info['kind']}: {info['title']}"
    if info.get("video_id"):
        return f"{info['kind']} (video {info['video_id']})"
    if info.get("catalog_video_id"):
        return f"{info['kind']} (catalog {info['catalog_video_id']})"
    return str(info["kind"])


def _job_runnable(
    kind: AiJobKind,
    *,
    llm_ok: bool,
    embed_ok: bool,
) -> bool:
    if kind in (AiJobKind.embed_video, AiJobKind.embed_catalog_video):
        return embed_ok
    if kind in (AiJobKind.enrich_tags, AiJobKind.summarize, AiJobKind.chapters):
        return llm_ok
    if kind == AiJobKind.refresh_categories:
        return embed_ok and llm_ok
    return False


def _waiting_reason(*, llm_ok: bool, embed_ok: bool) -> Optional[str]:
    if not llm_ok and not embed_ok:
        return "No AI provider reachable (enable Ollama or OpenRouter)"
    if not embed_ok:
        return "Waiting for embed provider (Ollama or OpenRouter All)"
    if not llm_ok:
        return "Waiting for chat provider (Ollama or OpenRouter)"
    return None


def _stamp_waiting_jobs(reason: str) -> None:
    """Annotate old queued jobs that cannot run yet (no attempt burn)."""
    note = f"{_WAITING_NOTE_PREFIX}{reason}"[:500]
    cutoff = utcnow() - timedelta(seconds=_WAITING_STAMP_AGE_SEC)
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(AiJob.status == AiJobStatus.queued)
        ).all()
        changed = 0
        for job in rows:
            created = as_utc(job.created_at) or as_utc(job.updated_at)
            if created is None or created > cutoff:
                continue
            if job.error == note:
                continue
            job.error = note
            job.updated_at = utcnow()
            session.add(job)
            changed += 1
        if changed:
            session.commit()


def _clear_waiting_notes() -> None:
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(AiJob.status == AiJobStatus.queued)
        ).all()
        changed = 0
        for job in rows:
            if job.error and str(job.error).startswith(_WAITING_NOTE_PREFIX):
                job.error = None
                job.updated_at = utcnow()
                session.add(job)
                changed += 1
        if changed:
            session.commit()


def _compute_blocked_reason(
    *,
    paused: bool,
    llm_ok: bool,
    embed_ok: bool,
    has_queued: bool,
) -> Optional[str]:
    if paused:
        return "AI queue is paused"
    try:
        from .cost_ledger import budget_status

        budget = budget_status()
        if budget.get("blocked"):
            return "OpenRouter weekly budget hard limit reached"
    except Exception:  # noqa: BLE001
        pass
    if not has_queued:
        return None
    wait = _waiting_reason(llm_ok=llm_ok, embed_ok=embed_ok)
    if wait and (not llm_ok or not embed_ok):
        # Only report blocked when something in queue actually needs the missing side.
        with Session(engine) as session:
            rows = session.exec(
                select(AiJob).where(AiJob.status == AiJobStatus.queued)
            ).all()
            needs_missing = False
            for job in rows:
                if not _job_runnable(job.kind, llm_ok=llm_ok, embed_ok=embed_ok):
                    needs_missing = True
                    break
            if needs_missing:
                return wait
    return None


def _next_job(
    session: Session, *, llm_ok: bool, embed_ok: bool
) -> Optional[AiJob]:
    now = utcnow()
    jobs = session.exec(
        select(AiJob)
        .where(AiJob.status == AiJobStatus.queued)
        .where((AiJob.run_after.is_(None)) | (AiJob.run_after <= now))  # type: ignore[attr-defined]
        .order_by(AiJob.created_at.asc())
        .limit(32)
    ).all()
    for job in jobs:
        if _job_runnable(job.kind, llm_ok=llm_ok, embed_ok=embed_ok):
            return job
    return None


_AI_KIND_LABELS = {
    "embed_video": "Embedding video for search",
    "enrich_tags": "Enriching tags",
    "refresh_categories": "Refreshing recommendation categories",
    "score_duplicates": "Scoring duplicate candidates",
    "embed_catalog_video": "Embedding catalog video",
    "summarize": "Summarizing video",
    "chapters": "Generating chapters",
}


def _process_one() -> bool:
    ai = app_settings.ai_settings()
    paused = bool(ai.get("paused"))
    llm = get_llm_provider()
    embed = get_embed_provider()
    llm_ok = llm is not None
    embed_ok = embed is not None
    depth = queue_depth()
    has_queued = depth > 0

    if paused:
        _set_blocked_reason("AI queue is paused")
        return False

    if not llm_ok and not embed_ok:
        reason = _waiting_reason(llm_ok=False, embed_ok=False) or "No AI provider reachable"
        _set_blocked_reason(reason if has_queued else None)
        if has_queued:
            _stamp_waiting_jobs(reason)
        return False

    with Session(engine) as session:
        job = _next_job(session, llm_ok=llm_ok, embed_ok=embed_ok)
        if job is None:
            reason = _compute_blocked_reason(
                paused=False, llm_ok=llm_ok, embed_ok=embed_ok, has_queued=has_queued
            )
            _set_blocked_reason(reason)
            if reason and has_queued:
                _stamp_waiting_jobs(reason)
            elif not reason:
                _clear_waiting_notes()
            return False
        _set_blocked_reason(None)
        job.status = AiJobStatus.running
        job.attempts += 1
        job.updated_at = utcnow()
        session.add(job)
        session.commit()
        job_id = job.id
        kind = job.kind
        video_id = job.video_id
        catalog_video_id = job.catalog_video_id

    _clear_waiting_notes()

    kind_key = kind.value if hasattr(kind, "value") else str(kind)
    info = current_job_info() or {}
    detail = info.get("title") or info.get("channel")
    ai_engine = "ollama"
    try:
        from .provider import embed_backend_name, llm_backend_name

        if kind_key in ("embed_video", "embed_catalog_video"):
            ai_engine = embed_backend_name() or "ollama"
        else:
            ai_engine = llm_backend_name() or "ollama"
    except Exception:  # noqa: BLE001
        ai_engine = "ollama"

    act = None
    try:
        from .. import activity

        act = activity.start(
            "ai",
            _AI_KIND_LABELS.get(kind_key, kind_key.replace("_", " ").title()),
            reason="AI queue job",
            engine=ai_engine,
            detail=detail,
            video_id=video_id,
        )
    except Exception:  # noqa: BLE001
        act = None

    try:
        with Session(engine) as session:
            skip_reason = tasks.dispatch(
                session, kind, video_id, catalog_video_id=catalog_video_id
            )
        with Session(engine) as session:
            job = session.get(AiJob, job_id)
            if job is not None:
                if skip_reason:
                    job.status = AiJobStatus.cancelled
                    job.error = f"skipped: {skip_reason}"[:500]
                else:
                    job.status = AiJobStatus.completed
                    job.error = None
                job.updated_at = utcnow()
                session.add(job)
                session.commit()
        if act is not None:
            act.finish(detail=detail)
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI job %s failed: %s", job_id, exc)
        from .provider import invalidate_resolved_url

        invalidate_resolved_url()
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
        if act is not None:
            act.finish(status="failed", error=str(exc)[:500])
    return True


def _maybe_pending_category_refresh() -> None:
    """After a reindex drains, refresh category shelves once."""
    ai = app_settings.ai_settings()
    if not ai.get("pending_category_refresh"):
        return
    if queue_depth() > 0:
        return
    breakdown = queue_breakdown()
    if breakdown.get("embed_video", 0) > 0:
        return
    app_settings.save({"ai": {"pending_category_refresh": False}})
    enqueue_refresh_categories(force=True)


def _worker_loop() -> None:
    while not _stop.is_set():
        try:
            worked = _process_one()
        except Exception:  # noqa: BLE001
            logger.exception("AI worker loop error")
            worked = False
        if worked:
            continue
        try:
            _maybe_pending_category_refresh()
        except Exception:  # noqa: BLE001
            logger.exception("Pending category refresh failed")
        _wake.wait(timeout=2.0)
        _wake.clear()


def _maybe_run_daily() -> None:
    """Run backlog once per local calendar day at schedule_time (HH:MM)."""
    from datetime import datetime

    ai = app_settings.ai_settings()
    if ai.get("paused"):
        return
    if not ai.get("enabled", True) and not openrouter_configured():
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
            if (
                (ai.get("enabled", True) or openrouter_configured())
                and not ai.get("paused")
            ):
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
                if schedule == "on_download":
                    maybe_enqueue_index_catchup()
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


def recover_ai_jobs() -> int:
    """Requeue AI jobs left in running after a process crash/restart."""
    reset = 0
    with Session(engine) as session:
        rows = session.exec(
            select(AiJob).where(AiJob.status == AiJobStatus.running)
        ).all()
        for job in rows:
            job.status = AiJobStatus.queued
            job.run_after = None
            job.updated_at = utcnow()
            session.add(job)
            reset += 1
        if reset:
            session.commit()
    if reset:
        logger.info("Recovered %s stuck AI job(s) → queued", reset)
        _wake.set()
    return reset


def stop_ai_worker() -> None:
    _stop.set()
    _wake.set()


def wake_worker() -> None:
    _wake.set()

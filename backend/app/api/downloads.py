import asyncio
import json
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from sqlmodel import Session, select

from ..database import get_session
from ..models import DownloadJob, JobStatus
from ..schemas import (
    DownloadCreate,
    DownloadJobRead,
    DownloadJobUpdate,
    DownloadPreview,
    DownloadQueueStatus,
)
from ..services import downloader, library
from ..services.url_clean import _youtube_video_id, clean_url
from urllib.parse import urlparse

router = APIRouter(prefix="/api/downloads", tags=["downloads"])

QUALITY_PRESETS = list(downloader.QUALITY_FORMATS.keys())


@router.get("/presets", response_model=list[str])
def list_presets():
    return QUALITY_PRESETS


@router.get("/preview", response_model=DownloadPreview)
def preview_download(url: str):
    if not url.strip():
        raise HTTPException(status_code=400, detail="URL is required")
    try:
        return downloader.extract_preview(clean_url(url, keep_playlist=True))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not read link: {exc}")


@router.get("/queue/status", response_model=DownloadQueueStatus)
def queue_status():
    return DownloadQueueStatus(
        paused=downloader.download_queue.is_paused(),
        active_count=downloader.download_queue.active_count(),
        queued_count=downloader.download_queue.queued_count(),
    )


@router.post("/queue/pause", response_model=DownloadQueueStatus)
def pause_queue():
    downloader.download_queue.pause_all()
    return DownloadQueueStatus(
        paused=True,
        active_count=downloader.download_queue.active_count(),
        queued_count=downloader.download_queue.queued_count(),
    )


@router.post("/queue/resume", response_model=DownloadQueueStatus)
def resume_queue():
    downloader.download_queue.resume_all()
    return DownloadQueueStatus(
        paused=downloader.download_queue.is_paused(),
        active_count=downloader.download_queue.active_count(),
        queued_count=downloader.download_queue.queued_count(),
    )


@router.post("", response_model=DownloadJobRead)
def create_download(payload: DownloadCreate, session: Session = Depends(get_session)):
    if not payload.url.strip():
        raise HTTPException(status_code=400, detail="URL is required")

    url = clean_url(payload.url, keep_playlist=False)

    preview: dict = {}
    try:
        preview = downloader.extract_preview(url)
    except Exception:  # noqa: BLE001
        pass

    # If this YouTube id is already in the library, replace that row on completion.
    replace_video_id = None
    yt_id = preview.get("id") if isinstance(preview, dict) else None
    if not yt_id:
        try:
            yt_id = _youtube_video_id(urlparse(url))
        except Exception:  # noqa: BLE001
            yt_id = None
    if yt_id:
        existing = library.find_video_by_youtube_id(session, str(yt_id))
        if existing is not None:
            replace_video_id = existing.id

    job = DownloadJob(
        url=url,
        quality_preset=payload.quality_preset,
        status=JobStatus.queued,
        title=preview.get("title"),
        channel=preview.get("channel"),
        thumbnail_url=preview.get("thumbnail_url"),
        title_override=(payload.title_override or "").strip() or None,
        channel_override=(payload.channel_override or "").strip() or None,
        notes_pending=(payload.notes_pending or "").strip() or None,
        normalize_volume=payload.normalize_volume,
        replace_video_id=replace_video_id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    downloader.enqueue_download(job.id)
    return job


@router.patch("/{job_id}", response_model=DownloadJobRead)
def update_job(
    job_id: int,
    payload: DownloadJobUpdate,
    session: Session = Depends(get_session),
):
    job = session.get(DownloadJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in (JobStatus.queued, JobStatus.downloading):
        if job.status == JobStatus.completed and job.video_id:
            data = payload.model_dump(exclude_unset=True)
            if "notes_pending" in data:
                job.notes_pending = (data["notes_pending"] or "").strip() or None
                session.add(job)
                session.commit()
                session.refresh(job)
            return job
        raise HTTPException(
            status_code=409, detail="Job already finished; edit the video instead"
        )
    data = payload.model_dump(exclude_unset=True)
    if "title_override" in data:
        job.title_override = (data["title_override"] or "").strip() or None
    if "channel_override" in data:
        job.channel_override = (data["channel_override"] or "").strip() or None
    if "notes_pending" in data:
        job.notes_pending = (data["notes_pending"] or "").strip() or None
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


@router.post("/{job_id}/cancel", response_model=DownloadJobRead)
def cancel_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(DownloadJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status in (JobStatus.completed, JobStatus.cancelled):
        raise HTTPException(status_code=409, detail="Job already finished")
    was_downloading = job.status == JobStatus.downloading
    downloader.download_queue.cancel_job(job_id)
    if was_downloading:
        import time

        for _ in range(20):
            time.sleep(0.25)
            session.expire_all()
            job = session.get(DownloadJob, job_id)
            if job and job.status != JobStatus.downloading:
                break
    session.refresh(job)
    return job


@router.post("/dismiss-finished", status_code=204)
def dismiss_finished_jobs(session: Session = Depends(get_session)):
    """Remove all completed and errored jobs from the list."""
    statement = select(DownloadJob).where(
        DownloadJob.status.in_([JobStatus.completed, JobStatus.error])  # type: ignore[attr-defined]
    )
    jobs = list(session.exec(statement).all())
    for job in jobs:
        downloader.progress_store.pop(job.id, None)
        session.delete(job)
    session.commit()
    return Response(status_code=204)


@router.delete("/{job_id}", status_code=204)
def dismiss_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(DownloadJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in (JobStatus.completed, JobStatus.error, JobStatus.cancelled):
        raise HTTPException(
            status_code=409,
            detail="Only finished jobs can be removed from the list",
        )
    session.delete(job)
    session.commit()
    downloader.progress_store.pop(job_id, None)
    return Response(status_code=204)


@router.get("", response_model=list[DownloadJobRead])
def list_jobs(session: Session = Depends(get_session)):
    statement = select(DownloadJob).order_by(DownloadJob.created_at.desc()).limit(50)
    return list(session.exec(statement).all())


@router.get("/{job_id}", response_model=DownloadJobRead)
def get_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(DownloadJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/{job_id}/events")
async def job_events(job_id: int) -> StreamingResponse:
    async def event_stream() -> AsyncGenerator[str, None]:
        last_payload = None
        while True:
            snapshot = downloader.progress_store.get(job_id)
            if snapshot is not None and snapshot != last_payload:
                last_payload = snapshot
                yield f"data: {json.dumps(snapshot)}\n\n"
                if snapshot.get("status") in {
                    "completed",
                    "error",
                    "cancelled",
                }:
                    break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

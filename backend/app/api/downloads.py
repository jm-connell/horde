import asyncio
import json
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from ..database import get_session
from ..models import DownloadJob, JobStatus
from ..schemas import (
    DownloadCreate,
    DownloadJobRead,
    DownloadJobUpdate,
    DownloadPreview,
)
from ..services import downloader
from ..services.url_clean import clean_url

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
    except Exception as exc:  # noqa: BLE001 - surface extraction failures to the UI
        raise HTTPException(status_code=400, detail=f"Could not read link: {exc}")


@router.post("", response_model=DownloadJobRead)
def create_download(payload: DownloadCreate, session: Session = Depends(get_session)):
    if not payload.url.strip():
        raise HTTPException(status_code=400, detail="URL is required")

    url = clean_url(payload.url, keep_playlist=False)

    job = DownloadJob(
        url=url,
        quality_preset=payload.quality_preset,
        status=JobStatus.queued,
        title_override=(payload.title_override or "").strip() or None,
        channel_override=(payload.channel_override or "").strip() or None,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    downloader.start_download(
        job.id,
        job.url,
        job.quality_preset,
        title_override=job.title_override,
        channel_override=job.channel_override,
    )
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
        raise HTTPException(
            status_code=409, detail="Job already finished; edit the video instead"
        )
    data = payload.model_dump(exclude_unset=True)
    if "title_override" in data:
        job.title_override = (data["title_override"] or "").strip() or None
    if "channel_override" in data:
        job.channel_override = (data["channel_override"] or "").strip() or None
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


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
                if snapshot.get("status") in {"completed", "error"}:
                    break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

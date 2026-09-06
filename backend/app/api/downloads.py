import asyncio
import json
import logging
from typing import AsyncGenerator, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR
from ..database import get_session
from ..models import DownloadDestination, DownloadJob, JobStatus, Video
from ..schemas import (
    DownloadCreate,
    DownloadJobRead,
    DownloadJobUpdate,
    DownloadPreview,
    DownloadQualityUpdate,
    DownloadQueueStatus,
)
from ..services import downloader, library
from ..services.paths import safe_filename
from ..services.url_clean import _youtube_video_id, clean_url
from ..services.ytdlp_common import (
    ERROR_KIND_BOT,
    ERROR_KIND_COOKIES,
    ERROR_KIND_MEMBERS,
    ERROR_KIND_UNAVAILABLE,
    ERROR_KIND_UNKNOWN,
    MembersOnlyError,
    classify_ytdlp_error,
    http_detail_for_error,
    record_extract_failure,
)
from ..services.ytdlp_formats import (
    decode_available_presets,
    default_download_video_codec,
    normalize_video_codec,
    quality_from_preview,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/downloads", tags=["downloads"])

QUALITY_PRESETS = list(downloader.QUALITY_FORMATS.keys())

_CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".opus": "audio/opus",
    ".ogg": "audio/ogg",
}

_PREVIEW_ATTACH_KINDS = frozenset(
    {
        ERROR_KIND_MEMBERS,
        ERROR_KIND_BOT,
        ERROR_KIND_COOKIES,
        ERROR_KIND_UNAVAILABLE,
    }
)


def _enrich_jobs(session: Session, jobs: list[DownloadJob]) -> list[DownloadJobRead]:
    """Attach video_missing / superseded flags for history UI."""
    if not jobs:
        return []

    video_ids = {
        vid
        for j in jobs
        for vid in (j.video_id, j.replace_video_id)
        if vid is not None
    }
    existing: set[int] = set()
    height_by_video: dict[int, Optional[int]] = {}
    if video_ids:
        videos = session.exec(
            select(Video).where(Video.id.in_(list(video_ids)))  # type: ignore[attr-defined]
        ).all()
        for video in videos:
            if video.id is None:
                continue
            existing.add(video.id)
            height_by_video[video.id] = video.height_px

    # Newest completed job wins per video_id and per URL.
    latest_by_video: dict[int, int] = {}
    latest_by_url: dict[str, int] = {}
    for j in jobs:
        if j.status != JobStatus.completed:
            continue
        if j.video_id is not None:
            prev = latest_by_video.get(j.video_id)
            if prev is None or j.id > prev:
                latest_by_video[j.video_id] = j.id
        url_key = (j.url or "").strip()
        if url_key:
            prev = latest_by_url.get(url_key)
            if prev is None or j.id > prev:
                latest_by_url[url_key] = j.id

    out: list[DownloadJobRead] = []
    for j in jobs:
        video_missing = bool(j.video_id is not None and j.video_id not in existing)
        superseded = False
        if j.status == JobStatus.completed:
            if j.video_id is not None and latest_by_video.get(j.video_id) != j.id:
                superseded = True
            url_key = (j.url or "").strip()
            if url_key and latest_by_url.get(url_key) != j.id:
                superseded = True
        out.append(
            DownloadJobRead.model_validate(j).model_copy(
                update={
                    "video_missing": video_missing,
                    "superseded": superseded,
                    "available_presets": decode_available_presets(
                        j.available_presets_json
                    ),
                    "height_px": j.height_px
                    if j.height_px
                    else (
                        height_by_video.get(j.video_id)
                        if j.video_id is not None
                        else None
                    ),
                }
            )
        )
    return out


@router.get("/presets", response_model=list[str])
def list_presets():
    return QUALITY_PRESETS


@router.get("/preview", response_model=DownloadPreview)
def preview_download(url: str):
    if not url.strip():
        raise HTTPException(status_code=400, detail="URL is required")
    try:
        return downloader.extract_preview(clean_url(url, keep_playlist=True))
    except MembersOnlyError as exc:
        raise HTTPException(
            status_code=400,
            detail=http_detail_for_error(exc, prefix="Could not read link"),
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        kind, _ = classify_ytdlp_error(exc)
        detail = http_detail_for_error(exc, prefix="Could not read link")
        if kind == ERROR_KIND_UNKNOWN:
            logger.exception("download preview extract failed for %r", url)
            raise HTTPException(status_code=500, detail=detail) from exc
        raise HTTPException(status_code=400, detail=detail) from exc


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
    destination = payload.destination.value if payload.destination else "library"

    preview: dict = {}
    preview_kind: str | None = None
    preview_message: str | None = None
    try:
        preview = downloader.extract_preview(url)
    except Exception as exc:  # noqa: BLE001
        preview_kind, preview_message = classify_ytdlp_error(exc)
        record_extract_failure(preview_kind, preview_message)

    # If this YouTube id is already in the library, replace that row on completion.
    # Device jobs must never overwrite library files.
    replace_video_id = None
    if destination == "library":
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

    quality_preset, presets_json = quality_from_preview(
        payload.quality_preset, preview if isinstance(preview, dict) else {}
    )

    with downloader.job_mutate_lock:
        active = downloader.find_active_job(
            session, url, destination, quality_preset
        )
        if active is not None:
            return _enrich_jobs(session, [active])[0]

        job = DownloadJob(
            url=url,
            quality_preset=quality_preset,
            available_presets_json=presets_json,
            status=JobStatus.queued,
            title=preview.get("title"),
            channel=preview.get("channel"),
            thumbnail_url=preview.get("thumbnail_url"),
            title_override=(payload.title_override or "").strip() or None,
            channel_override=(payload.channel_override or "").strip() or None,
            notes_pending=(payload.notes_pending or "").strip() or None,
            normalize_volume=payload.normalize_volume,
            video_codec=normalize_video_codec(
                payload.video_codec or default_download_video_codec()
            ),
            destination=destination,
            replace_video_id=replace_video_id,
        )
        if preview_kind and preview_kind in _PREVIEW_ATTACH_KINDS and preview_message:
            # Still enqueue, but surface why metadata is missing on the card.
            job.error = preview_message
            job.error_kind = preview_kind
        session.add(job)
        session.commit()
        session.refresh(job)

    downloader.enqueue_download(job.id)
    return _enrich_jobs(session, [job])[0]


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
            return _enrich_jobs(session, [job])[0]
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
    return _enrich_jobs(session, [job])[0]


@router.post("/{job_id}/retry", response_model=DownloadJobRead)
def retry_job(
    job_id: int,
    payload: Optional[DownloadJobUpdate] = Body(default=None),
    session: Session = Depends(get_session),
):
    """Requeue a failed/cancelled job. Extra clicks return the same active job."""
    data = (payload or DownloadJobUpdate()).model_dump(exclude_unset=True)
    with downloader.job_mutate_lock:
        job = session.get(DownloadJob, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        if job.status == JobStatus.completed:
            raise HTTPException(status_code=409, detail="Job already finished")
        if job.status in (JobStatus.queued, JobStatus.downloading):
            return _enrich_jobs(session, [job])[0]
        if job.status not in (JobStatus.error, JobStatus.cancelled):
            raise HTTPException(status_code=409, detail="Job is not retryable")

        if "title_override" in data:
            job.title_override = (data["title_override"] or "").strip() or None
        if "channel_override" in data:
            job.channel_override = (data["channel_override"] or "").strip() or None
        if "notes_pending" in data:
            job.notes_pending = (data["notes_pending"] or "").strip() or None

        downloader.prepare_job_retry(job)
        session.add(job)
        session.commit()
        session.refresh(job)

    downloader.enqueue_download(job.id)
    return _enrich_jobs(session, [job])[0]


@router.post("/{job_id}/quality", response_model=DownloadJobRead)
def change_job_quality(
    job_id: int,
    payload: DownloadQualityUpdate,
    session: Session = Depends(get_session),
):
    """Change resolution on an active job. In-flight work is discarded and restarted."""
    try:
        job = downloader.change_job_quality(session, job_id, payload.quality_preset)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _enrich_jobs(session, [job])[0]


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
    return _enrich_jobs(session, [job])[0]


@router.post("/dismiss-finished", status_code=204)
def dismiss_finished_jobs(session: Session = Depends(get_session)):
    """Remove all completed and errored jobs from the list."""
    statement = select(DownloadJob).where(
        DownloadJob.status.in_([JobStatus.completed, JobStatus.error])  # type: ignore[attr-defined]
    )
    jobs = list(session.exec(statement).all())
    for job in jobs:
        if job.destination == DownloadDestination.device.value:
            downloader.cleanup_device_job_files(job.id, job.device_file_path)
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
    if job.destination == DownloadDestination.device.value:
        downloader.cleanup_device_job_files(job.id, job.device_file_path)
    session.delete(job)
    session.commit()
    downloader.progress_store.pop(job_id, None)
    return Response(status_code=204)


@router.get("", response_model=list[DownloadJobRead])
def list_jobs(session: Session = Depends(get_session)):
    statement = select(DownloadJob).order_by(DownloadJob.created_at.desc()).limit(50)
    return _enrich_jobs(session, list(session.exec(statement).all()))


@router.get("/{job_id}", response_model=DownloadJobRead)
def get_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(DownloadJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return _enrich_jobs(session, [job])[0]


@router.get("/{job_id}/file")
def download_device_file(job_id: int, session: Session = Depends(get_session)):
    """Serve an ephemeral device-destination download as a browser attachment."""
    job = session.get(DownloadJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.destination != DownloadDestination.device.value:
        raise HTTPException(
            status_code=409, detail="Job is not a device download"
        )
    if job.status != JobStatus.completed or not job.device_file_path:
        raise HTTPException(status_code=409, detail="File not ready")

    rel = job.device_file_path.replace("\\", "/")
    if not downloader.is_device_staging_path(rel):
        raise HTTPException(status_code=404, detail="File not found")

    path = (DOWNLOADS_DIR / rel).resolve()
    try:
        path.relative_to(DOWNLOADS_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="File not found") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    title = (job.title_override or job.title or path.stem).strip() or "video"
    filename = f"{safe_filename(title)}{path.suffix.lower()}"
    content_type = _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=content_type, filename=filename)


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

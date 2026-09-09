import asyncio
import json
import logging
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR
from ..database import get_session
from ..models import DownloadDestination, DownloadJob, JobStatus, Playlist, Video
from ..schemas import (
    DownloadBulkCreate,
    DownloadBulkResult,
    DownloadBulkSkip,
    DownloadCreate,
    DownloadJobRead,
    DownloadJobUpdate,
    DownloadPreview,
    DownloadQualityUpdate,
    DownloadQueueStatus,
)
from ..services import downloader
from ..services.paths import safe_filename
from ..services.url_clean import (
    clean_url,
    is_playlist_only_url,
    youtube_thumbnail_url,
    youtube_video_id,
)
from ..services.ytdlp_common import (
    ERROR_KIND_UNKNOWN,
    MembersOnlyError,
    classify_ytdlp_error,
    http_detail_for_error,
)
from ..services.ytdlp_extract import is_youtube_short_url
from ..services.ytdlp_formats import (
    decode_available_presets,
    default_download_video_codec,
    normalize_video_codec,
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


def _duplicate_detail(code: str) -> dict[str, str]:
    return {
        "code": code,
        "message": downloader.DUPLICATE_MESSAGES.get(code, "Already added"),
    }


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
    cleaned = clean_url(url, keep_playlist=True)
    try:
        return downloader.extract_preview(cleaned)
    except MembersOnlyError as exc:
        raise HTTPException(
            status_code=400,
            detail=http_detail_for_error(
                exc, prefix="Could not read link", url=cleaned
            ),
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        kind, _ = classify_ytdlp_error(exc, url=cleaned)
        detail = http_detail_for_error(
            exc, prefix="Could not read link", url=cleaned
        )
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


@router.get("/events")
async def queue_events() -> StreamingResponse:
    """One EventSource for the whole download queue (avoids HTTP/1.1 socket cap)."""

    async def event_stream() -> AsyncGenerator[str, None]:
        last_payloads: dict[int, Any] = {}
        while True:
            items = list(downloader.progress_store.items())
            for job_id, snapshot in items:
                if not isinstance(snapshot, dict):
                    continue
                if snapshot != last_payloads.get(job_id):
                    last_payloads[job_id] = snapshot
                    payload = {"job_id": job_id, **snapshot}
                    yield f"data: {json.dumps(payload)}\n\n"
            await asyncio.sleep(0.4)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("", response_model=DownloadJobRead)
def create_download(payload: DownloadCreate, session: Session = Depends(get_session)):
    if not payload.url.strip():
        raise HTTPException(status_code=400, detail="URL is required")

    if is_youtube_short_url(payload.url):
        raise HTTPException(
            status_code=400, detail="YouTube Shorts are not downloaded"
        )

    url = clean_url(payload.url, keep_playlist=False)
    destination = payload.destination.value if payload.destination else "library"
    playlist_id = payload.playlist_id
    if playlist_id is not None:
        if session.get(Playlist, playlist_id) is None:
            raise HTTPException(status_code=404, detail="Playlist not found")
        if destination != "library":
            playlist_id = None

    if is_youtube_short_url(url):
        raise HTTPException(
            status_code=400, detail="YouTube Shorts are not downloaded"
        )
    if is_playlist_only_url(payload.url) or is_playlist_only_url(url):
        raise HTTPException(
            status_code=400,
            detail="Paste a playlist link by itself to import it",
        )

    quality_preset = (payload.quality_preset or "best").strip() or "best"
    yt_id = youtube_video_id(url)
    thumb = youtube_thumbnail_url(yt_id) if yt_id else None

    from ..services.job_metadata import request_job_metadata

    with downloader.job_mutate_lock:
        dup = downloader.classify_enqueue_duplicate(session, url)
        if dup is not None:
            code, existing_id = dup
            if playlist_id is not None and existing_id is not None:
                active = session.get(DownloadJob, existing_id)
                if active is not None:
                    if active.playlist_id is None:
                        active.playlist_id = playlist_id
                        session.add(active)
                        session.commit()
                        session.refresh(active)
                    return _enrich_jobs(session, [active])[0]
            raise HTTPException(status_code=409, detail=_duplicate_detail(code))

        job = DownloadJob(
            url=url,
            quality_preset=quality_preset,
            status=JobStatus.queued,
            thumbnail_url=thumb,
            title_override=(payload.title_override or "").strip() or None,
            channel_override=(payload.channel_override or "").strip() or None,
            notes_pending=(payload.notes_pending or "").strip() or None,
            normalize_volume=payload.normalize_volume,
            video_codec=normalize_video_codec(
                payload.video_codec or default_download_video_codec()
            ),
            destination=destination,
            playlist_id=playlist_id,
            paused=downloader.download_queue.is_paused(),
        )
        session.add(job)
        session.commit()
        session.refresh(job)

    request_job_metadata(job.id)
    downloader.enqueue_download(job.id)
    return _enrich_jobs(session, [job])[0]


@router.post("/bulk", response_model=DownloadBulkResult)
def create_downloads_bulk(
    payload: DownloadBulkCreate, session: Session = Depends(get_session)
):
    """Enqueue URLs as individual jobs without blocking on metadata extract."""
    quality = (payload.quality_preset or "best").strip() or "best"
    destination = payload.destination.value if payload.destination else "library"
    codec = normalize_video_codec(
        payload.video_codec or default_download_video_codec()
    )
    jobs: list[DownloadJob] = []
    skips: list[DownloadBulkSkip] = []
    seen_urls: set[str] = set()
    seen_ids: set[str] = set()

    from ..services.job_metadata import request_job_metadata

    for raw in payload.urls:
        if not raw.strip():
            continue
        if is_youtube_short_url(raw):
            skips.append(DownloadBulkSkip(url=raw.strip(), reason="shorts"))
            continue
        if is_playlist_only_url(raw):
            skips.append(DownloadBulkSkip(url=raw.strip(), reason="playlist"))
            continue
        url = clean_url(raw, keep_playlist=False)
        if not url:
            continue
        if is_youtube_short_url(url):
            skips.append(DownloadBulkSkip(url=url, reason="shorts"))
            continue
        if is_playlist_only_url(url):
            skips.append(DownloadBulkSkip(url=url, reason="playlist"))
            continue
        yt_id = youtube_video_id(url)
        identity = yt_id or url
        if url in seen_urls or identity in seen_ids:
            skips.append(DownloadBulkSkip(url=url, reason="duplicate_in_paste"))
            continue
        seen_urls.add(url)
        seen_ids.add(identity)

        with downloader.job_mutate_lock:
            dup = downloader.classify_enqueue_duplicate(session, url)
            if dup is not None:
                code, _existing = dup
                skips.append(DownloadBulkSkip(url=url, reason=code))
                continue
            job = DownloadJob(
                url=url,
                quality_preset=quality,
                status=JobStatus.queued,
                thumbnail_url=youtube_thumbnail_url(yt_id) if yt_id else None,
                normalize_volume=payload.normalize_volume,
                video_codec=codec,
                destination=destination,
                paused=downloader.download_queue.is_paused(),
            )
            session.add(job)
            session.commit()
            session.refresh(job)
        request_job_metadata(job.id)
        downloader.enqueue_download(job.id)
        jobs.append(job)

    return DownloadBulkResult(
        jobs=_enrich_jobs(session, jobs),
        skipped=len(skips),
        skips=skips,
    )


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
    """Remove completed, failed, and cancelled jobs from the list."""
    statement = select(DownloadJob).where(
        DownloadJob.status.in_(
            [JobStatus.completed, JobStatus.error, JobStatus.cancelled]
        )  # type: ignore[attr-defined]
    )
    jobs = list(session.exec(statement).all())
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
    active = list(
        session.exec(
            select(DownloadJob)
            .where(
                DownloadJob.status.in_(
                    [JobStatus.queued, JobStatus.downloading]
                )
            )
            .order_by(DownloadJob.created_at.asc())
        ).all()
    )
    recent = list(
        session.exec(
            select(DownloadJob)
            .where(
                DownloadJob.status.in_(
                    [JobStatus.completed, JobStatus.error, JobStatus.cancelled]
                )
            )
            .order_by(DownloadJob.created_at.desc())
            .limit(40)
        ).all()
    )
    seen = {job.id for job in active}
    jobs = active + [job for job in recent if job.id not in seen]
    return _enrich_jobs(session, jobs)


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

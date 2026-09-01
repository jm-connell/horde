import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, func, select

from ..config import DOWNLOADS_DIR, SPRITES_DIR, THUMBNAILS_DIR
from ..database import get_session
from ..models import DownloadJob, JobStatus, Video, VideoAiMeta, utcnow
from ..schemas import (
    BulkMetadataRefresh,
    BulkVideoDelete,
    BulkVideoNotes,
    MetadataRefreshResult,
    MetadataSyncStatus,
    StorageStats,
    TagStat,
    VideoRead,
    VideoRedownload,
    VideoUpdate,
    WatchProgressUpdate,
)
from ..services import downloader, library
from ..services.mp4_compat import apple_webkit_playback, ensure_safari_mp4
from ..services.paths import to_rel_path
from ..services.metadata import (
    delete_sprite_files,
    load_sprite_meta,
    sprite_image_path,
    sprites_exist,
)
from ..services.paths import (
    is_manual_import,
    manual_import_rel_path,
    rename_video_file,
)
from ..services.sprites import enqueue_sprite_generation

from .video_serialize import (
    as_utc as _as_utc,
    resolve_media as _resolve_media,
    safe_filename as _safe_filename,
    to_read as _to_read,
)


router = APIRouter(prefix="/api", tags=["videos"])

CHUNK_SIZE = 1024 * 1024

CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
}


@router.get("/videos", response_model=list[VideoRead])
def list_videos(
    q: Optional[str] = None,
    channel: Optional[str] = None,
    tag: Optional[str] = None,
    sort: str = Query("added_at"),
    order: str = Query("desc"),
    continue_watching: bool = False,
    watched_only: bool = False,
    seed: Optional[int] = None,
    session: Session = Depends(get_session),
):
    if continue_watching or watched_only:
        library.expire_stale_progress(session)
    if q and not continue_watching and not watched_only:
        from ..services.ai.search import hybrid_search

        videos = hybrid_search(
            session,
            q,
            channel=channel,
            tag=tag,
            sort=sort,
            order=order,
            needs_review=False,
            seed=seed,
        )
    else:
        videos = library.query_videos(
            session,
            q=q,
            channel=channel,
            tag=tag,
            sort=sort,
            order=order,
            needs_review=False,
            continue_watching=continue_watching,
            watched_only=watched_only,
            seed=seed,
        )
    return [_to_read(v, session) for v in videos]


@router.get("/tags", response_model=list[str])
def list_tags(session: Session = Depends(get_session)):
    return library.all_tags(session)


@router.get("/tags/stats", response_model=list[TagStat])
def tag_stats(
    channel: Optional[str] = None, session: Session = Depends(get_session)
):
    return [
        TagStat(tag=t, count=n) for t, n in library.tag_stats(session, channel=channel)
    ]


@router.get("/stats/storage", response_model=StorageStats)
def storage_stats(session: Session = Depends(get_session)):
    video_bytes = session.exec(
        select(func.coalesce(func.sum(Video.file_size), 0)).where(
            Video.needs_review == False  # noqa: E712
        )
    ).one()
    video_count = session.exec(
        select(func.count(Video.id)).where(Video.needs_review == False)  # noqa: E712
    ).one()
    thumbnail_bytes = 0
    if THUMBNAILS_DIR.exists():
        thumbnail_bytes = sum(
            f.stat().st_size for f in THUMBNAILS_DIR.glob("*") if f.is_file()
        )
    return StorageStats(
        total_bytes=int(video_bytes) + thumbnail_bytes,
        video_bytes=int(video_bytes),
        thumbnail_bytes=thumbnail_bytes,
        video_count=int(video_count),
    )


# Static /videos/... paths must be registered before /videos/{video_id}
# or FastAPI treats the last segment as an int and returns 422.
@router.post("/videos/bulk-delete", status_code=204)
def bulk_delete_videos(
    payload: BulkVideoDelete,
    session: Session = Depends(get_session),
):
    for vid_id in payload.video_ids:
        video = session.get(Video, vid_id)
        if video is None:
            continue
        if payload.delete_files:
            _delete_media_files(video)
        if video.thumbnail_path:
            Path(video.thumbnail_path).unlink(missing_ok=True)
        if video.id is not None:
            delete_sprite_files(SPRITES_DIR, video.id)
        session.delete(video)
    session.commit()
    return Response(status_code=204)


@router.patch("/videos/bulk-notes", status_code=204)
def bulk_update_notes(
    payload: BulkVideoNotes,
    session: Session = Depends(get_session),
):
    note = payload.notes.strip() or None
    for vid_id in payload.video_ids:
        video = session.get(Video, vid_id)
        if video is None:
            continue
        video.notes = note
        session.add(video)
    session.commit()
    return Response(status_code=204)


@router.get("/videos/{video_id}", response_model=VideoRead)
def get_video(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _to_read(video, session, include_processing=True)


@router.get("/videos/{video_id}/related", response_model=list[VideoRead])
def related_videos(
    video_id: int,
    limit: int = Query(8, ge=1, le=24),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    rows = library.related_videos(session, video_id, limit=limit, offset=offset)
    return [_to_read(v, session) for v in rows]


@router.patch("/videos/{video_id}", response_model=VideoRead)
def update_video(
    video_id: int,
    payload: VideoUpdate,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")

    data = payload.model_dump(exclude_unset=True)
    manual = is_manual_import(video)
    path_fields_changed = "title" in data or "channel" in data

    tags_edited = False
    user_tag = data.pop("user_tag", None)
    if "tags" in data and data["tags"] is not None:
        video.tags = library.dump_tags(data.pop("tags"))
        tags_edited = True
    if "thumbnail_url" in data and data["thumbnail_url"]:
        _fetch_thumbnail_from_url(video, data.pop("thumbnail_url"))
    data.pop("thumbnail_url", None)

    # Track user customizations so metadata resync / replace can preserve them.
    # Adopting source_* clears the flag; any other edit sets it.
    explicit_title_custom = data.pop("title_is_custom", None)
    explicit_desc_custom = data.pop("description_is_custom", None)

    if "title" in data:
        new_title = data["title"]
        if video.source_title is not None and new_title == video.source_title:
            video.title_is_custom = False
        else:
            video.title_is_custom = True
    if "description" in data:
        new_desc = data["description"]
        if video.source_description is not None and new_desc == video.source_description:
            video.description_is_custom = False
        else:
            video.description_is_custom = True

    if explicit_title_custom is not None:
        video.title_is_custom = bool(explicit_title_custom)
    if explicit_desc_custom is not None:
        video.description_is_custom = bool(explicit_desc_custom)

    for key, value in data.items():
        setattr(video, key, value)

    was_review = video.needs_review
    # Auto-clear the review flag once the required fields are present.
    if video.needs_review and video.title and video.channel:
        video.needs_review = False

    if manual and path_fields_changed and video.title:
        ext = Path(video.file_path).suffix or ".mp4"
        target = manual_import_rel_path(video.channel, video.title, ext)
        if target.replace("\\", "/") != video.file_path.replace("\\", "/"):
            try:
                rename_video_file(session, video, target)
            except FileNotFoundError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except OSError as exc:
                raise HTTPException(
                    status_code=500, detail=f"Could not rename file: {exc}"
                ) from exc

    session.add(video)
    session.commit()
    session.refresh(video)

    if tags_edited:
        try:
            from ..services.ai.embeddings import sync_tag_provenance

            sync_tag_provenance(
                session,
                video.id,
                user_tag=user_tag if isinstance(user_tag, str) else None,
            )
            session.commit()
        except Exception:  # noqa: BLE001
            pass

    # After leaving review, queue AI enrichment for scanner-ingested files.
    if was_review and not video.needs_review and video.id is not None:
        try:
            from ..services.ai import enqueue_for_video

            enqueue_for_video(video.id, include_tags=True, force=False)
        except Exception:  # noqa: BLE001
            pass

    return _to_read(video, session)


@router.patch("/videos/{video_id}/progress", status_code=204)
def update_progress(
    video_id: int,
    payload: WatchProgressUpdate,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    # Treat the first few seconds as "not started" so brief opens don't clutter
    # the Continue watching row. A reset to 0 (on finish) is always honored.
    # Near-complete watches (>=90%) are treated as finished — clear progress.
    position = max(0.0, payload.position_sec)
    duration = video.duration_sec
    if (
        duration
        and duration > 0
        and position > 0
        and position >= duration * 0.9
    ):
        position = 0.0
    if position >= 5 or position == 0:
        library.expire_stale_progress(session)
        video.last_position_sec = position
        video.last_watched_at = utcnow()
        session.add(video)
        session.commit()
    return Response(status_code=204)


@router.delete("/videos/{video_id}", status_code=204)
def delete_video(
    video_id: int,
    delete_file: bool = False,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    if delete_file:
        _delete_media_files(video)
    if video.thumbnail_path:
        Path(video.thumbnail_path).unlink(missing_ok=True)
    if video.id is not None:
        delete_sprite_files(SPRITES_DIR, video.id)
    session.delete(video)
    session.commit()
    return Response(status_code=204)


def _delete_media_files(video: Video) -> None:
    media = DOWNLOADS_DIR / video.file_path
    if media.exists():
        media.unlink(missing_ok=True)
    for track in library.parse_subtitles(video.subtitles):
        sub = DOWNLOADS_DIR / track.get("path", "")
        if sub.exists():
            sub.unlink(missing_ok=True)


def _effective_source_url(video: Video) -> Optional[str]:
    if video.source_url and video.source_url.strip():
        return video.source_url.strip()
    match = re.search(r"\[([A-Za-z0-9_-]{11})\]", video.file_path)
    if match:
        return f"https://www.youtube.com/watch?v={match.group(1)}"
    return None


@router.post("/videos/{video_id}/redownload", response_model=VideoRead)
def redownload_video(
    video_id: int,
    payload: VideoRedownload,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    source_url = _effective_source_url(video)
    if not source_url:
        raise HTTPException(status_code=400, detail="No source URL for this video")

    # Keep existing media until the replacement download completes so playback
    # stays available if the job fails. Old files are removed in _complete_download.
    job = DownloadJob(
        url=source_url,
        quality_preset=payload.quality_preset,
        status=JobStatus.queued,
        title=video.title,
        channel=video.channel,
        title_override=video.title,
        channel_override=video.channel,
        normalize_volume=payload.normalize_volume,
        replace_video_id=video_id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    downloader.enqueue_download(job.id)
    return _to_read(video, session)


def _fetch_thumbnail_from_url(video: Video, url: str) -> None:
    dest = THUMBNAILS_DIR / f"{video.id}.jpg"
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
        video.thumbnail_path = str(dest)
    except (httpx.HTTPError, OSError) as exc:
        raise HTTPException(status_code=400, detail=f"Could not fetch thumbnail: {exc}")


@router.post("/videos/refresh-metadata", response_model=MetadataRefreshResult)
def bulk_refresh_metadata(
    payload: BulkMetadataRefresh,
    session: Session = Depends(get_session),
):
    from ..services.metadata_sync import start_bulk_sync

    # Validate ids exist when provided (start_bulk_sync also filters).
    if payload.video_ids:
        for vid_id in payload.video_ids:
            if session.get(Video, vid_id) is None:
                raise HTTPException(status_code=404, detail=f"Video {vid_id} not found")

    result = start_bulk_sync(payload.video_ids or None, payload.fields or None)
    return MetadataRefreshResult(
        started=bool(result.get("started")),
        detail=str(result.get("detail") or ""),
        total=int(result.get("total") or 0),
        refreshed=0,
        failed=0,
        skipped=0,
    )


@router.get("/videos/refresh-metadata/status", response_model=MetadataSyncStatus)
def metadata_sync_status():
    from ..services.metadata_sync import get_sync_status

    return MetadataSyncStatus(**get_sync_status())


@router.post("/videos/{video_id}/refresh-metadata", response_model=VideoRead)
def refresh_metadata(
    video_id: int,
    session: Session = Depends(get_session),
    fields: Optional[str] = Query(None, description="Comma-separated sync fields"),
):
    from ..services.metadata_sync import refresh_video_metadata

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    field_list = [f.strip() for f in fields.split(",") if f.strip()] if fields else None
    try:
        refresh_video_metadata(video_id, fields=field_list)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Refresh failed: {exc}")
    session.expire_all()
    video = session.get(Video, video_id)
    return _to_read(video, session)


@router.post("/videos/{video_id}/ai/refresh-tags", response_model=VideoRead)
def refresh_video_tags(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    try:
        from ..services.ai.worker import enqueue_video_tag_refresh

        ok = enqueue_video_tag_refresh(video_id)
        if not ok:
            raise HTTPException(status_code=400, detail="Could not queue tag refresh")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_read(video, session)


@router.post("/videos/{video_id}/ai/summarize", response_model=VideoRead)
def summarize_video(
    video_id: int,
    force: bool = Query(False),
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    try:
        from ..services.ai.tasks import SummarizeError, run_summarize

        run_summarize(session, video_id, force=force)
    except SummarizeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    session.expire_all()
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _to_read(video, session)


class VideoAiChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)


@router.get("/videos/{video_id}/ai/chat")
def get_video_ai_chat(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    from ..services.ai import chat as ai_chat

    return {"messages": ai_chat.list_messages(session, video_id)}


@router.delete("/videos/{video_id}/ai/chat")
def delete_video_ai_chat(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    from ..services.ai import chat as ai_chat

    ai_chat.clear_messages(session, video_id)
    return {"ok": True}


@router.post("/videos/{video_id}/ai/chat")
def post_video_ai_chat(
    video_id: int,
    payload: VideoAiChatRequest,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    from ..services.ai import chat as ai_chat

    # Own session: request-scoped session closes before SSE finishes.
    return StreamingResponse(
        ai_chat.stream_chat_events(video_id, payload.message),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/videos/{video_id}/thumbnail", response_model=VideoRead)
async def upload_thumbnail(
    video_id: int,
    file: UploadFile,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    dest = THUMBNAILS_DIR / f"{video_id}.jpg"
    dest.write_bytes(await file.read())
    video.thumbnail_path = str(dest)
    session.add(video)
    session.commit()
    session.refresh(video)
    return _to_read(video, session)


@router.post("/videos/{video_id}/thumbnail/candidates")
def generate_thumbnail_candidates(
    video_id: int,
    count: int = Query(8, ge=1, le=16),
    session: Session = Depends(get_session),
):
    """Extract several frames from the video for the user to pick as thumbnail."""
    from ..services import activity
    from ..services.metadata import generate_thumbnail_candidates as _gen

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    media = _resolve_media(video)
    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
    with activity.track(
        "thumbnail",
        "Generating thumbnail candidates",
        reason="You asked to pick a new thumbnail",
        engine="ffmpeg",
        detail=video.title,
        video_id=video_id,
        total=count,
    ):
        candidates = _gen(
            media,
            THUMBNAILS_DIR,
            video_id,
            count=count,
            duration=video.duration_sec,
        )
    if not candidates:
        raise HTTPException(status_code=400, detail="Could not generate thumbnails")
    return {
        "candidates": [
            {
                "index": c["index"],
                "at_seconds": c["at_seconds"],
                "url": f"/api/videos/{video_id}/thumbnail/candidates/{c['index']}",
            }
            for c in candidates
        ]
    }


@router.get("/videos/{video_id}/thumbnail/candidates/{index}")
def get_thumbnail_candidate(
    video_id: int,
    index: int,
    session: Session = Depends(get_session),
):
    from ..services.metadata import candidate_thumb_path

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    path = candidate_thumb_path(THUMBNAILS_DIR, video_id, index)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Candidate not found")
    return FileResponse(path, media_type="image/jpeg")


@router.post("/videos/{video_id}/thumbnail/candidates/{index}", response_model=VideoRead)
def select_thumbnail_candidate(
    video_id: int,
    index: int,
    session: Session = Depends(get_session),
):
    """Promote a generated candidate frame to the video's thumbnail."""
    import shutil

    from ..services.metadata import candidate_thumb_path

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    src = candidate_thumb_path(THUMBNAILS_DIR, video_id, index)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Candidate not found")
    dest = THUMBNAILS_DIR / f"{video_id}.jpg"
    shutil.copy2(src, dest)
    video.thumbnail_path = str(dest)
    session.add(video)
    session.commit()
    session.refresh(video)
    return _to_read(video, session)


@router.get("/thumbnails/{video_id}")
def get_thumbnail(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None or not video.thumbnail_path:
        raise HTTPException(status_code=404, detail="No thumbnail")
    path = Path(video.thumbnail_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="No thumbnail")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/videos/{video_id}/sprites/meta")
def get_sprite_meta(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    meta = load_sprite_meta(SPRITES_DIR, video_id)
    if meta is None or not sprites_exist(SPRITES_DIR, video_id):
        raise HTTPException(status_code=404, detail="Sprites not ready")
    return meta


@router.get("/videos/{video_id}/sprites")
def get_sprite_sheet(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    path = sprite_image_path(SPRITES_DIR, video_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Sprites not ready")
    return FileResponse(path, media_type="image/jpeg")


@router.post("/videos/{video_id}/sprites/generate")
def generate_sprites(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    status = enqueue_sprite_generation(
        video_id,
        reason="You opened this video in the player",
    )
    return {"status": status}


@router.get("/videos/{video_id}/subtitles/{lang}")
def get_subtitle(video_id: int, lang: str, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    track = next(
        (t for t in library.parse_subtitles(video.subtitles) if t.get("lang") == lang),
        None,
    )
    if track is None:
        raise HTTPException(status_code=404, detail="Subtitle not found")
    path = (DOWNLOADS_DIR / track["path"]).resolve()
    if DOWNLOADS_DIR not in path.parents or not path.exists():
        raise HTTPException(status_code=404, detail="Subtitle file missing")
    return FileResponse(path, media_type="text/vtt")


_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


@router.get("/videos/{video_id}/stream")
def stream_video(
    video_id: int,
    request: Request,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    path = _resolve_media(video)
    ua = request.headers.get("user-agent") or ""
    if apple_webkit_playback(ua):
        remuxed = ensure_safari_mp4(path)
        try:
            new_size = remuxed.stat().st_size
        except OSError:
            new_size = None
        changed = remuxed != path
        if changed:
            try:
                video.file_path = to_rel_path(remuxed)
            except ValueError:
                pass
            else:
                path = remuxed
        if new_size is not None and video.file_size != new_size:
            video.file_size = new_size
            changed = True
        if changed:
            session.add(video)
            session.commit()
        path = remuxed if remuxed.exists() else path

    file_size = path.stat().st_size

    suffix = path.suffix.lower()
    content_type = CONTENT_TYPES.get(suffix, "application/octet-stream")

    range_header = request.headers.get("range")
    if range_header is None:
        return FileResponse(
            path,
            media_type=content_type,
            headers={"Accept-Ranges": "bytes"},
        )

    match = _RANGE_RE.fullmatch(range_header.strip())
    if match is None:
        raise HTTPException(status_code=416, detail="Invalid range")

    start = int(match.group(1)) if match.group(1) else 0
    end = int(match.group(2)) if match.group(2) else file_size - 1
    end = min(end, file_size - 1)
    if start > end:
        raise HTTPException(status_code=416, detail="Range not satisfiable")

    length = end - start + 1

    def iter_file():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Content-Type": content_type,
    }
    return StreamingResponse(iter_file(), status_code=206, headers=headers)


@router.get("/videos/{video_id}/file")
def download_video_file(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    path = _resolve_media(video)
    content_type = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
    filename = f"{_safe_filename(video.title)}{path.suffix.lower()}"
    return FileResponse(path, media_type=content_type, filename=filename)

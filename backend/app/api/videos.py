import re
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlmodel import Session, func, select

from ..config import DOWNLOADS_DIR, THUMBNAILS_DIR
from ..database import get_session
from ..models import DownloadJob, JobStatus, Video, utcnow
from ..schemas import (
    BulkMetadataRefresh,
    BulkVideoDelete,
    BulkVideoNotes,
    ChannelFeedEntry,
    ChannelFeedPage,
    ChannelRename,
    ChannelStat,
    MetadataRefreshResult,
    StorageStats,
    TagStat,
    VideoRead,
    VideoRedownload,
    VideoUpdate,
    WatchProgressUpdate,
)
from ..services import downloader, feed_meta_cache, library

router = APIRouter(prefix="/api", tags=["videos"])

CHUNK_SIZE = 1024 * 1024

CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
}


def _safe_filename(name: str) -> str:
    """Strip characters that break Content-Disposition or filesystems."""
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return cleaned or "video"


def _to_read(video: Video) -> VideoRead:
    return VideoRead(
        id=video.id,
        title=video.title,
        channel=video.channel,
        channel_url=video.channel_url,
        tags=library.parse_tags(video.tags),
        description=video.description,
        notes=video.notes,
        source_url=video.source_url,
        has_thumbnail=bool(video.thumbnail_path and Path(video.thumbnail_path).exists()),
        subtitles=[
            {"lang": t.get("lang"), "auto": t.get("auto", False)}
            for t in library.parse_subtitles(video.subtitles)
        ],
        file_path=video.file_path,
        duration_sec=video.duration_sec,
        file_size=video.file_size,
        width_px=video.width_px,
        height_px=video.height_px,
        frame_rate=video.frame_rate,
        view_count=video.view_count,
        channel_subscriber_count=video.channel_subscriber_count,
        published_at=video.published_at,
        added_at=video.added_at,
        last_position_sec=video.last_position_sec,
        last_watched_at=video.last_watched_at,
        needs_review=video.needs_review,
        platform=video.platform,
        status=video.status,
        metadata_synced_at=video.metadata_synced_at,
        source_title=video.source_title,
        title_is_custom=video.title_is_custom,
        subtitles_pending=video.subtitles_pending,
    )


def _resolve_media(video: Video) -> Path:
    path = (DOWNLOADS_DIR / video.file_path).resolve()
    # Guard against path traversal escaping the downloads root.
    if DOWNLOADS_DIR not in path.parents and path != DOWNLOADS_DIR:
        raise HTTPException(status_code=400, detail="Invalid file path")
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    return path


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
    return [_to_read(v) for v in videos]


@router.get("/channels", response_model=list[ChannelStat])
def list_channels(
    sort: str = Query("recent_download"),
    order: str = Query("desc"),
    session: Session = Depends(get_session),
):
    return [
        ChannelStat(
            channel=row.channel,
            count=row.count,
            last_download_at=row.last_download_at,
            subscriber_count=row.subscriber_count,
            channel_url=row.channel_url,
        )
        for row in library.channel_stats(session, sort=sort, order=order)
    ]


@router.patch("/channels", response_model=dict)
def rename_channel(payload: ChannelRename, session: Session = Depends(get_session)):
    old = payload.old_name.strip()
    new = payload.new_name.strip()
    if not old or not new:
        raise HTTPException(status_code=400, detail="Both names are required")
    updated = library.rename_channel(session, old, new)
    return {"updated": updated}


@router.get("/channels/feed", response_model=ChannelFeedPage)
def channel_feed(
    channel: Optional[str] = None,
    url: Optional[str] = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=100),
    session: Session = Depends(get_session),
):
    channel_url = (url or "").strip() or None
    channel_name = (channel or "").strip() or None
    if not channel_url and channel_name:
        channel_url = library.resolve_channel_url(session, channel_name)
    if not channel_url:
        return ChannelFeedPage(channel=channel_name, channel_url=None, entries=[], has_more=False)
    try:
        data = downloader.fetch_channel_feed(channel_url, offset=offset, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not load channel feed: {exc}"
        ) from exc

    lib_map = library.youtube_library_map(session, channel=channel_name)
    yt_ids = [str(e["id"]) for e in (data.get("entries") or []) if e.get("id")]
    meta_cache = feed_meta_cache.get_many(yt_ids)
    to_cache: list[dict] = []
    entries: list[ChannelFeedEntry] = []
    for raw in data.get("entries") or []:
        yt_id = raw.get("id")
        lib = lib_map.get(yt_id) if yt_id else None
        video_id = lib[0] if lib else None
        library_height = lib[1] if lib else None
        library_views = lib[2] if lib else None
        cached = meta_cache.get(str(yt_id)) if yt_id else None
        feed_views = raw.get("view_count")
        view_count = (
            feed_views
            if feed_views is not None
            else (cached.get("view_count") if cached else None)
        )
        if view_count is None:
            view_count = library_views
        published_at = raw.get("published_at") or (
            cached.get("published_at") if cached else None
        )
        duration = raw.get("duration")
        if duration is None and cached:
            duration = cached.get("duration")
        thumbnail_url = raw.get("thumbnail_url") or (
            cached.get("thumbnail_url") if cached else None
        )
        max_height = cached.get("max_height") if cached else None
        if yt_id and (
            feed_views is not None
            or raw.get("published_at")
            or raw.get("duration")
            or raw.get("thumbnail_url")
        ):
            to_cache.append(
                {
                    "id": yt_id,
                    "view_count": feed_views,
                    "published_at": raw.get("published_at"),
                    "duration": raw.get("duration"),
                    "thumbnail_url": raw.get("thumbnail_url"),
                    "title": raw.get("title"),
                }
            )
        entries.append(
            ChannelFeedEntry(
                id=yt_id,
                url=raw["url"],
                title=raw.get("title")
                or (cached.get("title") if cached else None),
                duration=duration,
                thumbnail_url=thumbnail_url,
                view_count=view_count,
                published_at=published_at,
                in_library=video_id is not None,
                video_id=video_id,
                library_height_px=library_height,
                max_height=int(max_height) if max_height else None,
            )
        )
    if to_cache:
        feed_meta_cache.upsert_many(to_cache)

    # Background-fill missing view counts / dates for a few entries (non-blocking).
    missing = [
        e
        for e in entries
        if e.id and (e.view_count is None or not e.published_at)
    ][:8]
    if missing:

        def _enrich(ids_urls: list[tuple[str, str]]) -> None:
            updates: list[dict] = []
            for yt_id, entry_url in ids_urls:
                try:
                    preview = downloader.extract_preview(entry_url)
                except Exception:  # noqa: BLE001
                    continue
                if preview.get("is_playlist"):
                    continue
                row: dict = {"id": yt_id}
                if preview.get("view_count") is not None:
                    row["view_count"] = preview["view_count"]
                if preview.get("thumbnail_url"):
                    row["thumbnail_url"] = preview["thumbnail_url"]
                # Best-effort published date from a second light extract is expensive;
                # view_count alone already improves the next feed load.
                if len(row) > 1:
                    updates.append(row)
            if updates:
                feed_meta_cache.upsert_many(updates)

        import threading

        threading.Thread(
            target=_enrich,
            args=([(e.id, e.url) for e in missing if e.id]),
            daemon=True,
        ).start()

    return ChannelFeedPage(
        channel=channel_name or data.get("channel"),
        channel_url=data.get("channel_url") or channel_url,
        entries=entries,
        has_more=bool(data.get("has_more")),
    )


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


@router.get("/videos/{video_id}", response_model=VideoRead)
def get_video(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _to_read(video)


@router.get("/videos/{video_id}/related", response_model=list[VideoRead])
def related_videos(
    video_id: int,
    limit: int = Query(6, ge=1, le=24),
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    rows = library.related_videos(session, video_id, limit=limit)
    return [_to_read(v) for v in rows]


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

    tags_edited = False
    if "tags" in data and data["tags"] is not None:
        video.tags = library.dump_tags(data.pop("tags"))
        tags_edited = True
    if "thumbnail_url" in data and data["thumbnail_url"]:
        _fetch_thumbnail_from_url(video, data.pop("thumbnail_url"))
    data.pop("thumbnail_url", None)

    # Track user customizations so metadata resync can preserve them.
    if "title" in data:
        video.title_is_custom = True
    if "description" in data:
        video.description_is_custom = True

    for key, value in data.items():
        setattr(video, key, value)

    was_review = video.needs_review
    # Auto-clear the review flag once the required fields are present.
    if video.needs_review and video.title and video.channel:
        video.needs_review = False

    session.add(video)
    session.commit()
    session.refresh(video)

    if tags_edited:
        try:
            from ..services.ai.embeddings import lock_tags_on_manual_edit

            lock_tags_on_manual_edit(session, video.id)
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

    return _to_read(video)


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

    _delete_media_files(video)

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
    return _to_read(video)


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


@router.post("/videos/refresh-metadata", response_model=MetadataRefreshResult)
def bulk_refresh_metadata(
    payload: BulkMetadataRefresh,
    session: Session = Depends(get_session),
):
    from ..services.metadata_sync import refresh_video_metadata

    if payload.video_ids:
        candidates = [
            session.get(Video, vid_id)
            for vid_id in payload.video_ids
        ]
        videos = [v for v in candidates if v is not None]
    else:
        videos = list(
            session.exec(
                select(Video).where(Video.source_url.is_not(None))  # type: ignore[attr-defined]
            ).all()
        )

    refreshed = 0
    failed = 0
    skipped = 0

    for video in videos:
        if not video.source_url:
            skipped += 1
            continue
        try:
            refresh_video_metadata(video.id)
            refreshed += 1
        except Exception:  # noqa: BLE001
            failed += 1

    return MetadataRefreshResult(
        refreshed=refreshed,
        failed=failed,
        skipped=skipped,
    )


@router.post("/videos/{video_id}/refresh-metadata", response_model=VideoRead)
def refresh_metadata(video_id: int, session: Session = Depends(get_session)):
    from ..services.metadata_sync import refresh_video_metadata

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    try:
        refresh_video_metadata(video_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Refresh failed: {exc}")
    session.expire_all()
    video = session.get(Video, video_id)
    return _to_read(video)


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
    return _to_read(video)


@router.get("/thumbnails/{video_id}")
def get_thumbnail(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None or not video.thumbnail_path:
        raise HTTPException(status_code=404, detail="No thumbnail")
    path = Path(video.thumbnail_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="No thumbnail")
    return FileResponse(path, media_type="image/jpeg")


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
    file_size = path.stat().st_size

    suffix = path.suffix.lower()
    content_type = CONTENT_TYPES.get(suffix, "application/octet-stream")

    range_header = request.headers.get("range")
    if range_header is None:
        return FileResponse(path, media_type=content_type)

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

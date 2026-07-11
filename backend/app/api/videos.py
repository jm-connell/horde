import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlmodel import Session, func, select

from ..config import DOWNLOADS_DIR, THUMBNAILS_DIR
from ..database import get_session
from ..models import DownloadJob, JobStatus, Video, VideoAiMeta, utcnow
from ..schemas import (
    BulkMetadataRefresh,
    BulkVideoDelete,
    BulkVideoNotes,
    ChannelCatalogIndexRequest,
    ChannelCatalogIndexResult,
    ChannelCatalogStatusResponse,
    ChannelFeedEntry,
    ChannelFeedPage,
    ChannelRename,
    ChannelSearchResponse,
    ChannelSearchHit,
    ChannelStat,
    MetadataRefreshResult,
    MetadataSyncStatus,
    StorageStats,
    TagStat,
    VideoRead,
    VideoRedownload,
    VideoUpdate,
    WatchProgressUpdate,
)
from ..services import channel_catalog, downloader, feed_meta_cache, library
from ..services import app_settings as app_settings_svc
from ..services.paths import (
    is_manual_import,
    manual_import_rel_path,
    rename_video_file,
)

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


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Ensure datetimes are timezone-aware UTC so JSON includes a Z offset."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _to_read(video: Video, session: Optional[Session] = None) -> VideoRead:
    ai_tags: list[str] = []
    user_tags: list[str] = []
    if session is not None and video.id is not None:
        meta = session.get(VideoAiMeta, video.id)
        if meta is not None:
            if meta.ai_tags:
                ai_tags = library.parse_tags(meta.ai_tags)
            if getattr(meta, "user_tags", None):
                user_tags = library.parse_tags(meta.user_tags)
    return VideoRead(
        id=video.id,
        title=video.title,
        channel=video.channel,
        channel_url=video.channel_url,
        tags=library.parse_tags(video.tags),
        ai_tags=ai_tags,
        user_tags=user_tags,
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
        published_at=_as_utc(video.published_at),
        added_at=_as_utc(video.added_at) or video.added_at,
        last_position_sec=video.last_position_sec,
        last_watched_at=_as_utc(video.last_watched_at),
        needs_review=video.needs_review,
        platform=video.platform,
        status=video.status,
        metadata_synced_at=_as_utc(video.metadata_synced_at),
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
    return [_to_read(v, session) for v in videos]


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


@router.get("/channels/search", response_model=ChannelSearchResponse)
def search_channels(
    q: str = Query(..., min_length=1),
    limit: int = Query(8, ge=1, le=20),
):
    hits = downloader.search_youtube_channels(q, limit=limit)
    return ChannelSearchResponse(
        results=[ChannelSearchHit(**h) for h in hits]
    )


@router.get("/channels/catalog/status", response_model=ChannelCatalogStatusResponse)
def channel_catalog_status():
    return ChannelCatalogStatusResponse(**channel_catalog.get_runtime_status())


@router.post("/channels/catalog/index", response_model=ChannelCatalogIndexResult)
def channel_catalog_index(
    payload: ChannelCatalogIndexRequest,
    session: Session = Depends(get_session),
):
    """Manually queue catalog indexing for one channel (or all library channels)."""
    if not app_settings_svc.load().get("channel_catalog_enabled", True):
        raise HTTPException(
            status_code=400, detail="Channel catalog indexing is disabled"
        )

    channel_url = (payload.url or "").strip() or None
    channel_name = (payload.channel or "").strip() or None

    # No channel specified → index every library channel with a URL.
    if not channel_url and not channel_name:
        result = channel_catalog.enqueue_all_library_channels(force=payload.force)
        return ChannelCatalogIndexResult(**result)

    if not channel_url and channel_name:
        channel_url = library.resolve_channel_url(session, channel_name)
    if not channel_url:
        raise HTTPException(
            status_code=400,
            detail="No YouTube channel URL known for this channel",
        )

    catalog_id = channel_catalog.enqueue_channel(
        channel_url,
        channel_name=channel_name,
        force=payload.force,
    )
    if catalog_id is None:
        return ChannelCatalogIndexResult(
            queued=0,
            skipped=1,
            detail="Could not queue channel (disabled or unsupported URL)",
        )
    return ChannelCatalogIndexResult(
        queued=1,
        catalog_id=catalog_id,
        detail=f"Queued indexing for {channel_name or channel_url}",
    )


@router.get("/channels/catalog/search", response_model=ChannelFeedPage)
def channel_catalog_search(
    q: str = Query(..., min_length=1),
    channel: Optional[str] = None,
    url: Optional[str] = None,
    limit: int = Query(60, ge=1, le=200),
    session: Session = Depends(get_session),
):
    channel_url = (url or "").strip() or None
    channel_name = (channel or "").strip() or None
    if not channel_url and channel_name:
        channel_url = library.resolve_channel_url(session, channel_name)
    if not channel_url:
        return ChannelFeedPage(channel=channel_name, channel_url=None, entries=[], has_more=False)
    raw_entries = channel_catalog.search_catalog(
        session, channel_url, q, limit=limit
    )
    lib_map = library.youtube_library_map(session, channel=channel_name)
    entries: list[ChannelFeedEntry] = []
    for raw in raw_entries:
        yt_id = raw.get("id")
        lib = lib_map.get(yt_id) if yt_id else None
        video_id = lib[0] if lib else None
        library_height = lib[1] if lib else None
        entries.append(
            ChannelFeedEntry(
                id=yt_id,
                url=raw["url"],
                title=raw.get("title"),
                duration=raw.get("duration"),
                thumbnail_url=raw.get("thumbnail_url"),
                view_count=raw.get("view_count"),
                published_at=raw.get("published_at"),
                in_library=video_id is not None,
                video_id=video_id,
                library_height_px=library_height,
            )
        )
    return ChannelFeedPage(
        channel=channel_name,
        channel_url=channel_url,
        entries=entries,
        has_more=False,
        from_catalog=True,
    )


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

    # Kick off / refresh catalog in the background without blocking the response.
    try:
        channel_catalog.maybe_enqueue_for_feed(
            channel_url, channel_name=channel_name
        )
    except Exception:  # noqa: BLE001
        pass

    data = channel_catalog.catalog_feed_page(
        session, channel_url, offset=offset, limit=limit
    )
    from_catalog = bool(data and data.get("from_catalog"))
    indexing = bool(data and data.get("indexing"))

    if data is None:
        try:
            data = downloader.fetch_channel_feed(channel_url, offset=offset, limit=limit)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=400, detail=f"Could not load channel feed: {exc}"
            ) from exc
        from_catalog = False
        indexing = False

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
    if to_cache and not from_catalog:
        feed_meta_cache.upsert_many(to_cache)

    # Background-fill missing view counts / dates for a few entries (non-blocking).
    if not from_catalog:
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
                    if len(row) > 1:
                        updates.append(row)
                if updates:
                    feed_meta_cache.upsert_many(updates)

            import threading

            threading.Thread(
                target=_enrich,
                args=([(e.id, e.url) for e in missing if e.id],),
                daemon=True,
            ).start()

    progress = channel_catalog.catalog_progress(session, channel_url)
    # Prefer live page flags when serving from catalog mid-index.
    if from_catalog:
        indexing = indexing or bool(progress.get("indexing"))
    else:
        indexing = bool(progress.get("indexing"))

    return ChannelFeedPage(
        channel=channel_name or data.get("channel"),
        channel_url=data.get("channel_url") or channel_url,
        entries=entries,
        has_more=bool(data.get("has_more")),
        indexing=indexing,
        from_catalog=from_catalog,
        catalog_indexed=int(
            data.get("catalog_indexed")
            if data.get("catalog_indexed") is not None
            else progress.get("catalog_indexed")
            or 0
        ),
        catalog_total=(
            data.get("catalog_total")
            if data.get("catalog_total") is not None
            else progress.get("catalog_total")
        ),
        catalog_complete=bool(
            data.get("catalog_complete")
            if data.get("catalog_complete") is not None
            else progress.get("catalog_complete")
        ),
        catalog_status=(
            data.get("catalog_status")
            if data.get("catalog_status") is not None
            else progress.get("catalog_status")
        ),
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
    return _to_read(video, session)


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
    from ..services.metadata import generate_thumbnail_candidates as _gen

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    media = _resolve_media(video)
    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
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

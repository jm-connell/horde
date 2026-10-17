import bisect
import logging
import re
from pathlib import Path
from typing import TypedDict

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, col, func, select

from ..auth import StreamAuthGuard, current_user, require_admin, require_permission
from ..context import get_paths, get_session
from ..models import DownloadJob, JobStatus, User, Video, require_id
from ..openapi_responses import (
    EVENT_STREAM,
    FILE_DOWNLOAD,
    IMAGE_JPEG,
    RAW,
    SUBTITLES,
    VIDEO_STREAM,
)
from ..response_schemas import (
    OkResponse,
    SpriteGenerateResult,
    SpriteMetaRead,
    TagPage,
    TagStatPage,
    ThumbnailCandidates,
    VideoAiChatHistory,
    VideoPage,
)
from ..schemas import (
    BulkMetadataRefresh,
    BulkVideoDelete,
    BulkVideoNotes,
    MediaTokenRead,
    MetadataRefreshResult,
    MetadataSyncStatus,
    StorageStats,
    TagStat,
    VideoRead,
    VideoRedownload,
    VideoUpdate,
    WatchProgressUpdate,
)
from ..services import library, uploads, user_state
from ..services.ai.provider import format_provider_error
from ..services.auth import media_token as media_token_svc
from ..services.auth.accounts import AuthUser
from ..services.downloads import jobs as download_jobs
from ..services.limits import ConcurrencyLimit, thumbnail_grab_limit
from ..services.metadata import (
    load_sprite_meta,
    sprite_image_path,
    sprites_exist,
)
from ..services.pagination import (
    InvalidCursor,
    PageRequest,
    keyset_cursor,
    offset_cursor,
    parse_cursor,
)
from ..services.paths import (
    is_manual_import,
    manual_import_rel_path,
    rename_video_file,
    resolve_compat_path,
)
from ..services.search_cache import library_fingerprint
from ..services.sprites import enqueue_sprite_generation
from ..services.thumbnails import (
    copy_full,
    ensure_list_thumbnail,
    resolve_thumbnail_file,
    save_from_url,
    write_full_bytes,
)
from ..services.url_safety import validate_public_url
from ..services.video_delete import delete_video_cascade, remove_files
from ..services.ytdlp_formats import default_download_video_codec, normalize_video_codec
from .video_page import DEFAULT_LIMIT, MAX_LIMIT, build_page, page_request
from .video_serialize import (
    resolve_media as _resolve_media,
)
from .video_serialize import (
    safe_filename as _safe_filename,
)
from .video_serialize import (
    to_read as _to_read,
)
from .video_serialize import (
    to_read_many as _to_read_many,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["videos"])


class _Paging(TypedDict):
    """The keyword arguments ``build_page`` takes from the list endpoint."""

    page: PageRequest
    sort: str
    order: str
    seed: int | None
    session: Session
    user_id: int


class _Filters(TypedDict):
    """The keyword arguments ``library.query_videos`` takes from the list endpoint."""

    q: str | None
    channel: str | None
    tag: str | None
    sort: str
    order: str
    needs_review: bool
    continue_watching: bool
    watched_only: bool
    seed: int | None
    user_id: int


CHUNK_SIZE = 1024 * 1024

CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
}


@router.get("/videos", response_model=VideoPage)
def list_videos(
    request: Request,
    q: str | None = None,
    channel: str | None = None,
    tag: str | None = None,
    sort: str = Query("added_at"),
    order: str = Query("desc"),
    continue_watching: bool = False,
    watched_only: bool = False,
    seed: int | None = None,
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    cursor: str | None = None,
    include_total: bool = False,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """One page of the library. Follow ``next_cursor`` until it is null.

    ``continue_watching`` is a fixed short shelf and is never paged.
    """
    # Expiry is a write; it now runs on a background tick, not this read path.
    page, seed = page_request(
        cursor,
        limit=MAX_LIMIT if continue_watching else limit,
        sort=sort,
        order=order,
        seed=seed,
        searching=bool(q and not continue_watching and not watched_only),
    )
    paging = _Paging(
        page=page, sort=sort, order=order, seed=seed, session=session, user_id=user.id
    )
    if q and not continue_watching and not watched_only:
        from ..services.ai import embeddings
        from ..services.ai.provider import resolve_embed_model
        from ..services.ai.search import explain_library_video, hybrid_search

        cache = request.app.state.search_cache
        # Embedding the query can cost money: only members allowed AI get it.
        semantic = user.can("use_ai")
        # The ranking is the same for every user, so they share an entry.
        key = (q.strip(), channel, tag, sort, order, seed, semantic)

        def rank() -> tuple[list[int], dict[int, int]]:
            found, found_chunks = hybrid_search(
                session,
                q,
                channel=channel,
                tag=tag,
                sort=sort,
                order=order,
                needs_review=False,
                seed=seed,
                user_id=user.id,
                semantic=semantic,
                embed_query=lambda text: cache.query_vector(
                    (text.strip(), resolve_embed_model()),
                    lambda: embeddings.embed_query(text),
                ),
            )
            return [v.id for v in found if v.id is not None], found_chunks

        if sort == "last_watched_at":
            # Ordered by the caller's watch history, which changes with every
            # play and is not part of the cache's invalidation: rank afresh.
            ranked_ids, chunks = rank()
        else:
            ranked_ids, chunks = cache.ranking(
                key, lambda: library_fingerprint(session), rank
            )
        window_ids = ranked_ids[page.offset : page.offset + page.fetch]
        by_id = {
            v.id: v
            for v in session.exec(
                select(Video).where(col(Video.id).in_(window_ids))
            ).all()
        }
        # A video deleted since the ranking was cached drops out of the page.
        videos = [by_id[i] for i in window_ids if i in by_id]

        def serialize_hits(rows, states):
            return [
                _to_read(
                    v,
                    session,
                    viewer=user,
                    states=states,
                    compact=True,
                    match_reason=explain_library_video(
                        v, q, chunk_index=chunks.get(v.id) if v.id is not None else None
                    ),
                )
                for v in rows
            ]

        # Ranked in Python, so the cursor is a position in that ranking.
        return build_page(
            videos,
            serialize=serialize_hits,
            total=len(ranked_ids) if include_total else None,
            keyset=False,
            **paging,
        )
    filters = _Filters(
        q=q,
        channel=channel,
        tag=tag,
        sort=sort,
        order=order,
        needs_review=False,
        continue_watching=continue_watching,
        watched_only=watched_only,
        seed=seed,
        user_id=user.id,
    )
    videos = library.query_videos(session, page=page, **filters)
    total = None
    if include_total and not continue_watching:
        total = library.query_videos(session, count_only=True, **filters)
    return build_page(
        videos,
        serialize=lambda rows, states: _to_read_many(
            rows, session, viewer=user, states=states, compact=True
        ),
        total=total,
        **paging,
    )


@router.get("/tags", response_model=TagPage)
def list_tags(
    limit: int = Query(1000, ge=1, le=5000),
    cursor: str | None = None,
    session: Session = Depends(get_session),
):
    """Every tag, alphabetically, ``limit`` at a time (keyset on the tag itself)."""
    page = _tag_page_request(cursor, limit, sort="tags", kind="keyset")
    tags = library.all_tags(session)
    if page.has_position:
        if not isinstance(page.value, str):
            raise HTTPException(status_code=400, detail="Invalid cursor")
        tags = tags[bisect.bisect_right(tags, page.value) :]
    window = tags[: page.limit]
    more = len(tags) > page.limit
    return TagPage(
        items=window,
        next_cursor=keyset_cursor(sort="tags", order="asc", value=window[-1], last_id=0)
        if more
        else None,
    )


@router.get("/tags/stats", response_model=TagStatPage)
def tag_stats(
    channel: str | None = None,
    limit: int = Query(500, ge=1, le=2000),
    cursor: str | None = None,
    session: Session = Depends(get_session),
):
    """Tags with their video counts, most common first, ``limit`` at a time."""
    page = _tag_page_request(cursor, limit, sort="tagstats", kind="offset")
    ranked = library.tag_stats(session, channel=channel)
    window = ranked[page.offset : page.offset + page.limit]
    more = len(ranked) > page.offset + page.limit
    return TagStatPage(
        items=[TagStat(tag=t, count=n) for t, n in window],
        next_cursor=offset_cursor(
            sort="tagstats", order="asc", offset=page.offset + page.limit
        )
        if more
        else None,
    )


def _tag_page_request(cursor: str | None, limit: int, *, sort: str, kind):
    try:
        return parse_cursor(cursor, limit=limit, sort=sort, order="asc", kind=kind)
    except InvalidCursor as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/stats/storage", response_model=StorageStats)
def storage_stats(session: Session = Depends(get_session)):
    video_bytes = session.exec(
        select(func.coalesce(func.sum(col(Video.file_size)), 0)).where(
            Video.needs_review == False  # noqa: E712 - SQL column comparison, not a Python truth test
        )
    ).one()
    video_count = session.exec(
        select(func.count(col(Video.id))).where(col(Video.needs_review) == False)  # noqa: E712 - SQL column comparison, not a Python truth test
    ).one()
    compat_bytes = session.exec(
        select(func.coalesce(func.sum(Video.compat_size), 0)).where(
            Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
            Video.compat_path != None,  # noqa: E711 - SQL column comparison, not a Python truth test
        )
    ).one()
    thumbnail_bytes = 0
    if get_paths().thumbnails.exists():
        thumbnail_bytes = sum(
            f.stat().st_size for f in get_paths().thumbnails.glob("*") if f.is_file()
        )
    return StorageStats(
        total_bytes=int(video_bytes or 0) + int(compat_bytes or 0) + thumbnail_bytes,
        video_bytes=int(video_bytes or 0),
        compat_bytes=int(compat_bytes or 0),
        thumbnail_bytes=thumbnail_bytes,
        video_count=int(video_count or 0),
    )


# Static /videos/... paths must be registered before /videos/{video_id}
# or FastAPI treats the last segment as an int and returns 422.
@router.post(
    "/videos/bulk-delete",
    status_code=204,
    dependencies=[Depends(require_permission("delete_videos"))],
)
def bulk_delete_videos(
    payload: BulkVideoDelete,
    session: Session = Depends(get_session),
):
    doomed: list[Path] = []
    for vid_id in payload.video_ids:
        video = session.get(Video, vid_id)
        if video is None:
            continue
        doomed += delete_video_cascade(
            session, video, payload.delete_files, commit=False
        )
    session.commit()
    remove_files(doomed)
    return Response(status_code=204)


@router.patch(
    "/videos/bulk-notes",
    status_code=204,
    dependencies=[Depends(require_permission("edit_metadata"))],
)
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
def get_video(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _to_read(video, session, viewer=user, include_processing=True)


@router.get("/videos/{video_id}/related", response_model=list[VideoRead])
def related_videos(
    video_id: int,
    limit: int = Query(8, ge=1, le=24),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    rows = library.related_videos(session, video_id, limit=limit, offset=offset)
    return _to_read_many(rows, session, viewer=user, compact=True)


@router.patch(
    "/videos/{video_id}",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("edit_metadata"))],
)
def update_video(
    video_id: int,
    payload: VideoUpdate,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
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
        if (
            video.source_description is not None
            and new_desc == video.source_description
        ):
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
                require_id(video),
                user_tag=user_tag if isinstance(user_tag, str) else None,
            )
            session.commit()
        except Exception:
            logger.warning(
                "could not record tag provenance for video %s",
                video.id,
                exc_info=True,
            )

    # After leaving review, queue AI enrichment for scanner-ingested files.
    if was_review and not video.needs_review and video.id is not None:
        try:
            from ..services.ai import enqueue_for_video

            enqueue_for_video(video.id, include_tags=True, force=False)
        except Exception:
            logger.warning(
                "could not queue AI enrichment for video %s",
                video.id,
                exc_info=True,
            )

    return _to_read(video, session, viewer=user)


@router.patch("/videos/{video_id}/progress", status_code=204)
def update_progress(
    video_id: int,
    payload: WatchProgressUpdate,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    # Treat the first few seconds as "not started" so brief opens don't clutter
    # the Continue watching row. A reset to 0 (on finish) is always honored.
    # Near-complete watches (>=90%) are treated as finished — clear progress.
    position = max(0.0, payload.position_sec)
    duration = video.duration_sec
    if duration and duration > 0 and position > 0 and position >= duration * 0.9:
        position = 0.0
    if position >= 5 or position == 0:
        user_state.record_progress(
            session, user.id, video_id, position, payload.watched_at
        )
    return Response(status_code=204)


@router.delete(
    "/videos/{video_id}",
    status_code=204,
    dependencies=[Depends(require_permission("delete_videos"))],
)
def delete_video(
    video_id: int,
    delete_file: bool = False,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    delete_video_cascade(session, video, delete_file)
    return Response(status_code=204)


def _effective_source_url(video: Video) -> str | None:
    if video.source_url and video.source_url.strip():
        return video.source_url.strip()
    match = re.search(r"\[([A-Za-z0-9_-]{11})\]", video.file_path)
    if match:
        return f"https://www.youtube.com/watch?v={match.group(1)}"
    return None


@router.post(
    "/videos/{video_id}/redownload",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("download"))],
)
def redownload_video(
    video_id: int,
    payload: VideoRedownload,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
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
        video_codec=normalize_video_codec(
            payload.video_codec or default_download_video_codec()
        ),
        replace_video_id=video_id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    download_jobs.enqueue_download(require_id(job))
    return _to_read(video, session, viewer=user)


def _fetch_thumbnail_from_url(video: Video, url: str) -> None:
    from ..services.ytdlp_extract import list_thumbnail_url

    if video.id is None:
        raise HTTPException(status_code=400, detail="Could not fetch thumbnail")
    validate_public_url(url)  # 400 with the reason instead of a generic failure
    dest = save_from_url(url, video.id, list_url=list_thumbnail_url({"thumbnail": url}))
    if dest is None:
        raise HTTPException(status_code=400, detail="Could not fetch thumbnail")
    video.thumbnail_path = dest


@router.post(
    "/videos/refresh-metadata",
    response_model=MetadataRefreshResult,
    dependencies=[Depends(require_admin)],
)
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


@router.get(
    "/videos/refresh-metadata/status",
    response_model=MetadataSyncStatus,
    dependencies=[Depends(require_admin)],
)
def metadata_sync_status():
    """Progress of the library-wide metadata refresh (raw errors included)."""
    from ..services.metadata_sync import get_sync_status

    return MetadataSyncStatus(**get_sync_status())


@router.post(
    "/videos/{video_id}/refresh-metadata",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("edit_metadata"))],
)
def refresh_metadata(
    video_id: int,
    session: Session = Depends(get_session),
    fields: str | None = Query(None, description="Comma-separated sync fields"),
    user: AuthUser = Depends(current_user),
):
    from ..services.metadata_sync import refresh_video_metadata

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    field_list = [f.strip() for f in fields.split(",") if f.strip()] if fields else None
    try:
        refresh_video_metadata(video_id, fields=field_list)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Refresh failed: {exc}") from exc
    session.expire_all()
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _to_read(video, session, viewer=user)


@router.post(
    "/videos/{video_id}/ai/refresh-tags",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("use_ai"))],
)
def refresh_video_tags(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
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
    except Exception as exc:
        logger.warning("tag refresh failed video_id=%s", video_id, exc_info=True)
        raise HTTPException(status_code=400, detail=format_provider_error(exc)) from exc
    return _to_read(video, session, viewer=user)


@router.post(
    "/videos/{video_id}/ai/summarize",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("use_ai"))],
)
def summarize_video(
    video_id: int,
    force: bool = Query(False),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
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
    except Exception as exc:
        # Not str(exc): an httpx error quotes the provider URL.
        logger.warning("AI request failed video_id=%s", video_id, exc_info=True)
        raise HTTPException(status_code=502, detail=format_provider_error(exc)) from exc
    session.expire_all()
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _to_read(video, session, viewer=user, include_processing=True)


@router.post(
    "/videos/{video_id}/ai/chapters",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("use_ai"))],
)
def generate_video_chapters(
    video_id: int,
    force: bool = Query(False),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    try:
        from ..services.ai.tasks import ChaptersError, run_chapters

        run_chapters(session, video_id, force=force)
    except ChaptersError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # Not str(exc): an httpx error quotes the provider URL.
        logger.warning("AI request failed video_id=%s", video_id, exc_info=True)
        raise HTTPException(status_code=502, detail=format_provider_error(exc)) from exc
    session.expire_all()
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return _to_read(video, session, viewer=user, include_processing=True)


class VideoAiChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)


@router.get(
    "/videos/{video_id}/ai/chat",
    response_model=VideoAiChatHistory,
    dependencies=[Depends(require_permission("use_ai"))],
)
def get_video_ai_chat(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    from ..services.ai import chat as ai_chat

    return {"messages": ai_chat.list_messages(session, video_id, user.id)}


@router.delete(
    "/videos/{video_id}/ai/chat",
    response_model=OkResponse,
    dependencies=[Depends(require_permission("use_ai"))],
)
def delete_video_ai_chat(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    from ..services.ai import chat as ai_chat

    ai_chat.clear_messages(session, video_id, user.id)
    return {"ok": True}


@router.post(
    "/videos/{video_id}/ai/chat",
    response_class=RAW,
    responses=EVENT_STREAM,
    dependencies=[Depends(require_permission("use_ai"))],
)
def post_video_ai_chat(
    request: Request,
    video_id: int,
    payload: VideoAiChatRequest,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    from ..services.ai import chat as ai_chat

    # Own session: request-scoped session closes before SSE finishes.
    return StreamingResponse(
        ai_chat.stream_chat_events(
            video_id,
            payload.message,
            user.id,
            StreamAuthGuard.of(request).still_valid,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/videos/{video_id}/thumbnail",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("edit_metadata"))],
)
def upload_thumbnail(
    video_id: int,
    file: UploadFile,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    data = uploads.read_upload_bytes(file, uploads.IMAGE_MAX_BYTES)
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    try:
        dest = write_full_bytes(video_id, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Could not read image") from exc
    video.thumbnail_path = dest
    session.add(video)
    session.commit()
    session.refresh(video)
    return _to_read(video, session, viewer=user)


@router.post(
    "/videos/{video_id}/thumbnail/candidates",
    response_model=ThumbnailCandidates,
    dependencies=[Depends(require_permission("edit_metadata"))],
)
def generate_thumbnail_candidates(
    video_id: int,
    count: int = Query(8, ge=1, le=16),
    session: Session = Depends(get_session),
    grab_limit: ConcurrencyLimit = Depends(thumbnail_grab_limit),
):
    """Extract several frames from the video for the user to pick as thumbnail."""
    from ..services import activity
    from ..services.metadata import generate_thumbnail_candidates as _gen

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    media = _resolve_media(video)
    get_paths().thumbnails.mkdir(parents=True, exist_ok=True)
    with (
        grab_limit.slot(),
        activity.track(
            "thumbnail",
            "Generating thumbnail candidates",
            reason="You asked to pick a new thumbnail",
            engine="ffmpeg",
            detail=video.title,
            video_id=video_id,
            total=count,
        ),
    ):
        candidates = _gen(
            media,
            get_paths().thumbnails,
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


@router.get(
    "/videos/{video_id}/thumbnail/candidates/{index}",
    response_class=RAW,
    responses=IMAGE_JPEG,
)
def get_thumbnail_candidate(
    video_id: int,
    index: int,
    session: Session = Depends(get_session),
):
    from ..services.metadata import candidate_thumb_path

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    path = candidate_thumb_path(get_paths().thumbnails, video_id, index)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Candidate not found")
    return FileResponse(path, media_type="image/jpeg")


@router.post(
    "/videos/{video_id}/thumbnail/candidates/{index}",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("edit_metadata"))],
)
def select_thumbnail_candidate(
    video_id: int,
    index: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Promote a generated candidate frame to the video's thumbnail."""
    from ..services.metadata import candidate_thumb_path

    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    src = candidate_thumb_path(get_paths().thumbnails, video_id, index)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Candidate not found")
    dest = copy_full(src, video_id)
    video.thumbnail_path = dest
    session.add(video)
    session.commit()
    session.refresh(video)
    return _to_read(video, session, viewer=user)


@router.get("/thumbnails/{video_id}", response_class=RAW, responses=IMAGE_JPEG)
def get_thumbnail(
    video_id: int,
    size: str | None = Query(None),
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None or not video.thumbnail_path:
        raise HTTPException(status_code=404, detail="No thumbnail")
    path = resolve_thumbnail_file(video.thumbnail_path)
    if path is None:
        raise HTTPException(status_code=404, detail="No thumbnail")
    if size == "sm":
        sm = ensure_list_thumbnail(video_id, path)
        if sm is not None:
            path = sm
    elif size not in (None, ""):
        raise HTTPException(status_code=400, detail="Unknown thumbnail size")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/videos/{video_id}/sprites/meta", response_model=SpriteMetaRead)
def get_sprite_meta(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    meta = load_sprite_meta(get_paths().sprites, video_id)
    if meta is None or not sprites_exist(get_paths().sprites, video_id):
        raise HTTPException(status_code=404, detail="Sprites not ready")
    return meta


@router.get("/videos/{video_id}/sprites", response_class=RAW, responses=IMAGE_JPEG)
def get_sprite_sheet(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    path = sprite_image_path(get_paths().sprites, video_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Sprites not ready")
    return FileResponse(path, media_type="image/jpeg")


@router.post("/videos/{video_id}/sprites/generate", response_model=SpriteGenerateResult)
def generate_sprites(video_id: int, session: Session = Depends(get_session)):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    status = enqueue_sprite_generation(
        video_id,
        reason="You opened this video in the player",
    )
    return {"status": status}


@router.get(
    "/videos/{video_id}/subtitles/{lang}", response_class=RAW, responses=SUBTITLES
)
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
    path = (get_paths().downloads / track["path"]).resolve()
    if get_paths().downloads not in path.parents or not path.exists():
        raise HTTPException(status_code=404, detail="Subtitle file missing")
    return FileResponse(path, media_type="text/vtt")


_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def _resolve_rendition(video: Video, rendition: str | None) -> Path | None:
    """Sidecar path for ``rendition=compat``; None means serve the original."""
    if rendition in (None, "", "original"):
        return None
    if rendition != "compat":
        raise HTTPException(status_code=400, detail="Unknown rendition")
    path = resolve_compat_path(video)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="compat_unavailable")
    return path


@router.get("/videos/{video_id}/stream", response_class=RAW, responses=VIDEO_STREAM)
def stream_video(
    video_id: int,
    request: Request,
    rendition: str | None = None,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    compat = _resolve_rendition(video, rendition)
    path = compat or _resolve_media(video)
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

    first, last = match.group(1), match.group(2)
    if not first and not last:
        raise HTTPException(status_code=416, detail="Invalid range")
    if not first:
        # Suffix range "-N": the last N bytes (all of them when N > size).
        suffix_len = int(last)
        if suffix_len == 0 or file_size == 0:
            raise HTTPException(status_code=416, detail="Range not satisfiable")
        start = max(0, file_size - suffix_len)
        end = file_size - 1
    else:
        start = int(first)
        end = min(int(last), file_size - 1) if last else file_size - 1
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


@router.get("/videos/{video_id}/media-token", response_model=MediaTokenRead)
def media_token(
    video_id: int,
    request: Request,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """A 12 hour signed token for ``?mt=`` on the stream, subtitle and thumbnail URLs.

    Cast and AirPlay receivers fetch media themselves and send no cookie.
    """
    if session.get(Video, video_id) is None:
        raise HTTPException(status_code=404, detail="Video not found")
    row = session.get(User, user.id)
    if row is None:
        raise HTTPException(status_code=401, detail="Sign in to continue")
    token, expires_at = media_token_svc.sign(
        request.app.state.auth.secret(),
        video_id,
        user.id,
        media_token_svc.token_epoch(row.password_hash),
    )
    return MediaTokenRead(token=token, expires_at=expires_at)


@router.get(
    "/videos/{video_id}/file",
    response_class=RAW,
    responses=FILE_DOWNLOAD,
    dependencies=[Depends(require_permission("offline_download"))],
)
def download_video_file(
    video_id: int,
    rendition: str | None = None,
    session: Session = Depends(get_session),
):
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    compat = _resolve_rendition(video, rendition)
    path = compat or _resolve_media(video)
    content_type = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
    tag = " (H.264)" if compat is not None else ""
    filename = f"{_safe_filename(video.title)}{tag}{path.suffix.lower()}"
    return FileResponse(path, media_type=content_type, filename=filename)

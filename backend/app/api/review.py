import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, col, select

from ..auth import current_user, require_permission
from ..config import VIDEO_EXTENSIONS
from ..context import get_paths, get_session
from ..models import Video
from ..response_schemas import VideoPage
from ..schemas import VideoRead
from ..services import duplicate_groups as duplicate_groups_svc
from ..services import library, uploads
from ..services.auth.accounts import AuthUser
from ..services.metadata import probe_is_playable
from ..services.pagination import InvalidCursor, offset_cursor, parse_cursor
from ..services.paths import find_video_by_path, safe_filename, unique_rel_path
from ..services.scanner import (
    ingest_media_file,
    mark_active,
    scan_for_new_files,
    unmark_active,
)
from .video_page import DEFAULT_LIMIT, MAX_LIMIT, build_page, page_request
from .video_serialize import to_read as _to_read
from .video_serialize import to_read_many as _to_read_many

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/review", tags=["review"])


class DuplicateGroupRead(BaseModel):
    videos: list[VideoRead]
    match_type: str  # youtube_id | heuristic
    ai_score: float | None = None
    ai_verdict: str | None = None
    ai_confidence: float | None = None
    ai_reason: str | None = None
    ai_error: str | None = None


class ScanResult(BaseModel):
    added: int
    requeued: int


@router.get("", response_model=VideoPage)
def review_queue(
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    cursor: str | None = None,
    include_total: bool = False,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """One page of videos waiting for review, newest first."""
    sort, order = "added_at", "desc"
    page, _ = page_request(cursor, limit=limit, sort=sort, order=order, seed=None)
    videos = library.query_videos(
        session, needs_review=True, sort=sort, order=order, page=page
    )
    total = (
        library.query_videos(
            session, needs_review=True, sort=sort, order=order, count_only=True
        )
        if include_total
        else None
    )
    return build_page(
        videos,
        page,
        sort=sort,
        order=order,
        seed=None,
        session=session,
        user_id=user.id,
        serialize=lambda rows, states: _to_read_many(
            rows, session, user_id=user.id, states=states
        ),
        total=total,
    )


@router.post(
    "/scan",
    response_model=ScanResult,
    dependencies=[Depends(require_permission("download"))],
)
def scan_import_folder():
    """Rescan the media folder and queue videos that are not in the library.

    Also returns skipped manual imports (removed from the queue without a
    channel) to review. The background poller does not undo Skip.
    """
    added, requeued = scan_for_new_files()
    return ScanResult(added=added, requeued=requeued)


@router.post(
    "/upload",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("download"))],
)
def upload_import(
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Stream a video into DOWNLOADS_DIR/imports and add it to the review queue."""
    name = Path(file.filename or "upload.bin").name
    ext = Path(name).suffix.lower()
    if ext not in VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported type. Use {', '.join(sorted(VIDEO_EXTENSIONS))}.",
        )

    stem = safe_filename(Path(name).stem)
    desired = f"imports/{stem}{ext}"
    rel_path = unique_rel_path(desired)
    root = get_paths().downloads.resolve()
    dest = (root / rel_path).resolve()
    try:
        dest.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid path") from exc

    if find_video_by_path(session, rel_path) is not None:
        raise HTTPException(status_code=409, detail="File already in library")

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    mark_active(rel_path)
    try:
        uploads.save_upload(
            file,
            part,
            max_bytes=uploads.max_video_upload_bytes(),
            free_space_dir=get_paths().downloads,
            headroom_bytes=uploads.IMPORT_HEADROOM_BYTES,
        )
        if part.stat().st_size == 0:
            part.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Empty file")
        part.replace(dest)
        if not probe_is_playable(dest):
            dest.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="File is not a playable video")
        # File is complete; allow ingest (active flag would otherwise block it).
        unmark_active(rel_path)
        video = ingest_media_file(session, dest, require_stable=False)
        if video is None:
            # Another process may have claimed it, or DB unique conflict.
            if find_video_by_path(session, rel_path) is not None:
                raise HTTPException(status_code=409, detail="File already in library")
            dest.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Could not import file")
        return _to_read(video, session, user_id=user.id)
    except HTTPException:
        part.unlink(missing_ok=True)
        raise
    except Exception:
        part.unlink(missing_ok=True)
        if dest.exists() and find_video_by_path(session, rel_path) is None:
            dest.unlink(missing_ok=True)
        logger.exception("review import failed for %s", rel_path)
        raise
    finally:
        unmark_active(rel_path)
        try:
            file.file.close()
        except Exception:
            logger.debug("failed closing upload stream", exc_info=True)


@router.post(
    "/{video_id}/skip",
    response_model=VideoRead,
    dependencies=[Depends(require_permission("edit_metadata"))],
)
def skip_review(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Dismiss a review item without requiring a channel. The file stays in the
    library keeping its filename-derived title."""
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    video.needs_review = False
    session.add(video)
    session.commit()
    session.refresh(video)
    try:
        from ..services.ai import enqueue_for_video

        enqueue_for_video(video_id, include_tags=True, force=False)
    except Exception:
        logger.debug("AI enqueue after review skip failed", exc_info=True)
    return _to_read(video, session, user_id=user.id)


class DuplicateGroupPage(BaseModel):
    items: list[DuplicateGroupRead]
    next_cursor: str | None = None


@router.get("/groups", response_model=DuplicateGroupPage)
def duplicate_groups(
    request: Request,
    limit: int = Query(25, ge=1, le=100),
    cursor: str | None = None,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Clusters of likely duplicate videos, ``limit`` groups per page.

    Finding the clusters reads the whole library, so the grouping is cached until
    the library changes (``services/duplicate_groups.py``); the AI check (one model call
    per heuristic cluster) and the serialization only run for the groups on the
    requested page.
    """
    try:
        page = parse_cursor(
            cursor, limit=limit, sort="groups", order="asc", kind="offset"
        )
    except InvalidCursor as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    groups = request.app.state.duplicate_groups.groups(
        duplicate_groups_svc.load_facts(session)
    )
    window = groups[page.offset : page.offset + page.fetch]
    more = len(window) > limit
    window = window[:limit]
    by_id = {
        v.id: v
        for v in session.exec(
            select(Video).where(
                col(Video.id).in_({vid for g in window for vid in g.video_ids})
            )
        ).all()
    }
    # A video deleted since the grouping was cached drops out of its group.
    raw_groups = [
        (g.match_type, [by_id[vid] for vid in g.video_ids if vid in by_id])
        for g in window
    ]
    raw_groups = [(t, vids) for t, vids in raw_groups if len(vids) > 1]

    annotate = False
    ai_unavailable_reason: str | None = None
    try:
        from ..services import app_settings
        from ..services.ai.provider import get_llm_provider

        ai = app_settings.ai_settings()
        want_ai = bool(ai.get("ai_duplicates", True))
        if want_ai:
            if get_llm_provider() is not None:
                annotate = True
            else:
                ai_unavailable_reason = "AI unavailable (no chat provider)"
    except Exception:
        logger.warning("AI annotation of duplicate groups unavailable", exc_info=True)
        annotate = False
        ai_unavailable_reason = "AI unavailable"

    out: list[dict[str, Any]] = []
    for match_type, group in raw_groups:
        entry: dict[str, Any] = {
            "videos": _to_read_many(group, session, user_id=user.id),
            "match_type": match_type,
            "ai_score": None,
            "ai_verdict": None,
            "ai_confidence": None,
            "ai_reason": None,
            "ai_error": None,
        }
        if annotate and match_type == "heuristic":
            try:
                from ..services.ai.duplicates import annotate_group

                scored = annotate_group(session, group)
                entry.update(scored)
            except Exception as exc:
                logger.warning("AI duplicate check failed", exc_info=True)
                entry["ai_error"] = str(exc)[:200]
        elif match_type == "heuristic" and ai_unavailable_reason:
            entry["ai_error"] = ai_unavailable_reason
        elif match_type == "youtube_id":
            entry["ai_verdict"] = "same"
            entry["ai_confidence"] = 1.0
            entry["ai_reason"] = "Same YouTube video ID"
        out.append(entry)
    next_cursor = (
        offset_cursor(sort="groups", order="asc", offset=page.offset + limit)
        if more
        else None
    )
    return DuplicateGroupPage(
        items=[DuplicateGroupRead.model_validate(entry) for entry in out],
        next_cursor=next_cursor,
    )

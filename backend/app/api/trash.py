"""The trash: list, restore and erase deleted videos (``services/trash.py``)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from .. import config
from ..auth import require_permission
from ..context import AppContext, get_ctx, get_session
from ..errors import CodedHTTPException
from ..models import TrashEntry, User, require_id
from ..openapi_responses import IMAGE_JPEG, RAW
from ..schemas import (
    TrashEmptied,
    TrashItemRead,
    TrashPage,
    TrashRestored,
    TrashSummary,
)
from ..services import trash
from ..services.pagination import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    InvalidCursor,
    keyset_cursor,
    parse_cursor,
)

router = APIRouter(
    prefix="/api/trash",
    tags=["trash"],
    dependencies=[Depends(require_permission("delete_videos"))],
)

_SORT = "trashed"


def _read(entry: TrashEntry, username: str | None) -> TrashItemRead:
    entry_id = require_id(entry)
    return TrashItemRead(
        id=entry_id,
        video_id=entry.video_id,
        youtube_id=entry.youtube_id,
        title=entry.title,
        channel=entry.channel,
        size_bytes=entry.size_bytes,
        trashed_at=entry.trashed_at,
        expires_at=trash.expires_at(entry),
        trashed_by=username,
        thumbnail_url=f"/api/trash/{entry_id}/thumbnail"
        if trash.has_thumbnail(entry)
        else None,
    )


@router.get("", response_model=TrashPage)
def list_trash(
    cursor: str | None = None,
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    session: Session = Depends(get_session),
):
    """Deleted videos, newest first."""
    try:
        page = parse_cursor(cursor, limit=limit, sort=_SORT, order="desc")
    except InvalidCursor as exc:
        raise CodedHTTPException(400, str(exc), "invalid_cursor") from exc
    query = (
        select(TrashEntry, col(User.username))
        .join(User, col(User.id) == col(TrashEntry.trashed_by_user_id), isouter=True)
        .options(defer(col(TrashEntry.snapshot_json)))  # type: ignore[arg-type]  # SQLModel attribute vs. the loader option signature
        .order_by(col(TrashEntry.id).desc())
        .limit(page.fetch)
    )
    if page.after_id is not None:
        query = query.where(col(TrashEntry.id) < page.after_id)
    rows = list(session.exec(query).all())
    more = len(rows) > page.limit
    rows = rows[: page.limit]
    next_cursor = None
    if more and rows[-1][0].id is not None:
        next_cursor = keyset_cursor(
            sort=_SORT, order="desc", value=None, last_id=rows[-1][0].id
        )
    return TrashPage(
        items=[_read(entry, username) for entry, username in rows],
        next_cursor=next_cursor,
    )


@router.get("/summary", response_model=TrashSummary)
def trash_summary(session: Session = Depends(get_session)):
    count, total = trash.summary(session)
    return TrashSummary(
        count=count, total_bytes=total, retention_days=config.TRASH_DAYS
    )


@router.post("/empty", response_model=TrashEmptied)
def empty_trash(
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
):
    """Erase everything in the trash for good."""
    deleted, freed = trash.empty(session)
    if deleted:
        ctx.download_queue.library_changed(room_made=True)
    return TrashEmptied(deleted=deleted, freed_bytes=freed)


@router.get(
    "/{entry_id}/thumbnail",
    response_class=RAW,
    responses={**IMAGE_JPEG, 404: {"description": "No thumbnail"}},
)
def trash_thumbnail(entry_id: int, session: Session = Depends(get_session)):
    entry = session.get(TrashEntry, entry_id)
    path = trash.thumbnail_file(entry) if entry is not None else None
    if path is None:
        raise CodedHTTPException(404, "No thumbnail", "not_found")
    return FileResponse(path, media_type="image/jpeg")


@router.post("/{entry_id}/restore", response_model=TrashRestored)
def restore_from_trash(
    entry_id: int,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
):
    """Put the video back in the library, with its tags, playlists and watch history."""
    try:
        video = trash.restore(session, entry_id)
    except trash.TrashNotFound as exc:
        raise CodedHTTPException(404, str(exc), "not_found") from exc
    except trash.TrashConflict as exc:
        raise CodedHTTPException(409, str(exc), "trash_conflict") from exc
    except trash.TrashError as exc:
        raise CodedHTTPException(500, str(exc), "trash_failed") from exc
    ctx.download_queue.library_changed()
    return TrashRestored(video_id=require_id(video), title=video.title)


@router.delete("/{entry_id}", status_code=204)
def delete_forever(
    entry_id: int,
    session: Session = Depends(get_session),
    ctx: AppContext = Depends(get_ctx),
):
    """Erase one video from the trash for good."""
    try:
        trash.delete_forever(session, entry_id)
    except trash.TrashNotFound as exc:
        raise CodedHTTPException(404, str(exc), "not_found") from exc
    ctx.download_queue.library_changed(room_made=True)
    return Response(status_code=204)

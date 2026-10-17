"""H.264 compatibility copies: per-video requests and library-wide actions."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from ..auth import current_user, require_admin, require_permission
from ..context import get_session
from ..models import Video, require_id
from ..response_schemas import CompatCancelResult, CompatSummaryRead
from ..schemas import CompatState
from ..services import compat_rendition
from ..services.auth.accounts import AuthUser
from ..services.media_info import needs_compat
from ..services.paths import resolve_compat_path
from ..services.ytdlp_formats import compat_copy_cap
from . import member_view
from .video_serialize import resolve_media

router = APIRouter(prefix="/api", tags=["compat"])


class CompatRequest(BaseModel):
    # False skips YouTube's own H.264 stream and always encodes locally.
    prefer_download: bool = True


class CompatBulkResult(BaseModel):
    queued: int
    already_queued: int = 0


class ConvertLibraryRequest(BaseModel):
    # The UI must send this explicitly: conversion replaces original files.
    confirm: bool = False


class CompatCancelRequest(BaseModel):
    kind: Literal["compat", "convert"] | None = None


def _state_for(user: AuthUser, state: dict) -> CompatState:
    read = CompatState(**state)
    return read if user.is_admin else member_view.compat(read)


def _video_or_404(session: Session, video_id: int) -> Video:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return video


@router.get("/videos/{video_id}/compat", response_model=CompatState)
def get_compat(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    video = _video_or_404(session, video_id)
    return _state_for(user, compat_rendition.compat_status(video))


@router.post("/videos/{video_id}/compat", response_model=CompatState)
def request_compat(
    video_id: int,
    payload: CompatRequest | None = None,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Create the sidecar for one video (a viewer is waiting, so it jumps the queue)."""
    video = _video_or_404(session, video_id)
    existing = resolve_compat_path(video)
    if existing is not None and existing.is_file():
        return _state_for(user, compat_rendition.compat_status(video))
    if not needs_compat(video, compat_copy_cap()):
        raise HTTPException(
            status_code=409,
            detail="This video is already H.264 within the copy resolution",
        )
    if video.compat_error:
        video.compat_error = None
        session.add(video)
        session.commit()
    compat_rendition.enqueue(
        video_id,
        prefer_download=(payload.prefer_download if payload else True),
        reason="Requested for a device that cannot play the original",
        front=True,
    )
    return _state_for(user, compat_rendition.compat_status(video))


def _safari_state(video: Video) -> dict:
    # While a job runs the file is being swapped; do not look for it on disk.
    busy = compat_rendition.job_state(require_id(video))
    if busy is not None:
        return {**busy, "error": None}
    return compat_rendition.safari_status(video, resolve_media(video))


@router.get("/videos/{video_id}/compat/safari", response_model=CompatState)
def get_safari_prep(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Is the stored original playable by WebKit (Safari, every iOS browser)?"""
    return _state_for(user, _safari_state(_video_or_404(session, video_id)))


@router.post("/videos/{video_id}/compat/safari", response_model=CompatState)
def request_safari_prep(
    video_id: int,
    session: Session = Depends(get_session),
    user: AuthUser = Depends(current_user),
):
    """Queue the in-place Safari remux (AAC audio + faststart, video copied).

    GET /stream only serves files that already exist; a client that detects it
    is WebKit calls this first and polls ``GET`` until the status is ``ready``.
    Idempotent: a repeat call while the job is queued or running changes nothing.
    """
    video = _video_or_404(session, video_id)
    state = _safari_state(video)
    if state["status"] in ("none", "error"):
        compat_rendition.enqueue(
            video_id,
            kind="safari",
            prefer_download=False,
            reason="Safari cannot play this file as stored",
            front=True,
        )
        state = _safari_state(video)
    return _state_for(user, state)


@router.delete(
    "/videos/{video_id}/compat",
    status_code=204,
    dependencies=[Depends(require_permission("delete_videos"))],
)
def delete_compat(video_id: int, session: Session = Depends(get_session)):
    video = _video_or_404(session, video_id)
    compat_rendition.cancel(video_id)
    compat_rendition.delete_compat_files(video)
    video.compat_path = None
    video.compat_size = None
    video.compat_source = None
    video.compat_error = None
    session.add(video)
    session.commit()


@router.get(
    "/compat/summary",
    response_model=CompatSummaryRead,
    dependencies=[Depends(require_admin)],
)
def compat_summary(session: Session = Depends(get_session)):
    """Library-wide codec and H.264 copy totals for the compatibility settings."""
    return compat_rendition.library_summary(session)


@router.post(
    "/compat/backfill",
    response_model=CompatBulkResult,
    dependencies=[Depends(require_admin)],
)
def compat_backfill(session: Session = Depends(get_session)):
    """Queue H.264 copies for every library video that would benefit."""
    queued = 0
    already = 0
    for video_id in compat_rendition.eligible_video_ids(session, kind="compat"):
        status = compat_rendition.enqueue(
            video_id,
            prefer_download=True,
            reason="Library backfill",
        )
        if status == "queued":
            queued += 1
        else:
            already += 1
    return CompatBulkResult(queued=queued, already_queued=already)


@router.post(
    "/compat/convert-library",
    response_model=CompatBulkResult,
    dependencies=[Depends(require_admin)],
)
def convert_library(
    payload: ConvertLibraryRequest,
    session: Session = Depends(get_session),
):
    """Re-encode every non-H.264 original to H.264 in place (destructive)."""
    if not payload.confirm:
        raise HTTPException(
            status_code=400,
            detail="Converting replaces original files; send confirm=true",
        )
    queued = 0
    already = 0
    for video_id in compat_rendition.eligible_video_ids(session, kind="convert"):
        status = compat_rendition.enqueue(
            video_id,
            kind="convert",
            prefer_download=False,
            reason="Library conversion to H.264",
        )
        if status == "queued":
            queued += 1
        else:
            already += 1
    return CompatBulkResult(queued=queued, already_queued=already)


@router.post(
    "/compat/cancel",
    response_model=CompatCancelResult,
    dependencies=[Depends(require_admin)],
)
def compat_cancel(payload: CompatCancelRequest | None = None):
    dropped = compat_rendition.cancel_all(payload.kind if payload else None)
    return {"cancelled": dropped}

import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlmodel import Session

from ..auth import current_user, require_permission
from ..context import get_paths, get_session
from ..models import User, Video
from ..openapi_responses import (
    FILE_DOWNLOAD,
    IMAGE_JPEG,
    RAW,
    SUBTITLES,
    VIDEO_STREAM,
)
from ..response_schemas import (
    SpriteGenerateResult,
    SpriteMetaRead,
    ThumbnailCandidates,
)
from ..schemas import (
    MediaTokenRead,
    VideoRead,
)
from ..services import library, media_sidecars, uploads
from ..services.auth import media_token as media_token_svc
from ..services.auth.accounts import AuthUser
from ..services.limits import ConcurrencyLimit, thumbnail_grab_limit
from ..services.metadata import (
    load_sprite_meta,
    sprite_image_path,
    sprites_exist,
)
from ..services.paths import (
    resolve_compat_path,
)
from ..services.sprites import enqueue_sprite_generation
from ..services.thumbnails import (
    copy_full,
    ensure_list_thumbnail,
    resolve_thumbnail_file,
    write_full_bytes,
)
from .video_serialize import (
    resolve_media as _resolve_media,
)
from .video_serialize import (
    safe_filename as _safe_filename,
)
from .video_serialize import (
    to_read as _to_read,
)

router = APIRouter(prefix="/api", tags=["videos"])

CHUNK_SIZE = 1024 * 1024

CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
}


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
    media_sidecars.refresh(video_id)
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
    media_sidecars.refresh(video_id)
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
    # Same URL after a rebuild (e.g. a redownload): revalidate by ETag every time.
    return FileResponse(
        path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"}
    )


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

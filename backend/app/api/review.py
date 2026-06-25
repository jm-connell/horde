from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..database import get_session
from ..models import Video
from ..schemas import VideoRead
from ..services import library
from .videos import _to_read

router = APIRouter(prefix="/api/review", tags=["review"])


@router.get("", response_model=list[VideoRead])
def review_queue(session: Session = Depends(get_session)):
    videos = library.query_videos(session, needs_review=True, sort="added_at", order="desc")
    return [_to_read(v) for v in videos]


@router.post("/{video_id}/skip", response_model=VideoRead)
def skip_review(video_id: int, session: Session = Depends(get_session)):
    """Dismiss a review item without requiring a channel. The file stays in the
    library keeping its filename-derived title."""
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    video.needs_review = False
    session.add(video)
    session.commit()
    session.refresh(video)
    return _to_read(video)

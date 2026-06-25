from fastapi import APIRouter, Depends
from sqlmodel import Session

from ..database import get_session
from ..schemas import VideoRead
from ..services import library
from .videos import _to_read

router = APIRouter(prefix="/api/review", tags=["review"])


@router.get("", response_model=list[VideoRead])
def review_queue(session: Session = Depends(get_session)):
    videos = library.query_videos(session, needs_review=True, sort="added_at", order="desc")
    return [_to_read(v) for v in videos]

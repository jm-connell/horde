import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..database import get_session
from ..models import Video
from ..schemas import VideoRead
from ..services import library
from .videos import _to_read

router = APIRouter(prefix="/api/review", tags=["review"])


class DuplicateGroupRead(BaseModel):
    videos: list[VideoRead]
    match_type: str  # youtube_id | heuristic
    ai_score: Optional[float] = None
    ai_verdict: Optional[str] = None
    ai_confidence: Optional[float] = None
    ai_reason: Optional[str] = None


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
    try:
        from ..services.ai import enqueue_for_video

        enqueue_for_video(video_id, include_tags=True, force=False)
    except Exception:  # noqa: BLE001
        pass
    return _to_read(video)


def _yt_id(video: Video) -> str | None:
    """Extract YouTube video ID from source_url or file_path."""
    for text in (video.source_url or "", video.file_path):
        m = re.search(r"\[([A-Za-z0-9_-]{11})\]", text)
        if m:
            return m.group(1)
        m = re.search(r"(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})", text)
        if m:
            return m.group(1)
    return None


def _title_tokens(title: str) -> set[str]:
    return set(re.sub(r"[^a-z0-9 ]", "", title.lower()).split())


@router.get("/groups")
def duplicate_groups(session: Session = Depends(get_session)) -> list[Any]:
    """Return heuristic clusters of likely duplicate videos in the library.

    Response is a list of DuplicateGroupRead objects. Older clients that expect
    ``list[list[VideoRead]]`` can still read ``.videos`` from each group.
    """
    all_videos = session.exec(
        select(Video).where(Video.needs_review == False)  # noqa: E712
    ).all()

    # Group 1: same YouTube video ID
    by_yt_id: dict[str, list[Video]] = {}
    for v in all_videos:
        yt_id = _yt_id(v)
        if yt_id:
            by_yt_id.setdefault(yt_id, []).append(v)

    # Group 2: same channel + high title similarity + duration within 5s
    used: set[int] = set()
    raw_groups: list[tuple[str, list[Video]]] = []

    for yt_id, vids in by_yt_id.items():
        if len(vids) > 1:
            raw_groups.append(("youtube_id", vids))
            for v in vids:
                used.add(v.id)

    for i, va in enumerate(all_videos):
        if va.id in used:
            continue
        if not va.channel or not va.title or not va.duration_sec:
            continue
        tokens_a = _title_tokens(va.title)
        cluster = [va]
        for vb in all_videos[i + 1:]:
            if vb.id in used or vb.channel != va.channel:
                continue
            if not vb.title or not vb.duration_sec:
                continue
            if abs(va.duration_sec - vb.duration_sec) > 5:
                continue
            tokens_b = _title_tokens(vb.title)
            # Jaccard similarity
            if tokens_a and tokens_b:
                overlap = len(tokens_a & tokens_b) / len(tokens_a | tokens_b)
                if overlap >= 0.7:
                    cluster.append(vb)
        if len(cluster) > 1:
            for v in cluster:
                used.add(v.id)
            raw_groups.append(("heuristic", cluster))

    annotate = False
    try:
        from ..services import app_settings
        from ..services.ai.provider import get_provider

        ai = app_settings.ai_settings()
        annotate = bool(ai.get("ai_duplicates", True)) and get_provider() is not None
    except Exception:  # noqa: BLE001
        annotate = False

    out: list[dict[str, Any]] = []
    for match_type, group in raw_groups:
        entry: dict[str, Any] = {
            "videos": [_to_read(v) for v in group],
            "match_type": match_type,
            "ai_score": None,
            "ai_verdict": None,
            "ai_confidence": None,
            "ai_reason": None,
        }
        if annotate and match_type == "heuristic":
            try:
                from ..services.ai.duplicates import annotate_group

                scored = annotate_group(session, group)
                entry.update(scored)
            except Exception:  # noqa: BLE001
                pass
        elif match_type == "youtube_id":
            entry["ai_verdict"] = "same"
            entry["ai_confidence"] = 1.0
            entry["ai_reason"] = "Same YouTube video ID"
        out.append(entry)
    return out

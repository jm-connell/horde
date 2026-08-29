"""Seek-preview sprite sheet generation and enqueue helpers."""

from __future__ import annotations

import threading
from typing import Literal, Optional

from sqlmodel import Session

from ..config import DOWNLOADS_DIR, SPRITE_CONCURRENCY, SPRITES_DIR
from ..database import engine
from ..models import Video
from . import activity
from .metadata import generate_sprite_sheet, sprites_exist

SpriteStatus = Literal["ready", "generating"]

_generating: set[int] = set()
_lock = threading.Lock()
_sprite_sem = threading.Semaphore(SPRITE_CONCURRENCY)


def enqueue_sprite_generation(
    video_id: int,
    *,
    reason: str = "Seek preview sprites needed",
) -> SpriteStatus:
    """Ensure sprites exist; start a daemon worker if needed. Idempotent."""
    if sprites_exist(SPRITES_DIR, video_id):
        return "ready"

    with _lock:
        if video_id in _generating:
            return "generating"
        _generating.add(video_id)

    def run() -> None:
        title: Optional[str] = None
        waiting = False
        acquired = False
        try:
            with Session(engine) as session:
                video = session.get(Video, video_id)
                if video is None:
                    return
                title = video.title
                path = (DOWNLOADS_DIR / video.file_path).resolve()
                if DOWNLOADS_DIR not in path.parents and path != DOWNLOADS_DIR:
                    return
                if not path.is_file():
                    return
                if sprites_exist(SPRITES_DIR, video_id):
                    return

            activity.note_queued("sprites", 1)
            waiting = True
            _sprite_sem.acquire()
            acquired = True
            activity.note_queued("sprites", -1)
            waiting = False

            with activity.track(
                "sprites",
                "Building seek previews",
                reason=reason,
                engine="ffmpeg",
                detail=title,
                video_id=video_id,
            ):
                with Session(engine) as session:
                    video = session.get(Video, video_id)
                    if video is None:
                        return
                    path = (DOWNLOADS_DIR / video.file_path).resolve()
                    if DOWNLOADS_DIR not in path.parents and path != DOWNLOADS_DIR:
                        return
                    if not path.is_file():
                        return
                    if sprites_exist(SPRITES_DIR, video_id):
                        return
                    sprite = generate_sprite_sheet(
                        path,
                        SPRITES_DIR,
                        video_id,
                        duration=video.duration_sec,
                    )
                    if sprite:
                        video.sprite_path = sprite
                        session.add(video)
                        session.commit()
        except Exception:  # noqa: BLE001
            pass
        finally:
            if waiting:
                activity.note_queued("sprites", -1)
            if acquired:
                _sprite_sem.release()
            with _lock:
                _generating.discard(video_id)

    threading.Thread(target=run, daemon=True, name=f"sprites-{video_id}").start()
    return "generating"


def sprites_in_progress(video_id: int) -> bool:
    """True while a sprite-sheet worker is running for this video."""
    with _lock:
        return video_id in _generating

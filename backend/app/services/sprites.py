"""Seek-preview sprite sheet generation and enqueue helpers."""

from __future__ import annotations

import threading
from typing import Literal

from sqlmodel import Session

from ..config import DOWNLOADS_DIR, SPRITES_DIR
from ..database import engine
from ..models import Video
from .metadata import generate_sprite_sheet, sprites_exist

SpriteStatus = Literal["ready", "generating"]

_generating: set[int] = set()
_lock = threading.Lock()


def enqueue_sprite_generation(video_id: int) -> SpriteStatus:
    """Ensure sprites exist; start a daemon worker if needed. Idempotent."""
    if sprites_exist(SPRITES_DIR, video_id):
        return "ready"

    with _lock:
        if video_id in _generating:
            return "generating"
        _generating.add(video_id)

    def run() -> None:
        try:
            with Session(engine) as session:
                video = session.get(Video, video_id)
                if video is None:
                    return
                path = (DOWNLOADS_DIR / video.file_path).resolve()
                if DOWNLOADS_DIR not in path.parents and path != DOWNLOADS_DIR:
                    return
                if not path.is_file():
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
            with _lock:
                _generating.discard(video_id)

    threading.Thread(target=run, daemon=True).start()
    return "generating"

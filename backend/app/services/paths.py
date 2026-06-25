from pathlib import Path

from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR
from ..models import Video


def to_rel_path(path: Path) -> str:
    """Store paths with forward slashes so DB keys are stable on Windows."""
    return path.resolve().relative_to(DOWNLOADS_DIR.resolve()).as_posix()


def find_video_by_path(session: Session, rel_path: str) -> Video | None:
    """Look up a video by relative path (handles legacy backslash rows)."""
    posix = rel_path.replace("\\", "/")
    for candidate in {posix, rel_path, posix.replace("/", "\\")}:
        row = session.exec(select(Video).where(Video.file_path == candidate)).first()
        if row is not None:
            return row
    return None

import re
from pathlib import Path

from sqlmodel import Session, select

from ..config import DOWNLOADS_DIR
from ..models import Video

_YT_ID_IN_PATH = re.compile(r"\[([A-Za-z0-9_-]{11})\]")


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


def safe_filename(name: str) -> str:
    """Strip characters that break filesystems or Content-Disposition."""
    cleaned = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return cleaned or "video"


def is_manual_import(video: Video) -> bool:
    """True for scanner/upload imports (not yt-dlp downloads)."""
    if video.source_url:
        return False
    if _YT_ID_IN_PATH.search(video.file_path or ""):
        return False
    return True


def manual_import_rel_path(
    channel: str | None, title: str, ext: str
) -> str:
    """Build Channel/Title.ext or imports/Title.ext for a manual import."""
    safe_title = safe_filename(title)
    suffix = ext if ext.startswith(".") else f".{ext}"
    if channel and channel.strip():
        return f"{safe_filename(channel.strip())}/{safe_title}{suffix}"
    return f"imports/{safe_title}{suffix}"


def unique_rel_path(desired: str, *, exclude: str | None = None) -> str:
    """Return desired if free on disk; otherwise append ' (2)', ' (3)', …"""
    root = DOWNLOADS_DIR.resolve()
    posix = desired.replace("\\", "/")
    path = Path(posix)
    stem = path.stem
    suffix = path.suffix
    parent = path.parent

    candidate = posix
    n = 2
    while True:
        if exclude and candidate.replace("\\", "/") == exclude.replace("\\", "/"):
            return candidate
        abs_path = (root / candidate).resolve()
        try:
            abs_path.relative_to(root)
        except ValueError:
            raise ValueError("Path escapes downloads directory") from None
        if not abs_path.exists():
            return candidate
        candidate = (parent / f"{stem} ({n}){suffix}").as_posix()
        n += 1


def rename_video_file(session: Session, video: Video, new_rel: str) -> None:
    """Move the on-disk file and update video.file_path. Caller commits."""
    root = DOWNLOADS_DIR.resolve()
    old_rel = video.file_path.replace("\\", "/")
    new_rel = unique_rel_path(new_rel.replace("\\", "/"), exclude=old_rel)

    if new_rel == old_rel:
        return

    old_abs = (root / old_rel).resolve()
    new_abs = (root / new_rel).resolve()
    try:
        old_abs.relative_to(root)
        new_abs.relative_to(root)
    except ValueError as exc:
        raise ValueError("Path escapes downloads directory") from exc

    if not old_abs.is_file():
        raise FileNotFoundError(f"Source file missing: {old_rel}")

    new_abs.parent.mkdir(parents=True, exist_ok=True)
    old_abs.replace(new_abs)
    video.file_path = new_rel
    session.add(video)

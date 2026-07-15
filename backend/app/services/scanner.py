import re
import threading
import time
from pathlib import Path

from sqlmodel import Session, select
from sqlalchemy.exc import IntegrityError
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from ..config import (
    DOWNLOADS_DIR,
    SCAN_INTERVAL_SEC,
    THUMBNAILS_DIR,
    VIDEO_EXTENSIONS,
)
from ..database import engine
from ..models import Video, VideoStatus
from .metadata import (
    grab_frame,
    probe_dimensions,
    probe_duration,
    probe_frame_rate,
    probe_is_playable,
)
from .paths import find_video_by_path, to_rel_path

_scan_lock = threading.Lock()

# yt-dlp writes per-format fragments like "Title [id].f137.mp4" before merging
# them into the final file; these must never be ingested as review items.
_FRAGMENT_RE = re.compile(r"\.f\d+\.[^.]+$")

# Relative paths / source IDs the downloader is actively writing.
_active_downloads: set[str] = set()
_active_source_ids: set[str] = set()
_active_lock = threading.Lock()

_SOURCE_ID_RE = re.compile(r"\[[^\]]+\]")


def mark_active(rel_path: str) -> None:
    with _active_lock:
        _active_downloads.add(rel_path)
        match = _SOURCE_ID_RE.search(Path(rel_path).name)
        if match:
            _active_source_ids.add(match.group(0))


def unmark_active(rel_path: str) -> None:
    with _active_lock:
        _active_downloads.discard(rel_path)
        match = _SOURCE_ID_RE.search(Path(rel_path).name)
        if match:
            _active_source_ids.discard(match.group(0))


def _is_active(rel_path: str) -> bool:
    with _active_lock:
        if rel_path in _active_downloads:
            return True
        name = Path(rel_path).name
        return any(source_id in name for source_id in _active_source_ids)


def _is_media(path: Path) -> bool:
    if not path.is_file() or path.suffix.lower() not in VIDEO_EXTENSIONS:
        return False
    name = path.name.lower()
    # Skip yt-dlp / ffmpeg intermediates that must never become review items.
    if _FRAGMENT_RE.search(path.name) is not None:
        return False
    if ".temp." in name or name.endswith(".temp.mp4"):
        return False
    if ".norm." in name or name.endswith(".norm.mp4"):
        return False
    return True


def _is_stable(path: Path) -> bool:
    """True if the file size is non-zero and unchanged across a short interval."""
    try:
        first = path.stat().st_size
        time.sleep(1)
        second = path.stat().st_size
    except OSError:
        return False
    return first > 0 and first == second


def ingest_media_file(
    session: Session,
    path: Path,
    *,
    require_stable: bool = True,
) -> Video | None:
    """Insert a newly discovered file as a review-needed video.

    Returns the Video row if added, otherwise None.
    """
    try:
        rel_path = to_rel_path(path)
    except ValueError:
        return None

    if _is_active(rel_path):
        return None

    existing = find_video_by_path(session, rel_path)
    if existing is not None:
        return None

    if require_stable and not _is_stable(path):
        return None

    if not probe_is_playable(path):
        return None

    try:
        file_size = path.stat().st_size
    except OSError:
        return None

    dims = probe_dimensions(path)
    video = Video(
        title=path.stem,
        channel=None,
        file_path=rel_path,
        duration_sec=probe_duration(path),
        file_size=file_size,
        width_px=dims[0] if dims else None,
        height_px=dims[1] if dims else None,
        frame_rate=probe_frame_rate(path),
        needs_review=True,
        status=VideoStatus.ready,
    )
    session.add(video)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        return None
    session.refresh(video)

    thumb_path = THUMBNAILS_DIR / f"{video.id}.jpg"
    if grab_frame(path, thumb_path):
        video.thumbnail_path = str(thumb_path)
        session.add(video)
        session.commit()

    if video.id is not None:
        try:
            from .sprites import enqueue_sprite_generation

            enqueue_sprite_generation(video.id)
        except Exception:  # noqa: BLE001
            pass

    return video


def _ingest_file(session: Session, path: Path) -> bool:
    """Insert a newly discovered file as a review-needed video. Returns True if added."""
    return ingest_media_file(session, path, require_stable=True) is not None


def scan_once() -> int:
    """Walk the downloads tree once, ingesting any unseen media files."""
    if not _scan_lock.acquire(blocking=False):
        return 0
    added = 0
    try:
        with Session(engine) as session:
            for path in DOWNLOADS_DIR.rglob("*"):
                if _is_media(path) and _ingest_file(session, path):
                    added += 1
    finally:
        _scan_lock.release()
    return added


def cleanup_orphans() -> int:
    """Remove review rows that point at files which no longer exist on disk.

    These are typically leftovers from before the fragment-aware scanner, e.g.
    a yt-dlp fragment that was ingested and then deleted once the merge ran.
    """
    removed = 0
    with Session(engine) as session:
        rows = session.exec(select(Video).where(Video.needs_review == True)).all()  # noqa: E712
        for video in rows:
            if (DOWNLOADS_DIR / video.file_path).exists():
                continue
            if video.thumbnail_path:
                Path(video.thumbnail_path).unlink(missing_ok=True)
            session.delete(video)
            removed += 1
        if removed:
            session.commit()
    return removed


class _MediaEventHandler(FileSystemEventHandler):
    def _maybe_ingest(self, src_path: str) -> None:
        path = Path(src_path)
        if not _is_media(path):
            return
        # Give the writer a moment to finish flushing the file.
        time.sleep(2)
        try:
            with Session(engine) as session:
                _ingest_file(session, path)
        except Exception:  # noqa: BLE001 - keep watchdog thread alive
            pass

    def on_created(self, event) -> None:
        if not event.is_directory:
            self._maybe_ingest(event.src_path)

    def on_moved(self, event) -> None:
        if not event.is_directory:
            self._maybe_ingest(event.dest_path)


def _polling_loop() -> None:
    while True:
        time.sleep(SCAN_INTERVAL_SEC)
        try:
            scan_once()
        except Exception:  # noqa: BLE001 - keep the poller alive across errors
            pass


def start_scanner() -> Observer:
    # Initial sweep so existing files appear immediately on boot.
    scan_once()

    observer = Observer()
    observer.schedule(_MediaEventHandler(), str(DOWNLOADS_DIR), recursive=True)
    observer.daemon = True
    observer.start()

    poller = threading.Thread(target=_polling_loop, daemon=True)
    poller.start()

    return observer

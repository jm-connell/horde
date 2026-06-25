import threading
import time
from pathlib import Path

from sqlmodel import Session, select
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
from .metadata import grab_frame, probe_duration

_scan_lock = threading.Lock()


def _is_media(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS


def _ingest_file(session: Session, path: Path) -> bool:
    """Insert a newly discovered file as a review-needed video. Returns True if added."""
    try:
        rel_path = str(path.relative_to(DOWNLOADS_DIR))
    except ValueError:
        return False

    existing = session.exec(
        select(Video).where(Video.file_path == rel_path)
    ).first()
    if existing is not None:
        return False

    try:
        file_size = path.stat().st_size
    except OSError:
        return False

    video = Video(
        title=path.stem,
        channel=None,
        file_path=rel_path,
        duration_sec=probe_duration(path),
        file_size=file_size,
        needs_review=True,
        status=VideoStatus.ready,
    )
    session.add(video)
    session.commit()
    session.refresh(video)

    thumb_path = THUMBNAILS_DIR / f"{video.id}.jpg"
    if grab_frame(path, thumb_path):
        video.thumbnail_path = str(thumb_path)
        session.add(video)
        session.commit()

    return True


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


class _MediaEventHandler(FileSystemEventHandler):
    def _maybe_ingest(self, src_path: str) -> None:
        path = Path(src_path)
        if not _is_media(path):
            return
        # Give the writer a moment to finish flushing the file.
        time.sleep(2)
        with Session(engine) as session:
            _ingest_file(session, path)

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

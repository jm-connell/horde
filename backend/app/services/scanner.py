import logging
import re
import threading
import time
from pathlib import Path

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from ..config import SCAN_INTERVAL_SEC, VIDEO_EXTENSIONS
from ..context import get_engine, get_paths
from ..logging_config import FailureLog
from ..models import Video, VideoStatus, utcnow
from . import activity, library
from .metadata import (
    grab_frame,
    probe_dimensions,
    probe_duration,
    probe_frame_rate,
    probe_is_playable,
)
from .paths import (
    COMPAT_SIDECAR_TOKEN,
    FRAGMENT_RE,
    STAGING_DIR_NAME,
    find_video_by_path,
    is_manual_import,
    is_staging_rel_path,
    to_rel_path,
)
from .thumbnails import write_list_thumbnail
from .video_delete import delete_video_cascade, remove_files
from .workers import BackgroundWorker, CallbackWorker, ManagedWorker

logger = logging.getLogger(__name__)

_scan_lock = threading.Lock()
_suspended = threading.Event()

# yt-dlp writes per-format fragments like "Title [id].f137.mp4" before merging
# them into the final file; these must never be ingested as review items.
_FRAGMENT_RE = FRAGMENT_RE

# Relative paths / source IDs the downloader is actively writing.
_active_downloads: set[str] = set()
_active_source_ids: set[str] = set()
_active_lock = threading.Lock()

_SOURCE_ID_RE = re.compile(r"\[[^\]]+\]")


def suspend_scanner() -> None:
    """Stop ingesting files (factory reset). In-flight walks abort the remaining tree."""
    _suspended.set()


def resume_scanner() -> None:
    _suspended.clear()


def scanner_suspended() -> bool:
    return _suspended.is_set()


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
    if STAGING_DIR_NAME in path.parts:
        return False
    name = path.name.lower()
    # Skip yt-dlp / ffmpeg intermediates that must never become review items.
    if _FRAGMENT_RE.search(path.name) is not None:
        return False
    if ".temp." in name or name.endswith(".temp.mp4"):
        return False
    if ".norm." in name or name.endswith(".norm.mp4"):
        return False
    if ".compat." in name or name.endswith(".compat.mp4"):
        return False
    # H.264 compatibility sidecars (and their temps) belong to another video.
    return COMPAT_SIDECAR_TOKEN not in name


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
    cancel_event: threading.Event | None = None,
) -> Video | None:
    """Insert a newly discovered file as a review-needed video.

    Returns the Video row if added, otherwise None. ``cancel_event`` ends the
    thumbnail grab early (the row is already committed without a thumbnail).
    """
    try:
        rel_path = to_rel_path(path)
    except ValueError:
        return None

    if _is_active(rel_path):
        return None

    # Ephemeral "download to device" staging — never library media.
    if rel_path.replace("\\", "/").startswith("_device/") or is_staging_rel_path(
        rel_path
    ):
        return None

    existing = find_video_by_path(session, rel_path)
    if existing is not None:
        return None

    if require_stable and not _is_stable(path):
        return None

    with activity.track(
        "scan",
        "Importing media file",
        reason="New file found by the folder scanner",
        engine="ffprobe",
        detail=path.name,
    ) as handle:
        if not probe_is_playable(path):
            handle.discard()
            return None

        try:
            file_size = path.stat().st_size
        except OSError:
            handle.discard()
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
        from .media_info import apply_stream_info, probe_stream_info

        apply_stream_info(video, probe_stream_info(path))
        session.add(video)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            handle.discard()
            return None
        session.refresh(video)

        handle.update(engine="ffmpeg", detail=video.title)
        thumb_path = get_paths().thumbnails / f"{video.id}.jpg"
        if grab_frame(path, thumb_path, cancel_event=cancel_event):
            video.thumbnail_path = str(thumb_path)
            if video.id is not None:
                write_list_thumbnail(video.id, thumb_path)
            session.add(video)
            session.commit()

        if video.id is not None:
            try:
                from .sprites import enqueue_sprite_generation

                enqueue_sprite_generation(
                    video.id,
                    reason="New file found by the folder scanner",
                )
            except Exception:
                logger.warning(
                    "could not queue sprite generation for video %s",
                    video.id,
                    exc_info=True,
                )

        return video


def _ingest_file(
    session: Session, path: Path, cancel_event: threading.Event | None = None
) -> bool:
    """Insert a newly discovered file as a review-needed video. Returns True if added."""
    return (
        ingest_media_file(session, path, require_stable=True, cancel_event=cancel_event)
        is not None
    )


def _has_library_channel(video: Video) -> bool:
    return bool((video.channel or "").strip())


def _requeue_unimported(session: Session) -> int:
    """Put skipped manual imports back in the review queue.

    Skip dismisses a review item without assigning a channel, so the row is
    still in the database and the automatic poller will not re-ingest it.
    A manual scan treats those as not yet imported.
    """
    rows = session.exec(
        select(Video).where(Video.needs_review == False)  # noqa: E712 - SQL column comparison, not a Python truth test
    ).all()
    count = 0
    now = utcnow()
    for video in rows:
        if _has_library_channel(video):
            continue
        if not is_manual_import(video):
            continue
        if not (get_paths().downloads / video.file_path).exists():
            continue
        video.needs_review = True
        video.added_at = now
        session.add(video)
        count += 1
    if count:
        session.commit()
    return count


def scan_once(
    *,
    blocking: bool = False,
    requeue_skipped: bool = False,
    record_empty: bool = False,
    reason: str = "Looking for new or dropped media files",
    stop_event: threading.Event | None = None,
) -> tuple[int, int]:
    """Walk the downloads tree once, ingesting any unseen media files.

    ``stop_event`` ends the walk and any thumbnail grab in progress.

    Returns ``(added, requeued)``. When the scan lock is already held and
    ``blocking`` is false, returns ``(0, 0)`` without walking the tree.
    """
    if _suspended.is_set():
        return 0, 0
    if not _scan_lock.acquire(blocking=blocking):
        return 0, 0
    added = 0
    requeued = 0
    try:
        handle = activity.start(
            "scan",
            "Scanning downloads folder",
            reason=reason,
        )
        try:
            with Session(get_engine()) as session:
                for path in get_paths().downloads.rglob("*"):
                    if _suspended.is_set() or (stop_event and stop_event.is_set()):
                        break
                    if _is_media(path) and _ingest_file(session, path, stop_event):
                        added += 1
                        handle.update(done=added, detail=f"{added} new file(s)")
                if requeue_skipped:
                    requeued = _requeue_unimported(session)
                    if requeued:
                        handle.update(
                            done=added + requeued,
                            detail=f"{added} new, {requeued} requeued",
                        )
            total = added + requeued
            if total:
                handle.finish(detail=f"{total} file(s)")
            elif record_empty:
                handle.finish(detail="No new files")
            else:
                # Idle polls every SCAN_INTERVAL_SEC — don't spam recent history.
                handle.discard()
        except Exception:
            handle.finish(status="failed")
            raise
    finally:
        _scan_lock.release()
    return added, requeued


def scan_for_new_files() -> tuple[int, int]:
    """User-triggered scan from the Import page. Waits for any in-flight walk."""
    return scan_once(
        blocking=True,
        requeue_skipped=True,
        record_empty=True,
        reason="Manual scan from the Import page",
    )


def cleanup_orphans() -> int:
    """Remove review rows that point at files which no longer exist on disk.

    These are typically leftovers from before the fragment-aware scanner, e.g.
    a yt-dlp fragment that was ingested and then deleted once the merge ran.
    """
    removed = 0
    doomed: list[Path] = []
    with Session(get_engine()) as session:
        rows = session.exec(select(Video).where(Video.needs_review == True)).all()  # noqa: E712 - SQL column comparison, not a Python truth test
        for video in rows:
            if (get_paths().downloads / video.file_path).exists():
                continue
            doomed += delete_video_cascade(session, video, False, commit=False)
            removed += 1
        if removed:
            session.commit()
            remove_files(doomed)
    return removed


class _MediaEventHandler(FileSystemEventHandler):
    def _maybe_ingest(self, src_path: str) -> None:
        if _suspended.is_set():
            return
        path = Path(src_path)
        if not _is_media(path):
            return
        # Give the writer a moment to finish flushing the file.
        time.sleep(2)
        if _suspended.is_set():
            return
        try:
            with Session(get_engine()) as session:
                _ingest_file(session, path)
        except Exception:
            # An exception here would end the watchdog thread for good.
            logger.warning("could not ingest %s", path, exc_info=True)

    def on_created(self, event) -> None:
        if not event.is_directory:
            self._maybe_ingest(event.src_path)

    def on_moved(self, event) -> None:
        if not event.is_directory:
            self._maybe_ingest(event.dest_path)


def _scan_pass(
    worker: BackgroundWorker,
    scan_failures: FailureLog,
    expire_failures: FailureLog,
    *,
    expire_progress: bool,
) -> None:
    try:
        scan_once(stop_event=worker.stop_event)
        scan_failures.ok()
    except Exception:  # noqa: BLE001 - FailureLog logs the traceback
        # Keep the poller alive: the next pass retries. A NAS that is offline fails
        # every minute, so only the first failure is a warning.
        scan_failures.failed()
    if not expire_progress:
        return
    try:
        with Session(get_engine()) as session:
            library.expire_stale_progress(session)
        expire_failures.ok()
    except Exception:  # noqa: BLE001 - FailureLog logs the traceback
        expire_failures.failed()


def _polling_loop(worker: BackgroundWorker) -> None:
    # The initial sweep runs here, not in startup, so the server answers requests
    # while a large library is walked; the watchdog already covers new files.
    scan_failures = FailureLog(logger, "library scan failed")
    expire_failures = FailureLog(logger, "expiring stale import progress failed")
    _scan_pass(worker, scan_failures, expire_failures, expire_progress=False)
    while not worker.sleep(SCAN_INTERVAL_SEC):
        _scan_pass(worker, scan_failures, expire_failures, expire_progress=True)


def create_scanner_workers() -> list[ManagedWorker]:
    """The watchdog observer and the fallback poller (which also runs the first scan)."""
    observer = Observer()
    observer.schedule(_MediaEventHandler(), str(get_paths().downloads), recursive=True)
    observer.daemon = True

    def stop_observer(timeout: float) -> None:
        if observer.is_alive():
            observer.stop()
            observer.join(timeout=timeout)

    watcher = CallbackWorker(
        "scanner-watchdog",
        start=observer.start,
        stop=stop_observer,
        is_alive=observer.is_alive,
        signal_stop=observer.stop,
    )
    return [watcher, BackgroundWorker("scanner-poller", _polling_loop)]

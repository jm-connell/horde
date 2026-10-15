"""Where a download writes while it runs, and moving the result into the library.

Library downloads write into a per-job dir under the staging root and are
promoted into the library only after postprocessing; "download to this device"
jobs write under ``_device/<job id>`` and never reach the library.
"""

import logging
import shutil
from pathlib import Path
from typing import Any

from sqlmodel import Session

from ...config import DOWNLOADS_DIR
from ...database import engine
from ...models import DownloadDestination, DownloadJob, JobStatus
from ..fsutil import (
    DISPLACED_DIR,
    MoveJournal,
    has_displaced_files,
    is_within,
    safe_unlink,
)
from ..outtmpl import (
    channel_folder,
    fit_outtmpl,
    flat_outtmpl,
    library_outtmpl,
    windows_filenames_ok,
)
from ..paths import belongs_to_stem, staging_dir, to_rel_path, video_stem
from .artifacts import is_intermediate_media

logger = logging.getLogger(__name__)


# Ephemeral staging for "download to this device" jobs (not library media).
DEVICE_STAGING_DIR = "_device"


def device_job_dir(job_id: int) -> Path:
    return DOWNLOADS_DIR / DEVICE_STAGING_DIR / str(job_id)


def device_outtmpl(job_id: int) -> str:
    return flat_outtmpl(device_job_dir(job_id))


def download_outtmpl(
    destination: str,
    job_id: int,
    info: dict[str, Any],
    channel_override: str | None,
    root: Path,
) -> tuple[str, bool]:
    """Output template for this download and whether yt-dlp should force Windows rules.

    Byte-truncated fields keep every file name (with yt-dlp's ``.f137.mp4.part``
    style suffixes) under the 255-byte limit; the folder is the channel the
    library row will carry, so ``channel_override`` and the folder agree.
    """
    wf = windows_filenames_ok(root)
    if destination == DownloadDestination.device.value:

        def make(budget: int) -> str:
            return flat_outtmpl(device_job_dir(job_id), budget)
    else:
        folder = channel_folder(info, channel_override)

        def make(budget: int) -> str:
            return library_outtmpl(root, folder, budget)

    return fit_outtmpl(make, info, windowsfilenames=wf), wf


def is_device_staging_path(rel_path: str) -> bool:
    posix = (rel_path or "").replace("\\", "/").lstrip("/")
    return posix == DEVICE_STAGING_DIR or posix.startswith(f"{DEVICE_STAGING_DIR}/")


def cleanup_device_job_files(job_id: int, device_file_path: str | None = None) -> None:
    """Remove ephemeral device-job media (file + staging dir)."""
    root = DOWNLOADS_DIR.resolve()
    staging = (DOWNLOADS_DIR / DEVICE_STAGING_DIR).resolve()
    if device_file_path and is_device_staging_path(device_file_path):
        full = (DOWNLOADS_DIR / device_file_path).resolve()
        try:
            full.relative_to(root)
        except ValueError:
            pass
        else:
            safe_unlink(full)
            parent = full.parent
            if parent.is_dir():
                stem = video_stem(full, staging=True)
                for entry in list(parent.iterdir()):
                    if belongs_to_stem(entry.name, stem) or entry.suffix in {
                        ".part",
                        ".ytdl",
                    }:
                        safe_unlink(entry)
    job_dir = device_job_dir(job_id)
    try:
        resolved = job_dir.resolve()
        resolved.relative_to(staging)
    except (OSError, ValueError):
        return
    if resolved.is_dir():
        shutil.rmtree(resolved, ignore_errors=True)


def gc_orphaned_device_dirs() -> int:
    """Remove `_device/{id}` dirs with no matching device DownloadJob row."""
    root = DOWNLOADS_DIR / DEVICE_STAGING_DIR
    if not root.is_dir():
        return 0
    removed = 0
    with Session(engine) as session:
        for child in list(root.iterdir()):
            if not child.is_dir() or not child.name.isdigit():
                continue
            job_id = int(child.name)
            job = session.get(DownloadJob, job_id)
            keep = (
                job is not None
                and job.destination == DownloadDestination.device.value
                and job.status
                in (JobStatus.queued, JobStatus.downloading, JobStatus.completed)
            )
            if keep:
                continue
            shutil.rmtree(child, ignore_errors=True)
            removed += 1
    return removed


def library_rel(rel: str, staging: Path | None) -> str:
    """Library-relative path for a path under the job's staging dir."""
    if staging is None:
        return rel
    prefix = to_rel_path(staging) + "/"
    return rel[len(prefix) :] if rel.startswith(prefix) else rel


def discard_staging_unless_requeued(job_id: int) -> None:
    """Remove the job's staging dir unless the job will run again (pause/restart).

    A paused or quality-restarted job goes back to ``queued`` and resumes its
    ``.part`` files from the same dir; a finished, failed, cancelled or deleted
    job has no use for it.
    """
    root = staging_dir(job_id)
    if not root.exists() and not root.is_symlink():
        return
    with Session(engine) as session:
        job = session.get(DownloadJob, job_id)
        if job is not None and job.status == JobStatus.queued:
            return
    remove_staging_dir(root)


def remove_staging_dir(path: Path) -> bool:
    """Delete one staging dir (never following a symlink out of the library).

    A non-empty ``.displaced`` holds the only copy of a library file that a
    re-download replaced; it is never deleted. Everything else in the dir is
    removed and False is returned so callers know the dir was kept.
    """
    if path.is_symlink():
        safe_unlink(path)
        return True
    if not is_within(path):
        logger.warning("refusing to remove staging dir outside the library: %s", path)
        return False
    if has_displaced_files(path):
        logger.error(
            "keeping %s: it holds the previous copy of a replaced library file",
            path / DISPLACED_DIR,
        )
        for child in path.iterdir():
            if child.name == DISPLACED_DIR:
                continue
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child, ignore_errors=True)
            else:
                safe_unlink(child)
        return False
    shutil.rmtree(path, ignore_errors=True)
    return True


def promote_from_staging(
    journal: MoveJournal, final_path: Path, staging_dir: Path
) -> Path:
    """Move a finished download (and sidecars of the same stem) into the library.

    The staging layout mirrors the library layout, so the relative path under the
    staging dir is the destination. A file already at the destination (re-download
    or replace) is kept in ``<staging>/.displaced`` until the DB commit succeeds.
    """
    rel = final_path.resolve().relative_to(staging_dir.resolve())
    dest = DOWNLOADS_DIR / rel
    backup_dir = staging_dir / DISPLACED_DIR
    stem = video_stem(final_path, staging=True)
    for entry in sorted(final_path.parent.iterdir()):
        if entry == final_path or not entry.is_file():
            continue
        if not belongs_to_stem(entry.name, stem) or is_intermediate_media(entry.name):
            continue
        if entry.name.endswith((".ytdl", ".part")):
            continue
        journal.move(entry, dest.parent / entry.name, backup_dir=backup_dir)
    journal.move(final_path, dest, backup_dir=backup_dir)
    return dest


def rollback_or_log(journal: MoveJournal) -> None:
    if not journal.rollback():
        logger.error(
            "rolling back a library promote failed; displaced files stay in staging"
        )

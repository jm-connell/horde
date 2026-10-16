"""Boot-time cleanup of download leftovers under DOWNLOADS_DIR.

A crash or kill can leave ffmpeg temp outputs (``.norm.<tid>.mp4`` and friends),
H.264 sidecar work files (``.horde-h264.dl.*``) and per-job staging dirs behind.
Only names Horde generates itself are removed. Everything is contained
to DOWNLOADS_DIR, symlinks are never followed, and nothing that an active job
or a library row still references is removed.
"""

from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path

from sqlmodel import Session, select

from .. import config
from ..context import get_engine, get_paths
from ..models import DownloadJob, JobStatus, Video
from .downloads.staging import remove_staging_dir
from .fsutil import is_within, restore_displaced, safe_unlink
from .paths import COMPAT_SIDECAR_TOKEN, STAGING_DIR_NAME

logger = logging.getLogger(__name__)

# Only names Horde itself generates are ever swept from the library tree. User
# files (``x.temp.mkv``, ``Show.compat.mkv``, ``notes.part``) are never touched,
# whatever their age. ffmpeg temp outputs carry the writing thread's numeric id:
#   ``<stem>.norm.<tid>.mp4``, ``<stem>.compat.<tid>.mp4``, ``<stem>.xcode.<tid>.mp4``
# and the H.264 sidecar work files are ``<stem>.horde-h264.dl.*`` / ``.enc.mp4``.
# yt-dlp output never lands in the library tree any more (it goes to
# ``.horde-staging/<job>``), so ``.part``/``.ytdl`` are not swept here.
_HORDE_TEMP_RE = re.compile(
    r"\.(?:norm|compat|xcode)\.\d+\.mp4$"
    r"|" + re.escape(COMPAT_SIDECAR_TOKEN) + r"(?:dl\.|enc\.mp4$)"
)


def is_temp_artifact(name: str) -> bool:
    return _HORDE_TEMP_RE.search(name) is not None


def _active_job_ids() -> set[int]:
    with Session(get_engine()) as session:
        rows = session.exec(
            select(DownloadJob.id).where(
                DownloadJob.status.in_([JobStatus.queued, JobStatus.downloading])  # type: ignore[attr-defined]
            )
        ).all()
    return {r for r in rows if r is not None}


def reap_staging_dirs() -> list[Path]:
    """Remove staging dirs whose job is gone or finished (no worker can own them)."""
    root = get_paths().downloads / STAGING_DIR_NAME
    if not root.is_dir() or root.is_symlink():
        return []
    active = _active_job_ids()
    removed: list[Path] = []
    for child in sorted(root.iterdir()):
        if child.name.isdigit() and int(child.name) in active:
            continue
        if child.is_dir() and not child.is_symlink():
            # A crash between promote and commit can leave the previous copy of
            # a replaced file here: put it back if its place is empty.
            restored = restore_displaced(child)
            if restored:
                logger.warning("restored %d displaced file(s) from %s", restored, child)
            if not remove_staging_dir(child):
                continue
        elif child.is_symlink():
            remove_staging_dir(child)
        else:
            safe_unlink(child)
        removed.append(child)
    return removed


def _referenced(session: Session, rel: str) -> bool:
    row = session.exec(
        select(Video.id).where((Video.file_path == rel) | (Video.compat_path == rel))
    ).first()
    return row is not None


def sweep_temp_artifacts(
    max_age_hours: float | None = None, *, now: float | None = None
) -> list[Path]:
    """Delete stale temp artifacts older than ``max_age_hours`` (default config)."""
    hours = config.TEMP_SWEEP_MAX_AGE_HOURS if max_age_hours is None else max_age_hours
    if hours <= 0:
        return []
    cutoff = (time.time() if now is None else now) - hours * 3600
    root = get_paths().downloads.resolve()
    active = {str(i) for i in _active_job_ids()}
    removed: list[Path] = []
    with Session(get_engine()) as session:
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            here = Path(dirpath)
            rel_parts = here.relative_to(root).parts
            # An active job's staging dir holds resumable .part files.
            in_active_staging = (
                rel_parts[:1] == (STAGING_DIR_NAME,)
                and len(rel_parts) >= 2
                and rel_parts[1] in active
            )
            if in_active_staging:
                dirnames.clear()
                continue
            dirnames[:] = [d for d in dirnames if not (here / d).is_symlink()]
            for name in filenames:
                if not is_temp_artifact(name):
                    continue
                path = here / name
                try:
                    st = path.lstat()
                except OSError:
                    continue
                if path.is_symlink() or st.st_mtime > cutoff or not is_within(path):
                    continue
                rel = path.relative_to(root).as_posix()
                if _referenced(session, rel):
                    continue
                if safe_unlink(path):
                    removed.append(path)
    return removed


def run_boot_cleanup() -> None:
    """Reap staging dirs of finished jobs, then sweep stale temp artifacts."""
    for path in reap_staging_dirs():
        logger.info("removed stale download staging: %s", path)
    for path in sweep_temp_artifacts():
        logger.info("removed stale temp artifact: %s", path)

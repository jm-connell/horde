"""Boot-time cleanup of download leftovers under DOWNLOADS_DIR.

A crash or kill can leave yt-dlp ``.part``/``.ytdl`` files, ffmpeg temp outputs
(``.temp.``, ``.norm.``, ``.compat.``, ``.xcode.``), H.264 sidecar work files
(``.horde-h264.dl.*``) and per-job staging dirs behind. Everything is contained
to DOWNLOADS_DIR, symlinks are never followed, and nothing that an active job
or a library row still references is removed.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from sqlmodel import Session, select

from .. import config
from ..database import engine
from ..models import DownloadJob, JobStatus, Video
from .downloader import remove_staging_dir
from .fsutil import is_within, safe_unlink
from .paths import COMPAT_SIDECAR_TOKEN, STAGING_DIR_NAME

logger = logging.getLogger(__name__)

_TEMP_MARKERS = (".temp.", ".norm.", ".compat.", ".xcode.", ".part-Frag")
_TEMP_SUFFIXES = (".part", ".ytdl")


def is_temp_artifact(name: str) -> bool:
    low = name.lower()
    if low.endswith(_TEMP_SUFFIXES) or any(m in low for m in _TEMP_MARKERS):
        return True
    # "<stem>.horde-h264.mp4" is a real sidecar; "<stem>.horde-h264.dl.*" is work.
    return COMPAT_SIDECAR_TOKEN in low and not low.endswith(
        f"{COMPAT_SIDECAR_TOKEN}mp4"
    )


def _active_job_ids() -> set[int]:
    with Session(engine) as session:
        rows = session.exec(
            select(DownloadJob.id).where(
                DownloadJob.status.in_([JobStatus.queued, JobStatus.downloading])  # type: ignore[attr-defined]
            )
        ).all()
    return {r for r in rows if r is not None}


def reap_staging_dirs() -> list[Path]:
    """Remove staging dirs whose job is gone or finished (no worker can own them)."""
    root = config.DOWNLOADS_DIR / STAGING_DIR_NAME
    if not root.is_dir() or root.is_symlink():
        return []
    active = _active_job_ids()
    removed: list[Path] = []
    for child in sorted(root.iterdir()):
        if child.name.isdigit() and int(child.name) in active:
            continue
        if child.is_dir() or child.is_symlink():
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
    root = config.DOWNLOADS_DIR.resolve()
    active = {str(i) for i in _active_job_ids()}
    removed: list[Path] = []
    with Session(engine) as session:
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

"""Filesystem helpers shared by the downloader, transcoders and compat jobs.

Every destructive helper here refuses to touch a path outside ``DOWNLOADS_DIR``
(or an explicit ``root``). Containment is checked on the *parent* directory, so
a symlinked file inside the library cannot be used to reach a target elsewhere:
unlinking a symlink only ever removes the link.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from .. import config

logger = logging.getLogger(__name__)


def _root(root: Path | None) -> Path:
    return (root if root is not None else config.DOWNLOADS_DIR).resolve()


def is_within(path: Path, root: Path | None = None) -> bool:
    """True when ``path`` (not following a final symlink) lives under ``root``."""
    base = _root(root)
    try:
        (path.parent.resolve() / path.name).relative_to(base)
    except (OSError, ValueError):
        return False
    return True


def safe_rel(path: Path, root: Path | None = None) -> str | None:
    """POSIX path relative to ``root`` (default ``DOWNLOADS_DIR``), or ``None``."""
    base = _root(root)
    try:
        return path.resolve().relative_to(base).as_posix()
    except (OSError, ValueError):
        return None


def safe_unlink(path: Path, *, retries: int = 5, root: Path | None = None) -> bool:
    """Delete a file inside ``root``, retrying Windows file-lock errors.

    Returns True when the file is gone (or never existed). Paths outside the
    root are refused and logged; other OS errors are logged, not raised, so
    cleanup never masks the failure that triggered it.
    """
    if not is_within(path, root):
        logger.warning("refusing to delete %s: outside %s", path, _root(root))
        return False
    for attempt in range(retries):
        try:
            path.unlink(missing_ok=True)
            return True
        except PermissionError:
            if attempt == retries - 1:
                logger.warning("could not delete locked file %s", path)
                return False
            time.sleep(0.15 * (attempt + 1))
        except OSError:
            logger.warning("could not delete %s", path, exc_info=True)
            return False
    return False


def replace_with_retries(
    src: Path, dest: Path, retries: int = 8, *, root: Path | None = None
) -> None:
    """Atomically replace ``dest`` with ``src``, retrying Windows file-lock errors."""
    if not is_within(src, root) or not is_within(dest, root):
        raise ValueError(f"refusing to move {src} -> {dest}: outside {_root(root)}")
    last_exc: OSError | None = None
    for attempt in range(retries):
        try:
            src.replace(dest)
            return
        except PermissionError as exc:
            last_exc = exc
            time.sleep(0.2 * (attempt + 1))
        except OSError as exc:
            # WinError 5 (access denied) / 32 (sharing violation) are transient.
            if getattr(exc, "winerror", None) not in (5, 32):
                raise
            last_exc = exc
            time.sleep(0.2 * (attempt + 1))
    if last_exc is not None:
        raise last_exc

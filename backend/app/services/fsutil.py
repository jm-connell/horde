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


class MoveJournal:
    """File moves that can be undone when the database write that follows fails.

    The rule used everywhere in Horde: never leave the DB pointing at a file
    that is not there. Move first, commit, and on a failed commit call
    ``rollback()`` to put every file back; call ``commit()`` once the row is
    durable to drop the backups of files that were replaced.
    """

    def __init__(self, root: Path | None = None) -> None:
        self._root = root
        self._moves: list[tuple[Path, Path]] = []
        self._backups: list[tuple[Path, Path]] = []

    def move(self, src: Path, dest: Path, *, backup_dir: Path | None = None) -> None:
        """Move ``src`` to ``dest``; an existing ``dest`` is kept in ``backup_dir``.

        Without ``backup_dir`` an existing ``dest`` is an error, so a rename can
        never silently overwrite another file.
        """
        if dest.exists() or dest.is_symlink():
            if backup_dir is None:
                raise FileExistsError(f"destination exists: {dest}")
            backup = backup_dir / f"{len(self._backups)}-{dest.name}"
            backup.parent.mkdir(parents=True, exist_ok=True)
            replace_with_retries(dest, backup, root=self._root)
            self._backups.append((dest, backup))
        dest.parent.mkdir(parents=True, exist_ok=True)
        replace_with_retries(src, dest, root=self._root)
        self._moves.append((src, dest))

    def rollback(self) -> None:
        """Undo every move, newest first, restoring any replaced file."""
        for src, dest in reversed(self._moves):
            try:
                replace_with_retries(dest, src, root=self._root)
            except OSError:
                logger.exception("could not move %s back to %s", dest, src)
        for dest, backup in reversed(self._backups):
            try:
                replace_with_retries(backup, dest, root=self._root)
            except OSError:
                logger.exception("could not restore %s from %s", dest, backup)
        self._moves.clear()
        self._backups.clear()

    def commit(self) -> None:
        """The database now references the new files: drop the replaced originals."""
        for _dest, backup in self._backups:
            safe_unlink(backup, root=self._root)
        self._moves.clear()
        self._backups.clear()

"""The trash: deleted videos wait here for ``HORDE_TRASH_DAYS`` and can be restored.

A tombstone design rather than a ``trashed`` flag on ``videos``. Trashing a video
runs the ordinary delete (``video_delete.delete_video_cascade``), so the row, its
tags, its full-text entry and every dependent row are really gone and no query has
to remember to filter anything out. What a restore needs is written first:

* a ``trash_entries`` row whose ``snapshot_json`` holds the video, its AI data,
  its playlist places and every user's watch state and chat, and whose
  ``files_json`` lists the files that were moved, and
* the files themselves, moved (not copied) under ``DOWNLOADS_DIR/.horde-trash/<id>``
  (media, subtitles, compat copy) and ``DATA_DIR/trash/<id>`` (thumbnails,
  sprites), each keeping its path relative to its root.

Restoring moves the files back and inserts the rows again with the original video
id; ``video_tags`` and ``videos_fts`` are refilled by the SQLite triggers on insert,
as for any new video. See ``docs/adr/0013-trash-tombstones.md``.

Only user deletes go through here (``trash_video``). The scanner dropping rows for
missing files, a re-download replacing a video, a factory reset and deleting an
account stay permanent.
"""

from __future__ import annotations

import base64
import json
import logging
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Any

from sqlalchemy import delete
from sqlmodel import Session, SQLModel, col, func, select

from .. import config
from ..context import current, get_engine, get_paths
from ..models import (
    Playlist,
    PlaylistItem,
    TrashEntry,
    User,
    UserVideoState,
    Video,
    VideoAiChatMessage,
    VideoAiMeta,
    VideoEmbedding,
    as_utc,
    require_id,
    utcnow,
)
from . import library, scanner
from .paths import TRASH_DIR_NAME, find_video_by_path
from .video_delete import collect_video_files, delete_video_cascade
from .workers import BackgroundWorker

logger = logging.getLogger(__name__)

#: Folder under DATA_DIR for thumbnails and sprites of trashed videos.
DATA_TRASH_DIR_NAME = "trash"
ROOT_DOWNLOADS = "downloads"
ROOT_DATA = "data"

PURGE_INTERVAL_SEC = 3600.0
STARTUP_DELAY_SEC = 120.0
#: A trash folder no entry owns is only removed once it is this old (a crash between
#: moving the files and committing leaves one, and its video row still exists).
ORPHAN_MIN_AGE = timedelta(days=1)
SNAPSHOT_VERSION = 1


class TrashError(Exception):
    """A video could not be moved to the trash (nothing was deleted)."""


class TrashNotFound(LookupError):
    """No such entry."""


class TrashConflict(Exception):
    """A restore would collide with something in the library now."""


# --- Settings and locations -------------------------------------------------


def enabled() -> bool:
    return config.TRASH_DAYS > 0


def retention() -> timedelta:
    return timedelta(days=config.TRASH_DAYS)


def expires_at(entry: TrashEntry) -> datetime:
    return as_utc(entry.trashed_at) + retention()


def _trash_root(root: str) -> Path:
    if root == ROOT_DOWNLOADS:
        return get_paths().downloads / TRASH_DIR_NAME
    return get_paths().data / DATA_TRASH_DIR_NAME


def _live_root(root: str) -> Path:
    return get_paths().downloads if root == ROOT_DOWNLOADS else get_paths().data


def _trash_dir(root: str, entry_id: int) -> Path:
    return _trash_root(root) / str(entry_id)


# --- Moving files -------------------------------------------------------------


def _exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


@dataclass(frozen=True)
class _Move:
    root: str
    rel: str
    size: int

    def live(self) -> Path:
        return _live_root(self.root) / self.rel

    def trashed(self, entry_id: int) -> Path:
        return _trash_dir(self.root, entry_id) / self.rel


def _plan_moves(video: Video) -> list[_Move]:
    """The files of ``video`` that exist inside the library, deduplicated."""
    roots = {
        ROOT_DOWNLOADS: get_paths().downloads.resolve(),
        ROOT_DATA: get_paths().data.resolve(),
    }
    seen: set[Path] = set()
    moves: list[_Move] = []
    for path in collect_video_files(video, include_media=True):
        try:
            real = path.parent.resolve() / path.name
        except OSError, RuntimeError:
            logger.warning("Not trashing unresolvable path %s", path, exc_info=True)
            continue
        if real in seen:
            continue
        seen.add(real)
        home = next(
            ((n, r) for n, r in roots.items() if real.is_relative_to(r) and real != r),
            None,
        )
        if home is None:
            logger.warning("Not trashing %s: outside the library", path)
            continue
        try:
            if real.is_dir() or not (real.is_file() or real.is_symlink()):
                continue
            size = real.lstat().st_size
        except OSError:
            logger.warning("Could not look at %s", path, exc_info=True)
            continue
        moves.append(_Move(home[0], real.relative_to(home[1]).as_posix(), size))
    return moves


def _move(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))


def _apply_moves(
    moves: list[_Move],
    src_of: Callable[[_Move], Path],
    dst_of: Callable[[_Move], Path],
    done: list[_Move],
) -> None:
    """Move each file from ``src_of(m)`` to ``dst_of(m)``, recording progress in ``done``."""
    for move in moves:
        _move(src_of(move), dst_of(move))
        done.append(move)


def _undo_moves(
    moves: list[_Move],
    src_of: Callable[[_Move], Path],
    dst_of: Callable[[_Move], Path],
) -> None:
    """Put already-moved files back; failures are logged, never raised."""
    for move in reversed(moves):
        try:
            _move(dst_of(move), src_of(move))
        except OSError:
            logger.error(
                "Could not move %s back to %s",
                dst_of(move),
                src_of(move),
                exc_info=True,
            )


def _remove_dir(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("Could not remove %s", path, exc_info=True)


# --- Snapshots ----------------------------------------------------------------


def _encode(row: SQLModel, *, drop: tuple[str, ...] = ()) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in row.model_dump().items():
        if key in drop:
            continue
        if isinstance(value, datetime):
            value = value.isoformat()
        elif isinstance(value, Enum):
            value = value.value
        elif isinstance(value, bytes):
            value = {"b64": base64.b64encode(value).decode("ascii")}
        out[key] = value
    return out


def _decode(data: dict[str, Any]) -> dict[str, Any]:
    out = dict(data)
    for key, value in out.items():
        if isinstance(value, dict) and set(value) == {"b64"}:
            out[key] = base64.b64decode(value["b64"])
    return out


def _snapshot(session: Session, video: Video) -> dict[str, Any]:
    video_id = require_id(video)
    meta = session.get(VideoAiMeta, video_id)
    embeddings = session.exec(
        select(VideoEmbedding).where(col(VideoEmbedding.video_id) == video_id)
    ).all()
    messages = session.exec(
        select(VideoAiChatMessage).where(col(VideoAiChatMessage.video_id) == video_id)
    ).all()
    states = session.exec(
        select(UserVideoState).where(col(UserVideoState.video_id) == video_id)
    ).all()
    items = session.exec(
        select(PlaylistItem).where(col(PlaylistItem.video_id) == video_id)
    ).all()
    covers = session.exec(
        select(col(Playlist.id)).where(col(Playlist.cover_video_id) == video_id)
    ).all()
    return {
        "version": SNAPSHOT_VERSION,
        "video": _encode(video),
        "ai_meta": _encode(meta) if meta is not None else None,
        "embeddings": [_encode(e, drop=("id",)) for e in embeddings],
        "chat_messages": [_encode(m, drop=("id",)) for m in messages],
        "user_states": [_encode(s) for s in states],
        "playlist_items": [
            {"playlist_id": i.playlist_id, "position": i.position} for i in items
        ],
        "cover_playlist_ids": [int(p) for p in covers if p is not None],
    }


# --- Trashing -----------------------------------------------------------------


def trash_video(session: Session, video: Video, by_user_id: int | None) -> TrashEntry:
    """Move ``video``'s files into the trash, then delete its rows. Commits.

    The video's media is always moved; callers that keep the file (library entry
    only) do not come here. When a file cannot be moved or the commit fails,
    everything is put back and ``TrashError`` is raised: the video stays as it was.
    """
    moves = _plan_moves(video)
    entry = TrashEntry(
        video_id=require_id(video),
        youtube_id=video.youtube_id,
        title=video.title,
        channel=video.channel,
        relative_path=video.file_path,
        size_bytes=sum(m.size for m in moves),
        trashed_by_user_id=by_user_id,
        files_json=json.dumps(
            [{"root": m.root, "path": m.rel, "size": m.size} for m in moves]
        ),
        snapshot_json=json.dumps(_snapshot(session, video)),
    )
    session.add(entry)
    done: list[_Move] = []
    entry_id = 0
    try:
        session.flush()
        entry_id = require_id(entry)
        _apply_moves(moves, _Move.live, lambda m: m.trashed(entry_id), done)
        delete_video_cascade(session, video, False, commit=False)
        session.commit()
    except Exception as exc:
        # Any failure (a file that cannot move, a locked database): the video stays.
        logger.warning("could not trash video %s", entry.video_id, exc_info=True)
        session.rollback()
        _undo_moves(done, _Move.live, lambda m: m.trashed(entry_id))
        if entry_id:
            _remove_trash_dirs(entry_id)
        raise TrashError(f"Could not move the video to the trash: {exc}") from exc
    return entry


# --- Restoring ----------------------------------------------------------------


def _moves_of(entry: TrashEntry) -> list[_Move]:
    try:
        moves = [
            _Move(str(f["root"]), str(f["path"]), int(f.get("size") or 0))
            for f in json.loads(entry.files_json or "[]")
        ]
    except (ValueError, KeyError, TypeError) as exc:
        raise TrashError(
            f"Trash entry {entry.id} has an unreadable file list."
        ) from exc
    for move in moves:
        rel = PurePosixPath(move.rel)
        if move.root not in (ROOT_DOWNLOADS, ROOT_DATA) or (
            rel.is_absolute() or ".." in rel.parts
        ):
            # Written by trash_video, so only a damaged database gets here.
            raise TrashError(f"Trash entry {entry.id} lists an unsafe path.")
    return moves


def _check_restorable(session: Session, entry: TrashEntry, moves: list[_Move]) -> None:
    video_id = entry.video_id
    if session.get(Video, video_id) is not None:
        raise TrashConflict("A video with the same id exists in the library.")
    if entry.youtube_id and library.find_video_by_youtube_id(session, entry.youtube_id):
        raise TrashConflict(
            "This video was downloaded again and is in the library; "
            "delete that copy first, or delete this one from the trash."
        )
    if find_video_by_path(session, entry.relative_path) is not None:
        raise TrashConflict("Another library video uses the same file path.")
    for move in moves:
        if _exists(move.live()):
            raise TrashConflict(f"A file already exists at {move.rel}.")


def restore(session: Session, entry_id: int) -> Video:
    """Put a trashed video back in the library, exactly as it was. Commits.

    Raises ``TrashNotFound``, ``TrashConflict`` (the original path or YouTube id is
    taken) or ``TrashError`` (the files cannot be moved back; nothing changed).
    """
    entry = session.get(TrashEntry, entry_id)
    if entry is None:
        raise TrashNotFound(f"Trash entry {entry_id} not found")
    moves = _moves_of(entry)
    missing = [m.rel for m in moves if not _exists(m.trashed(entry_id))]
    if missing:
        raise TrashError("Files of this video are no longer in the trash.")
    _check_restorable(session, entry, moves)

    snapshot = json.loads(entry.snapshot_json)
    media_rel = entry.relative_path
    # The folder watcher must not import the media file as a new video in the
    # moment between moving it back and committing its row.
    scanner.mark_active(media_rel)
    done: list[_Move] = []
    try:
        _apply_moves(moves, lambda m: m.trashed(entry_id), _Move.live, done)
        video = _insert_rows(session, snapshot)
        session.delete(entry)
        session.commit()
    except Exception as exc:
        logger.warning("could not restore trash entry %s", entry_id, exc_info=True)
        session.rollback()
        _undo_moves(done, lambda m: m.trashed(entry_id), _Move.live)
        raise TrashError(f"Could not restore the video: {exc}") from exc
    finally:
        scanner.unmark_active(media_rel)
    _remove_trash_dirs(entry_id)
    return video


def _insert_rows(session: Session, snapshot: dict[str, Any]) -> Video:
    video = Video.model_validate(_decode(snapshot["video"]))
    video_id = require_id(video)
    # The video first: its insert triggers fill video_tags and videos_fts.
    session.add(video)
    session.flush()
    if snapshot.get("ai_meta"):
        session.add(VideoAiMeta.model_validate(_decode(snapshot["ai_meta"])))
        session.flush()
    for data in snapshot.get("embeddings", []):
        session.add(VideoEmbedding.model_validate(_decode(data)))
    existing_users = {
        int(u) for u in session.exec(select(col(User.id))).all() if u is not None
    }
    for data in snapshot.get("chat_messages", []):
        owner = data.get("user_id")
        if owner is None or owner in existing_users:
            session.add(VideoAiChatMessage.model_validate(_decode(data)))
    for data in snapshot.get("user_states", []):
        if data.get("user_id") in existing_users:
            session.add(UserVideoState.model_validate(_decode(data)))
    for item in snapshot.get("playlist_items", []):
        if session.get(Playlist, item["playlist_id"]) is not None:
            session.add(
                PlaylistItem(
                    playlist_id=item["playlist_id"],
                    video_id=video_id,
                    position=int(item.get("position") or 0),
                )
            )
    for playlist_id in snapshot.get("cover_playlist_ids", []):
        playlist = session.get(Playlist, playlist_id)
        if playlist is not None and playlist.cover_video_id is None:
            playlist.cover_video_id = video_id
            session.add(playlist)
    session.flush()
    return video


# --- Erasing ------------------------------------------------------------------


def _remove_trash_dirs(entry_id: int) -> None:
    for root in (ROOT_DOWNLOADS, ROOT_DATA):
        _remove_dir(_trash_dir(root, entry_id))


def delete_forever(session: Session, entry_id: int) -> int:
    """Erase one entry and its files. Returns the bytes freed."""
    entry = session.get(TrashEntry, entry_id)
    if entry is None:
        raise TrashNotFound(f"Trash entry {entry_id} not found")
    return _erase(session, [entry])


def _erase(session: Session, entries: list[TrashEntry]) -> int:
    freed = sum(e.size_bytes for e in entries)
    ids = [require_id(e) for e in entries]
    for entry in entries:
        session.delete(entry)
    session.commit()
    # Files go after the commit: a failed commit must not leave entries without files.
    for entry_id in ids:
        _remove_trash_dirs(entry_id)
    return freed


def empty(session: Session) -> tuple[int, int]:
    """Erase everything in the trash. Returns ``(entries, bytes freed)``."""
    entries = list(session.exec(select(TrashEntry)).all())
    if not entries:
        return 0, 0
    return len(entries), _erase(session, entries)


def purge_all() -> None:
    """Forget the whole trash without reading it (factory reset, files already wiped)."""
    with Session(get_engine()) as session:
        session.execute(delete(TrashEntry))
        session.commit()
    for root in (ROOT_DOWNLOADS, ROOT_DATA):
        _remove_dir(_trash_root(root))


# --- Reading ------------------------------------------------------------------


def summary(session: Session) -> tuple[int, int]:
    """``(entries, bytes)`` in the trash."""
    count, total = session.exec(
        select(
            func.count(col(TrashEntry.id)),
            func.coalesce(func.sum(col(TrashEntry.size_bytes)), 0),
        )
    ).one()
    return int(count or 0), int(total or 0)


def trash_bytes(session: Session) -> int:
    return summary(session)[1]


def trashed_youtube_ids(session: Session) -> set[str]:
    """YouTube ids waiting in the trash: autodownload must not fetch them again."""
    rows = session.exec(
        select(col(TrashEntry.youtube_id)).where(col(TrashEntry.youtube_id) != None)  # noqa: E711 - SQL column comparison, not a Python truth test
    ).all()
    return {str(r) for r in rows if r}


def _listed_moves(entry: TrashEntry) -> list[_Move]:
    """``_moves_of`` for read-only callers: a damaged list counts as no files."""
    try:
        return _moves_of(entry)
    except TrashError:
        logger.warning(
            "trash entry %s has a damaged file list", entry.id, exc_info=True
        )
        return []


def _thumbnail_rel(entry: TrashEntry) -> str | None:
    kept = {m.rel for m in _listed_moves(entry) if m.root == ROOT_DATA}
    for rel in (
        f"thumbnails/{entry.video_id}_sm.jpg",
        f"thumbnails/{entry.video_id}.jpg",
    ):
        if rel in kept:
            return rel
    return None


def has_thumbnail(entry: TrashEntry) -> bool:
    return _thumbnail_rel(entry) is not None


def thumbnail_file(entry: TrashEntry) -> Path | None:
    """The list (or full) thumbnail of a trashed video, if it was moved to the trash."""
    rel = _thumbnail_rel(entry)
    if rel is None:
        return None
    path = _trash_dir(ROOT_DATA, require_id(entry)) / rel
    return path if path.is_file() else None


# --- Purging ------------------------------------------------------------------


def _files_missing(entry: TrashEntry) -> bool:
    """True when the entry lists files but none of them is in the trash any more."""
    moves = _listed_moves(entry)
    entry_id = require_id(entry)
    return bool(moves) and not any(_exists(m.trashed(entry_id)) for m in moves)


def purge_expired(now: datetime | None = None) -> int:
    """Erase entries older than the retention and entries whose files are gone.

    Also removes trash folders that no entry owns (older than a day). Returns the
    number of entries erased.
    """
    moment = now or utcnow()
    cutoff = moment - retention()
    with Session(get_engine()) as session:
        entries = list(session.exec(select(TrashEntry)).all())
        doomed = [
            e for e in entries if as_utc(e.trashed_at) <= cutoff or _files_missing(e)
        ]
        doomed_ids = {require_id(e) for e in doomed}
        known = {require_id(e) for e in entries} - doomed_ids
        if doomed:
            _erase(session, doomed)
    _sweep_orphan_dirs(known, moment)
    return len(doomed_ids)


def _sweep_orphan_dirs(known: set[int], now: datetime) -> None:
    for root in (ROOT_DOWNLOADS, ROOT_DATA):
        base = _trash_root(root)
        if not base.is_dir() or base.is_symlink():
            continue
        for child in base.iterdir():
            if not child.name.isdigit() or int(child.name) in known:
                continue
            try:
                age = now.timestamp() - child.stat().st_mtime
            except OSError:
                continue
            if age >= ORPHAN_MIN_AGE.total_seconds() and child.is_dir():
                logger.warning("removing trash folder without an entry: %s", child)
                _remove_dir(child)


def _worker_loop(worker: BackgroundWorker) -> None:
    if worker.sleep(STARTUP_DELAY_SEC):
        return
    while not worker.stopping:
        try:
            if purge_expired():
                current().download_queue.library_changed(room_made=True)
        except Exception:
            logger.warning("trash purge failed", exc_info=True)
        if worker.sleep(PURGE_INTERVAL_SEC):
            return


def create_worker() -> BackgroundWorker:
    return BackgroundWorker("trash-purge", _worker_loop)

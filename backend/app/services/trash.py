"""The trash: deleted videos wait here for ``HORDE_TRASH_DAYS`` and can be restored.

A tombstone design rather than a ``trashed`` flag on ``videos``. Trashing a video
runs the ordinary delete (``video_delete.delete_video_cascade``), so the row, its
tags, its full-text entry and every dependent row are really gone and no query has
to remember to filter anything out. What a restore needs is written first:

* a ``trash_entries`` row whose ``snapshot_json`` holds the video, its AI data,
  its playlist places and every user's watch state and chat, and whose
  ``files_json`` lists the files that were moved, and
* the files themselves, moved (not copied) under ``DOWNLOADS_DIR/.horde-trash/<folder>``
  (media, subtitles, compat copy) and ``DATA_DIR/trash/<folder>`` (thumbnails,
  sprites), each keeping its path relative to its root. ``<folder>`` is a random
  token stored on the entry, never a row id, so no two trashes share a folder.

The order matters. The files move first, with no database transaction open (a move
that has to copy would otherwise hold SQLite's one write lock for minutes), after a
``manifest`` naming them was written into each folder. Then one short transaction
inserts the entry and deletes the video. A crash in between leaves a folder without
an entry and a video row still in the library: the sweep reads the manifest and
moves the files back. Media is moved with ``rename`` so that it never turns into a
copy inside a request; a trash folder on another filesystem is refused instead.

Restoring moves the files back and inserts the rows again with the original video
id; ``video_tags`` and ``videos_fts`` are refilled by the SQLite triggers on insert,
as for any new video. See ``docs/adr/0013-trash-tombstones.md``.

Only user deletes go through here (``trash_video``). The scanner dropping rows for
missing files, a re-download replacing a video, a factory reset and deleting an
account stay permanent.
"""

from __future__ import annotations

import base64
import errno
import json
import logging
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Any

from sqlalchemy import delete, update
from sqlmodel import Session, SQLModel, col, func, select

from .. import config
from ..context import current, get_engine, get_paths
from ..database import rowcount
from ..models import (
    Playlist,
    PlaylistItem,
    RetentionKeep,
    TrashEntry,
    User,
    UserVideoState,
    UserWatchTime,
    Video,
    VideoAiChatMessage,
    VideoAiMeta,
    VideoEmbedding,
    as_utc,
    require_id,
    utcnow,
)
from . import library, playlist_entries, scanner
from .channel_autodownload import active_youtube_ids
from .channel_catalog import skips
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
#: A trash folder no entry owns is only looked at once it is this old, so that a
#: trash still moving its files is left alone. What it holds is put back, never erased.
ORPHAN_MIN_AGE = timedelta(hours=1)
SNAPSHOT_VERSION = 1
#: Written into each trash folder before any file is moved into it.
MANIFEST_NAME = ".horde-trash-manifest.json"


class TrashError(Exception):
    """A video could not be moved to the trash (nothing was deleted)."""


class TrashCrossDevice(TrashError):
    """The media and its trash folder are on different filesystems."""


class VideoAlreadyDeleted(TrashError):
    """The video was deleted by someone else while this delete was running."""


class TrashNotFound(LookupError):
    """No such entry."""


class TrashConflict(Exception):
    """A restore would collide with something in the library now."""


# --- Settings and locations -------------------------------------------------


def enabled() -> bool:
    return config.TRASH_DAYS > 0


def retention() -> timedelta:
    """How long an entry waits. With the trash off (0) entries already in it still
    expire on the default schedule, rather than all at once."""
    return timedelta(days=config.TRASH_DAYS or config.TRASH_DAYS_DEFAULT)


def expires_at(entry: TrashEntry) -> datetime:
    return as_utc(entry.trashed_at) + retention()


def _trash_root(root: str) -> Path:
    if root == ROOT_DOWNLOADS:
        return get_paths().downloads / TRASH_DIR_NAME
    return get_paths().data / DATA_TRASH_DIR_NAME


def _live_root(root: str) -> Path:
    return get_paths().downloads if root == ROOT_DOWNLOADS else get_paths().data


def _trash_dir(root: str, folder: str) -> Path:
    return _trash_root(root) / folder


# --- Moving files -------------------------------------------------------------


def _exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


@dataclass(frozen=True)
class _Move:
    root: str
    rel: str
    size: int
    #: The video's own file (as opposed to a thumbnail, subtitle or other copy of it).
    media: bool = False

    def live(self) -> Path:
        return _live_root(self.root) / self.rel

    def trashed(self, folder: str) -> Path:
        return _trash_dir(self.root, folder) / self.rel


def _plan_moves(video: Video) -> list[_Move]:
    """The files of ``video`` that exist inside the library, deduplicated."""
    roots = {
        ROOT_DOWNLOADS: get_paths().downloads.resolve(),
        ROOT_DATA: get_paths().data.resolve(),
    }
    seen: set[Path] = set()
    moves: list[_Move] = []
    media_path = get_paths().downloads / video.file_path
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
        moves.append(
            _Move(
                home[0],
                real.relative_to(home[1]).as_posix(),
                size,
                media=path == media_path,
            )
        )
    return moves


def _move(src: Path, dst: Path, *, rename_only: bool = False) -> None:
    """Move a file. ``rename_only`` refuses to copy across filesystems."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not rename_only:
        shutil.move(str(src), str(dst))
        return
    try:
        os.rename(src, dst)
    except OSError as exc:
        if exc.errno == errno.EXDEV:
            raise TrashCrossDevice(
                "The trash folder is on a different filesystem than the video, so "
                "it cannot be moved there without copying it. Put the media folders "
                "and .horde-trash on the same filesystem, or set HORDE_TRASH_DAYS=0."
            ) from exc
        raise


def _apply_moves(
    moves: list[_Move],
    src_of: Callable[[_Move], Path],
    dst_of: Callable[[_Move], Path],
    done: list[_Move],
) -> None:
    """Move each file from ``src_of(m)`` to ``dst_of(m)``, recording progress in ``done``.

    Media-folder files are only renamed; thumbnails and sprites (``DATA_DIR``, small)
    may be copied.
    """
    for move in moves:
        _move(src_of(move), dst_of(move), rename_only=move.root == ROOT_DOWNLOADS)
        done.append(move)


def _undo_moves(
    moves: list[_Move],
    src_of: Callable[[_Move], Path],
    dst_of: Callable[[_Move], Path],
) -> list[_Move]:
    """Put already-moved files back. Returns the ones that could not be; never raises."""
    failed: list[_Move] = []
    for move in reversed(moves):
        try:
            _move(dst_of(move), src_of(move), rename_only=move.root == ROOT_DOWNLOADS)
        except OSError:
            failed.append(move)
            logger.error(
                "Could not move %s back to %s",
                dst_of(move),
                src_of(move),
                exc_info=True,
            )
    return failed


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
    # Watch time outlives the video (its link is cleared); a restore links it again.
    watch_time = session.exec(
        select(col(UserWatchTime.id)).where(col(UserWatchTime.video_id) == video_id)
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
        "watch_time_ids": [int(w) for w in watch_time if w is not None],
    }


# --- Trashing -----------------------------------------------------------------


def _write_manifests(folder: str, video: Video, moves: list[_Move]) -> None:
    """Describe the files about to move, inside each trash folder that will get some.

    Only used when an entry never gets committed (a crash): see ``_recover_orphan``.
    """
    body = json.dumps(
        {
            "version": SNAPSHOT_VERSION,
            "video_id": require_id(video),
            "relative_path": video.file_path,
            "files": [
                {"root": m.root, "path": m.rel, "size": m.size, "media": m.media}
                for m in moves
            ],
        }
    )
    for root in sorted({m.root for m in moves}):
        target = _trash_dir(root, folder)
        target.mkdir(parents=True, exist_ok=True)
        (target / MANIFEST_NAME).write_text(body, encoding="utf-8")


def _put_back(done: list[_Move], folder: str) -> None:
    """Undo moves after a failed trash or restore; keep the folder if any file stayed."""
    failed = _undo_moves(done, _Move.live, lambda m: m.trashed(folder))
    if failed:
        logger.error(
            "%d file(s) could not be put back and stay in the trash folder %s; "
            "the next sweep tries again",
            len(failed),
            folder,
        )
        return
    _remove_trash_dirs(folder)


def trash_video(
    session: Session,
    video: Video,
    by_user_id: int | None,
    reason: str | None = None,
) -> TrashEntry:
    """Move ``video``'s files into the trash, then delete its rows. Commits.

    ``reason`` is shown in the trash list for a removal nobody asked for by hand
    (the retention rules); ``by_user_id`` is None then.

    The video's media is always moved; callers that keep the file (library entry
    only) do not come here. When a file cannot be moved or the commit fails,
    everything is put back and ``TrashError`` is raised: the video stays as it was.
    ``TrashCrossDevice`` means the media cannot be renamed into the trash.
    """
    video_id = require_id(video)
    moves = _plan_moves(video)
    entry = TrashEntry(
        video_id=video_id,
        youtube_id=video.youtube_id,
        title=video.title,
        channel=video.channel,
        relative_path=video.file_path,
        size_bytes=sum(m.size for m in moves),
        trashed_by_user_id=by_user_id,
        reason=reason,
        files_json=json.dumps(
            [
                {"root": m.root, "path": m.rel, "size": m.size, "media": m.media}
                for m in moves
            ]
        ),
        snapshot_json=json.dumps(_snapshot(session, video)),
    )
    folder = entry.folder
    done: list[_Move] = []
    # 1. The files, with no write transaction open.
    try:
        _write_manifests(folder, video, moves)
        _apply_moves(moves, _Move.live, lambda m: m.trashed(folder), done)
    except Exception as exc:
        logger.warning("could not trash video %s", video_id, exc_info=True)
        _put_back(done, folder)
        if isinstance(exc, TrashError):
            raise
        raise TrashError(f"Could not move the video to the trash: {exc}") from exc
    # 2. One short transaction: the entry and the delete.
    try:
        session.add(entry)
        session.flush()  # the first write: the lock is taken here, not before
        # Holding the lock now, nobody can delete the row between this check and ours.
        if (
            session.exec(select(col(Video.id)).where(col(Video.id) == video_id)).first()
            is None
        ):
            raise VideoAlreadyDeleted("The video was already deleted.")
        skips.record_deleted_video(session, video)
        delete_video_cascade(session, video, False, commit=False)
        session.commit()
    except Exception as exc:
        # A locked database, a vanished row: the video stays.
        logger.warning("could not trash video %s", video_id, exc_info=True)
        session.rollback()
        _put_back(done, folder)
        if isinstance(exc, TrashError):
            raise
        raise TrashError(f"Could not move the video to the trash: {exc}") from exc
    return entry


# --- Restoring ----------------------------------------------------------------


def _moves_of(entry: TrashEntry) -> list[_Move]:
    try:
        moves = [
            _Move(
                str(f["root"]),
                str(f["path"]),
                int(f.get("size") or 0),
                bool(f.get("media")),
            )
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
    if entry.youtube_id and entry.youtube_id in active_youtube_ids(session):
        raise TrashConflict(
            "This video is being downloaded again; wait for it to finish, "
            "or cancel the download, then restore it."
        )
    for move in moves:
        if move.media and _exists(move.live()):
            raise TrashConflict(f"A file already exists at {move.rel}.")


def restore(session: Session, entry_id: int) -> Video:
    """Put a trashed video back in the library, exactly as it was. Commits.

    Raises ``TrashNotFound``, ``TrashConflict`` (the original path or YouTube id is
    taken) or ``TrashError`` (the files cannot be moved back; nothing changed).
    """
    entry = session.get(TrashEntry, entry_id)
    if entry is None:
        raise TrashNotFound(f"Trash entry {entry_id} not found")
    folder = entry.folder
    moves = _moves_of(entry)
    _check_restorable(session, entry, moves)
    # A thumbnail, sprite or compat copy made again while the video was away is the
    # newer one: keep it and let the trashed copy go with the folder.
    moves = [m for m in moves if m.media or not _exists(m.live())]
    if any(not _exists(m.trashed(folder)) for m in moves):
        raise TrashError("Files of this video are no longer in the trash.")

    snapshot = json.loads(entry.snapshot_json)
    media_rel = entry.relative_path
    # The folder watcher must not import the media file as a new video in the
    # moment between moving it back and committing its row.
    scanner.hold(media_rel)
    done: list[_Move] = []
    try:
        # The files first, with no write transaction open; then one short one.
        _apply_moves(moves, lambda m: m.trashed(folder), _Move.live, done)
        res = session.execute(delete(TrashEntry).where(col(TrashEntry.id) == entry_id))
        if rowcount(res) != 1:
            raise TrashNotFound(f"Trash entry {entry_id} not found")
        video = _insert_rows(session, snapshot)
        # Someone wants it back: the retention rules must not take it again.
        session.merge(RetentionKeep(video_id=require_id(video)))
        skips.clear_deleted(session, video.youtube_id)
        session.commit()
    except Exception as exc:
        session.rollback()
        _undo_moves(done, lambda m: m.trashed(folder), _Move.live)
        if isinstance(exc, TrashNotFound):
            raise
        logger.warning("could not restore trash entry %s", entry_id, exc_info=True)
        raise TrashError(f"Could not restore the video: {exc}") from exc
    finally:
        scanner.release(media_rel)
    _remove_trash_dirs(folder)
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
        playlist_id = item["playlist_id"]
        if session.get(Playlist, playlist_id) is None:
            continue
        # Trashing left a streamable video's entry behind as a streamed one:
        # link it again (if it is gone, somebody removed it meanwhile).
        if playlist_entries.streamable_url(video.source_url):
            playlist_entries.link_video(session, playlist_id, video)
        else:
            session.add(
                playlist_entries.new_item(
                    playlist_id, video, int(item.get("position") or 0)
                )
            )
    watch_time_ids = snapshot.get("watch_time_ids", [])
    for start in range(0, len(watch_time_ids), 500):
        session.execute(
            update(UserWatchTime)
            .where(
                col(UserWatchTime.id).in_(watch_time_ids[start : start + 500]),
                col(UserWatchTime.video_id).is_(None),
            )
            .values(video_id=video_id)
        )
    for playlist_id in snapshot.get("cover_playlist_ids", []):
        playlist = session.get(Playlist, playlist_id)
        if playlist is not None and playlist.cover_video_id is None:
            playlist.cover_video_id = video_id
            session.add(playlist)
    session.flush()
    return video


# --- Erasing ------------------------------------------------------------------


def _remove_trash_dirs(folder: str) -> None:
    for root in (ROOT_DOWNLOADS, ROOT_DATA):
        _remove_dir(_trash_dir(root, folder))


def delete_forever(session: Session, entry_id: int) -> int:
    """Erase one entry and its files. Returns the bytes freed."""
    entry = session.get(TrashEntry, entry_id)
    if entry is None:
        raise TrashNotFound(f"Trash entry {entry_id} not found")
    return _erase(session, [entry])


def _erase(session: Session, entries: list[TrashEntry]) -> int:
    freed = sum(e.size_bytes for e in entries)
    folders = [e.folder for e in entries]
    for entry in entries:
        session.delete(entry)
    session.commit()
    # Files go after the commit: a failed commit must not leave entries without files.
    # Only folders of committed entries are ever removed here.
    for folder in folders:
        _remove_trash_dirs(folder)
    return freed


def empty(session: Session) -> tuple[int, int]:
    """Erase everything in the trash. Returns ``(entries, bytes freed)``."""
    entries = list(session.exec(select(TrashEntry)).all())
    if not entries:
        return 0, 0
    return len(entries), _erase(session, entries)


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
    path = _trash_dir(ROOT_DATA, entry.folder) / rel
    return path if path.is_file() else None


# --- Purging ------------------------------------------------------------------


def _storage_ready(entry: TrashEntry) -> bool:
    """False while a trash folder the entry's files live in cannot be seen.

    An unmounted network share or a drive that is not plugged in looks exactly like
    a trash whose files are gone, and erasing the entry then would cut its retention
    short and leave the files behind. The entry waits until the folder is back.
    """
    return all(
        _trash_root(root).is_dir() for root in {m.root for m in _listed_moves(entry)}
    )


def purge_expired(now: datetime | None = None, reported: set[str] | None = None) -> int:
    """Erase entries older than the retention, unless their storage is not available.

    Also looks at trash folders that no entry owns: see ``_sweep_orphan_dirs``
    (``reported`` collects the ones already logged, so a long-running worker says
    it once). Returns the number of entries erased.
    """
    moment = now or utcnow()
    cutoff = moment - retention()
    with Session(get_engine()) as session:
        entries = list(session.exec(select(TrashEntry)).all())
        doomed = [
            e for e in entries if as_utc(e.trashed_at) <= cutoff and _storage_ready(e)
        ]
        doomed_ids = {require_id(e) for e in doomed}
        known = {e.folder for e in entries if e.id not in doomed_ids}
        if doomed:
            _erase(session, doomed)
        _sweep_orphan_dirs(session, known, moment, reported)
    return len(doomed_ids)


def _read_manifest(folder: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((folder / MANIFEST_NAME).read_text(encoding="utf-8"))
        video_id = int(data["video_id"])
        relative_path = str(data["relative_path"])
        files = [
            _Move(
                str(f["root"]),
                str(f["path"]),
                int(f.get("size") or 0),
                bool(f.get("media")),
            )
            for f in data["files"]
        ]
    except OSError, ValueError, KeyError, TypeError:
        return None
    for move in files:
        rel = PurePosixPath(move.rel)
        if move.root not in (ROOT_DOWNLOADS, ROOT_DATA) or (
            rel.is_absolute() or ".." in rel.parts
        ):
            return None
    return {"video_id": video_id, "relative_path": relative_path, "files": files}


def _has_files(folder: Path) -> bool:
    return any(p.name != MANIFEST_NAME and not p.is_dir() for p in folder.rglob("*"))


def _recover_orphan(session: Session, root: str, folder: Path) -> str | None:
    """Put the files of a trash folder no entry owns back, if their video is still here.

    Returns ``None`` when the folder was dealt with, else why it was left alone.
    Nothing is ever deleted that could still be wanted: a folder is removed only after
    every file in it was moved back or is a stale copy of a derived file the library
    has regenerated since.
    """
    if not _has_files(folder):
        _remove_dir(folder)  # nothing to lose: leftover empty directories
        return None
    manifest = _read_manifest(folder)
    if manifest is None:
        return "it has no readable manifest"
    video = session.get(Video, manifest["video_id"])
    if video is None or video.file_path != manifest["relative_path"]:
        return f"video {manifest['video_id']} is not in the library"
    pending = [
        m for m in manifest["files"] if m.root == root and _exists(folder / m.rel)
    ]
    if any(m.media and _exists(m.live()) for m in pending):
        return "its media file is also in the library"
    for move in pending:
        src = folder / move.rel
        if _exists(move.live()):
            src.unlink()  # a newer derived file (thumbnail, sprite) exists: keep that
            continue
        try:
            _move(src, move.live(), rename_only=move.root == ROOT_DOWNLOADS)
        except OSError:
            logger.warning("could not move %s back", src, exc_info=True)
            return "its files could not be moved back"
    logger.warning(
        "put the files of video %s back from an unfinished trash (%s)",
        manifest["video_id"],
        folder.name,
    )
    if _has_files(folder):
        return "it holds files its manifest does not list"
    _remove_dir(folder)
    return None


def _sweep_orphan_dirs(
    session: Session,
    known: set[str],
    now: datetime,
    reported: set[str] | None = None,
) -> None:
    """Look at trash folders without an entry (a trash that crashed before its commit).

    Media is never erased here: when the video is still in the library its files are
    moved back, otherwise the folder is left in place (and reported) for the owner
    to look at. Only folders of committed entries are ever removed, by the purge.
    """
    for root in (ROOT_DOWNLOADS, ROOT_DATA):
        base = _trash_root(root)
        if not base.is_dir() or base.is_symlink():
            continue
        for child in base.iterdir():
            if child.name in known or child.is_symlink() or not child.is_dir():
                continue
            try:
                age = now.timestamp() - child.stat().st_mtime
            except OSError:
                continue
            if age < ORPHAN_MIN_AGE.total_seconds():
                continue  # maybe a trash that is still moving its files
            why = _recover_orphan(session, root, child)
            if why is not None and (reported is None or str(child) not in reported):
                logger.warning("leaving the trash folder %s alone: %s", child, why)
                if reported is not None:
                    reported.add(str(child))


def _worker_loop(worker: BackgroundWorker) -> None:
    if worker.sleep(STARTUP_DELAY_SEC):
        return
    reported: set[str] = set()
    while not worker.stopping:
        try:
            if purge_expired(reported=reported):
                current().download_queue.library_changed(room_made=True)
        except Exception:
            logger.warning("trash purge failed", exc_info=True)
        if worker.sleep(PURGE_INTERVAL_SEC):
            return


def create_worker() -> BackgroundWorker:
    return BackgroundWorker("trash-purge", _worker_loop)

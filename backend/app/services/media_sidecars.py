"""Optional metadata files for Jellyfin, Kodi and Plex (``media_server_sidecars``).

The library already reads as a TV library to a media server pointed at the same
folder: channel = show, year = season. With the admin setting on, Horde writes what
such a server needs to show proper titles, descriptions, dates and artwork:

* ``<name>.nfo`` beside each video: Kodi ``<episodedetails>``.
* ``<name>-thumb.jpg`` beside each video: a copy of its thumbnail.
* ``tvshow.nfo`` in each channel folder: Kodi ``<tvshow>``. Horde knows no channel
  avatar or description, so there is no ``poster.jpg`` and no ``<plot>``.

Episode numbers have to be stable, so they come from the upload date alone: the day
of the year times 100, plus how many videos of the same channel were uploaded that day
and were added to Horde earlier (``episode_number``). Adding a video never renumbers
another; only deleting an earlier same-day upload moves the later ones down.

Everything is built with ``xml.etree.ElementTree`` (so titles and descriptions are
escaped), written to a temporary file and renamed into place, and only when the bytes
differ from what is there. The files are Horde's to manage while the setting is on;
turning it off leaves them, ``remove_all`` deletes them. Paths come from the database,
so each is checked to stay inside ``DOWNLOADS_DIR``. Deleting or trashing a video, and
renaming one (``paths.rename_video_file``), take its two files along.

``refresh`` is the one call the rest of the app makes after a change. The library-wide
work (the backfill after turning the setting on, removing every file, a channel rename
touching many videos) runs on the ``media-sidecars`` worker through ``SidecarJobs``.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import xml.etree.ElementTree as ET
from collections import deque
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlparse

from sqlmodel import Session, col, func, select

from ..context import get_engine, get_paths
from ..models import Video, VideoStatus, as_utc
from . import activity, app_settings, library
from .fsutil import is_within, replace_with_retries, safe_unlink
from .paths import (
    SHOW_NFO_NAME,
    media_server_sidecar_paths,
    nfo_sidecar_path,
    thumb_sidecar_path,
)
from .thumbnails import resolve_thumbnail_file
from .workers import BackgroundWorker

if TYPE_CHECKING:
    from collections.abc import Iterable

logger = logging.getLogger(__name__)

SETTING = "media_server_sidecars"
#: How many of a video's tags are also written as ``<genre>`` (all are ``<tag>``).
MAX_GENRES = 5
#: Pause after a video that needed writing, so a backfill does not saturate a network share.
BACKFILL_PAUSE_SEC = 0.01
_XML_HEADER = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
# Characters XML 1.0 cannot carry at all (ElementTree would write them out unescaped).
_XML_ILLEGAL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")


def enabled() -> bool:
    return bool(app_settings.load().get(SETTING, False))


# --- Building the files -------------------------------------------------------


def _clean(value: str) -> str:
    """``value`` without what cannot be written as UTF-8 XML."""
    return _XML_ILLEGAL_RE.sub("", value.encode("utf-8", "ignore").decode("utf-8"))


def _add(parent: ET.Element, tag: str, value: object, **attrs: str) -> None:
    element = ET.SubElement(parent, tag, attrs)
    element.text = _clean(str(value))


def _serialize(root: ET.Element) -> bytes:
    ET.indent(root, space="  ")
    body: bytes = ET.tostring(root, encoding="utf-8")
    return _XML_HEADER + body + b"\n"


def _basis(video: Video) -> datetime:
    """The date a video is filed under: when it was published, else when it was added."""
    return as_utc(video.published_at or video.added_at)


def episode_number(session: Session, video: Video) -> int:
    """Day of the year times 100 plus the video's place among that day's uploads."""
    basis = _basis(video)
    start = datetime(basis.year, basis.month, basis.day, tzinfo=UTC)
    end = start + timedelta(days=1)
    when = col(Video.published_at if video.published_at else Video.added_at)
    query = select(func.count()).where(
        col(Video.id) < video.id,
        when >= start,
        when < end,
        col(Video.channel).is_(None)
        if video.channel is None
        else col(Video.channel) == video.channel,
    )
    if video.published_at is None:
        query = query.where(col(Video.published_at).is_(None))
    earlier = int(session.exec(query).one() or 0)
    return basis.timetuple().tm_yday * 100 + min(earlier, 99)


def _unique_tags(video: Video) -> list[str]:
    seen: set[str] = set()
    tags: list[str] = []
    for tag in library.parse_tags(video.tags):
        key = tag.strip().casefold()
        if key and key not in seen:
            seen.add(key)
            tags.append(tag.strip())
    return tags


def build_episode_nfo(video: Video, *, episode: int, show: str | None) -> bytes:
    """The Kodi ``<episodedetails>`` file for ``video``."""
    basis = _basis(video)
    root = ET.Element("episodedetails")
    _add(root, "title", video.title)
    if show:
        _add(root, "showtitle", show)
    _add(root, "season", basis.year)
    _add(root, "episode", episode)
    if video.description:
        _add(root, "plot", video.description)
    if video.duration_sec:
        _add(root, "runtime", max(1, round(video.duration_sec / 60)))
    if video.published_at:
        day = as_utc(video.published_at).date().isoformat()
        _add(root, "aired", day)
        _add(root, "premiered", day)
    if show:
        _add(root, "studio", show)
    tags = _unique_tags(video)
    for tag in tags[:MAX_GENRES]:
        _add(root, "genre", tag)
    for tag in tags:
        _add(root, "tag", tag)
    if video.youtube_id:
        _add(root, "uniqueid", video.youtube_id, type="youtube", default="true")
    _add(root, "dateadded", as_utc(video.added_at).strftime("%Y-%m-%d %H:%M:%S"))
    return _serialize(root)


def _channel_id(channel_url: str | None) -> str | None:
    """The last path segment of a channel URL (``UC...``, ``@handle``), if any."""
    if not channel_url:
        return None
    return urlparse(channel_url).path.rstrip("/").rsplit("/", 1)[-1] or None


def build_show_nfo(show: str, channel_url: str | None) -> bytes:
    """The Kodi ``<tvshow>`` file of a channel folder."""
    root = ET.Element("tvshow")
    _add(root, "title", show)
    _add(root, "studio", show)
    channel_id = _channel_id(channel_url)
    if channel_id:
        _add(root, "uniqueid", channel_id, type="youtube", default="true")
    return _serialize(root)


# --- Writing the files --------------------------------------------------------


def _write_if_changed(dest: Path, data: bytes) -> bool:
    """Atomically put ``data`` at ``dest`` unless it already holds exactly that."""
    if not is_within(dest):
        raise ValueError(f"refusing to write {dest}: outside the library")
    try:
        if dest.read_bytes() == data:
            return False
    except FileNotFoundError:
        pass
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        # 0o666 minus the umask, so a share user other than the container's can read it
        # (a mkstemp file would be private to the container user).
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        replace_with_retries(tmp, dest)
    except BaseException:
        safe_unlink(tmp)
        raise
    return True


def _media_path(video: Video) -> Path | None:
    """The media file of a library video that is settled enough to describe."""
    if video.id is None or video.needs_review or video.status != VideoStatus.ready:
        return None
    media = get_paths().downloads / video.file_path
    return media if media.is_file() else None


def _show_dir(video: Video) -> Path | None:
    """The channel folder: the first path segment, when the file is not at the top."""
    parts = Path(video.file_path.replace("\\", "/")).parts
    return get_paths().downloads / parts[0] if len(parts) > 1 else None


def sync_video(session: Session, video: Video) -> bool:
    """Write the files of one video. True when any file was created or changed."""
    media = _media_path(video)
    if media is None:
        return False
    show_dir = _show_dir(video)
    show = video.channel or (show_dir.name if show_dir else None)
    changed = _write_if_changed(
        nfo_sidecar_path(media),
        build_episode_nfo(video, episode=episode_number(session, video), show=show),
    )
    thumbnail = resolve_thumbnail_file(video.thumbnail_path)
    if thumbnail is not None:
        changed |= _write_if_changed(thumb_sidecar_path(media), thumbnail.read_bytes())
    if show_dir is not None and show:
        changed |= _write_if_changed(
            show_dir / SHOW_NFO_NAME, build_show_nfo(show, video.channel_url)
        )
    return changed


def refresh(video_id: int | None) -> None:
    """After a change to a video: bring its files up to date. Never raises."""
    if video_id is None:
        return
    try:
        if not enabled():
            return
        with Session(get_engine()) as session:
            video = session.get(Video, video_id)
            if video is not None:
                sync_video(session, video)
    except Exception:
        logger.warning(
            "could not write the media-server files of video %s",
            video_id,
            exc_info=True,
        )


def remove_video_files(video: Video) -> int:
    """Delete the per-video files of ``video``. Returns how many were there."""
    removed = 0
    media = get_paths().downloads / video.file_path
    for path in media_server_sidecar_paths(media):
        if path.is_file() and safe_unlink(path):
            removed += 1
    return removed


# --- Library-wide jobs --------------------------------------------------------


class SidecarJobs:
    """Work on many videos at once, run one job at a time by the ``media-sidecars`` worker.

    Held on the ``AppContext``. ``write`` creates or updates the files of the videos
    named (all of them when none are), ``remove`` deletes every file Horde wrote.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: deque[tuple[str, tuple[int, ...] | None]] = deque()
        self._worker: BackgroundWorker | None = None

    def create_worker(self) -> BackgroundWorker:
        self._worker = BackgroundWorker("media-sidecars", self._loop)
        return self._worker

    def _loop(self, worker: BackgroundWorker) -> None:
        while not worker.stopping:
            self.run_pending(worker)
            worker.wait_for_wake(60.0)

    def pending(self) -> int:
        with self._lock:
            return len(self._jobs)

    def _submit(self, kind: str, ids: Iterable[int] | None) -> None:
        wanted = None if ids is None else tuple(ids)
        with self._lock:
            if kind == "remove":
                # Nothing queued to write is wanted any more.
                self._jobs.clear()
            self._jobs.append((kind, wanted))
        if self._worker is not None:
            self._worker.wake()

    def write_all(self) -> None:
        """Backfill the whole library (the setting was turned on)."""
        self._submit("write", None)

    def write_videos(self, video_ids: Iterable[int]) -> None:
        """Rewrite the files of ``video_ids`` (a channel rename)."""
        ids = tuple(video_ids)
        if ids:
            self._submit("write", ids)

    def remove_all(self) -> None:
        self._submit("remove", None)

    def run_pending(self, worker: BackgroundWorker | None = None) -> int:
        """Run every queued job to the end (or until ``worker`` is stopping)."""
        ran = 0
        while worker is None or not worker.stopping:
            with self._lock:
                if not self._jobs:
                    break
                kind, ids = self._jobs.popleft()
            try:
                _run_job(kind, ids, worker)
            except Exception:
                logger.warning("media-server file job %s failed", kind, exc_info=True)
            ran += 1
        return ran


def _video_ids(session: Session, only: tuple[int, ...] | None) -> list[int]:
    query = select(col(Video.id)).where(col(Video.needs_review) == False)  # noqa: E712 - SQL column comparison, not a Python truth test
    if only is not None:
        query = query.where(col(Video.id).in_(only))
    return [i for i in session.exec(query.order_by(col(Video.id))) if i is not None]


def _run_job(
    kind: str, only: tuple[int, ...] | None, worker: BackgroundWorker | None
) -> None:
    writing = kind == "write"
    with Session(get_engine()) as session:
        ids = _video_ids(session, only)
        if writing:
            label = "Writing media-server files"
            reason = (
                "Media-server files turned on" if only is None else "Videos changed"
            )
        else:
            label, reason = (
                "Removing media-server files",
                "Removal asked for in Settings",
            )
        with activity.track(
            "sidecars", label, reason=reason, total=len(ids), done=0
        ) as handle:
            changed = failed = 0
            for done, video_id in enumerate(ids, start=1):
                if worker is not None and worker.stopping:
                    break
                if writing and not enabled():
                    break  # switched off again while this ran
                video = session.get(Video, video_id)
                wrote = False
                try:
                    if video is not None:
                        wrote = (
                            sync_video(session, video)
                            if writing
                            else remove_video_files(video) > 0
                        )
                except Exception:
                    failed += 1
                    logger.warning(
                        "media-server files of video %s: %s failed",
                        video_id,
                        kind,
                        exc_info=True,
                    )
                changed += wrote
                if done % 25 == 0 or done == len(ids):
                    handle.update(
                        done=done, detail=f"{changed} changed, {failed} failed"
                    )
                if wrote and worker is not None and worker.sleep(BACKFILL_PAUSE_SEC):
                    break
            if not writing:
                changed += _remove_show_files(session)
                handle.update(detail=f"{changed} removed, {failed} failed")
    logger.info("media-server files (%s): %d changed, %d failed", kind, changed, failed)


def _remove_show_files(session: Session) -> int:
    """Delete ``tvshow.nfo`` from each channel folder that holds a library video."""
    paths = session.exec(
        select(col(Video.file_path)).where(col(Video.needs_review) == False)  # noqa: E712 - SQL column comparison, not a Python truth test
    ).all()
    posix = (p.replace("\\", "/") for p in paths)
    folders = {p.split("/", 1)[0] for p in posix if "/" in p}
    removed = 0
    for name in sorted(folders):
        target = get_paths().downloads / name / SHOW_NFO_NAME
        if target.is_file() and safe_unlink(target):
            removed += 1
    return removed

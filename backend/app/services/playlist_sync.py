"""Periodic and on-demand sync for subscribed YouTube playlists."""

from __future__ import annotations

import logging
import threading
from typing import Optional

from sqlmodel import Session, select

from ..database import engine
from ..models import Playlist, utcnow
from . import activity
from .ytdlp_extract import extract_playlist_entries

logger = logging.getLogger(__name__)

_sync_lock = threading.Lock()


def sync_subscribed_playlist(playlist_id: int) -> None:
    """Rescan one subscribed playlist: attach existing ids, download missing ones."""
    from . import downloader

    with Session(engine) as session:
        playlist = session.get(Playlist, playlist_id)
        if playlist is None or not playlist.subscribed or not playlist.source_url:
            return
        url = playlist.source_url
        quality = playlist.quality_preset or "best"

    try:
        preview = extract_playlist_entries(url)
        entries = [
            str(e["url"])
            for e in (preview.get("entries") or [])
            if isinstance(e, dict) and e.get("url")
        ]
        downloader.run_playlist_entries(playlist_id, entries, quality)
        with Session(engine) as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return
            playlist.last_synced_at = utcnow()
            playlist.sync_error = None
            session.add(playlist)
            session.commit()
    except Exception as exc:  # noqa: BLE001
        logger.exception("Playlist %s sync failed", playlist_id)
        with Session(engine) as session:
            playlist = session.get(Playlist, playlist_id)
            if playlist is None:
                return
            playlist.sync_error = str(exc)[:500]
            session.add(playlist)
            session.commit()


def start_playlist_sync(playlist_id: int) -> None:
    thread = threading.Thread(
        target=sync_subscribed_playlist,
        args=(playlist_id,),
        daemon=True,
        name=f"playlist-sync-{playlist_id}",
    )
    thread.start()


def subscribed_playlist_ids(session: Session) -> list[int]:
    rows = session.exec(select(Playlist.id).where(Playlist.subscribed == True)).all()  # noqa: E712
    return [pid for pid in rows if pid is not None]


def sync_subscribed_playlists() -> None:
    """Rescan every subscribed playlist. No-op if another sweep is running."""
    if not _sync_lock.acquire(blocking=False):
        return
    try:
        with Session(engine) as session:
            ids = subscribed_playlist_ids(session)
        if not ids:
            return
        total = len(ids)
        with activity.track(
            "playlist_sync",
            "Syncing subscribed playlists",
            reason="Scheduled playlist rescan",
            engine="yt-dlp",
            detail=f"0/{total} playlists",
            total=total,
            done=0,
        ) as handle:
            for index, playlist_id in enumerate(ids):
                try:
                    sync_subscribed_playlist(playlist_id)
                except Exception:  # noqa: BLE001
                    logger.exception("Playlist %s sync raised", playlist_id)
                handle.update(
                    done=index + 1,
                    detail=f"{index + 1}/{total} playlists",
                )
    finally:
        _sync_lock.release()


def find_subscribed_by_url(
    session: Session, source_url: str, *, exclude_id: Optional[int] = None
) -> Optional[Playlist]:
    query = select(Playlist).where(
        Playlist.subscribed == True,  # noqa: E712
        Playlist.source_url == source_url,
    )
    for row in session.exec(query).all():
        if exclude_id is not None and row.id == exclude_id:
            continue
        return row
    return None

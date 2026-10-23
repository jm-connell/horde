"""Importing a playlist: one queue job per missing entry, attached on completion."""

import logging
import threading
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from ...context import get_engine
from ...models import DownloadDestination, DownloadJob, JobStatus, Playlist
from .. import activity
from ..channel_catalog import skips as catalog_skips
from ..url_clean import clean_url, youtube_thumbnail_url, youtube_video_id
from ..ytdlp_extract import is_youtube_short_url
from ..ytdlp_formats import default_download_video_codec
from . import jobs
from .playlist_attach import (
    append_unlisted_playlist_items,
    playlist_attach_lock,
    upsert_playlist_item,
)
from .queue import download_queue

logger = logging.getLogger(__name__)


def enqueue_playlist_entry(
    playlist_id: int, entry_url: str, quality_preset: str
) -> tuple[str, int | None]:
    """Resolve one playlist entry without waiting for any download.

    Returns ``("library", video_id)`` when the video is already in the library,
    ``("job", job_id)`` when a download job carries ``playlist_id`` (a new one, or
    an active one for the same video) so it attaches itself on completion, and
    ``("skip", None)`` for Shorts and unparseable URLs.
    """
    cleaned = clean_url(entry_url, keep_playlist=False)
    if not cleaned or is_youtube_short_url(cleaned) or is_youtube_short_url(entry_url):
        return "skip", None

    yt_id = youtube_video_id(cleaned)
    thumb = youtube_thumbnail_url(yt_id) if yt_id else None
    created_job_id: int | None = None
    with jobs.job_mutate_lock, Session(get_engine()) as session:
        existing = jobs.library_video_for_url(session, cleaned)
        if existing is not None and existing.id is not None:
            return "library", existing.id
        active = jobs.find_active_job_for_identity(session, cleaned)
        if active is not None and active.id is not None:
            if active.playlist_id is None:
                active.playlist_id = playlist_id
                session.add(active)
                session.commit()
            elif active.playlist_id != playlist_id:
                # One job can attach to one playlist only (no schema for more).
                logger.warning(
                    "job %s already feeds playlist %s; not also attaching to %s",
                    active.id,
                    active.playlist_id,
                    playlist_id,
                )
            return "job", active.id
        job = DownloadJob(
            url=cleaned,
            quality_preset=quality_preset or "best",
            status=JobStatus.queued,
            thumbnail_url=thumb,
            video_codec=default_download_video_codec(),
            destination=DownloadDestination.library.value,
            playlist_id=playlist_id,
            paused=download_queue.is_paused(),
        )
        session.add(job)
        try:
            catalog_skips.clear_deleted(session, yt_id)  # asked for by hand
            session.commit()
        except IntegrityError:
            # The playlist was deleted mid-import (playlist_id is an FK).
            session.rollback()
            logger.info("playlist %s deleted during import; skipping", playlist_id)
            return "skip", None
        session.refresh(job)
        created_job_id = job.id

    from ..job_metadata import request_job_metadata

    request_job_metadata(created_job_id)
    if created_job_id is not None:
        jobs.enqueue_download(created_job_id)
    return "job", created_job_id


def run_playlist_entries(
    playlist_id: int,
    entries: list[str],
    quality_preset: str,
    *,
    activity_handle: Any = None,
) -> None:
    """Enqueue a playlist's entries; never blocks on a download.

    Videos already in the library are placed at their playlist index right away.
    Every other entry becomes an ordinary queue job tagged with ``playlist_id``
    (so it honours concurrency and pause, and survives a restart) and is
    attached by ``attach_download_to_playlist`` when it completes; see
    ``attach_slot`` for how playlist order is kept. Items on the playlist that
    are not on the remote list stay after the remote entries.
    """
    total = len(entries)
    with Session(get_engine()) as session:
        if session.get(Playlist, playlist_id) is None:
            logger.info("playlist %s no longer exists; import skipped", playlist_id)
            return
    placed: set[int] = set()
    job_ids: list[int] = []
    for index, entry_url in enumerate(entries):
        kind, ref = enqueue_playlist_entry(playlist_id, entry_url, quality_preset)
        if kind == "job" and ref is not None:
            job_ids.append(ref)
        if kind == "library" and ref is not None and ref not in placed:
            placed.add(ref)
            with playlist_attach_lock, Session(get_engine()) as session:
                upsert_playlist_item(session, playlist_id, ref, index)
        if activity_handle is not None:
            activity_handle.update(
                done=index + 1,
                detail=f"{index + 1}/{total} queued",
            )
    if job_ids:
        # Jobs that already finished attached themselves in playlist order.
        with Session(get_engine()) as session:
            placed.update(
                vid
                for vid in session.exec(
                    select(DownloadJob.video_id).where(
                        col(DownloadJob.id).in_(job_ids),
                        DownloadJob.video_id != None,  # noqa: E711 - SQL IS NOT NULL
                    )
                ).all()
                if vid is not None
            )
    append_unlisted_playlist_items(playlist_id, placed, start_pos=total)


def run_playlist_import(
    playlist_id: int, entries: list[str], quality_preset: str
) -> None:
    total = len(entries)
    with activity.track(
        "playlist_import",
        "Importing playlist",
        reason="Playlist import started",
        engine="yt-dlp",
        detail=f"0/{total} queued",
        total=total,
        done=0,
    ) as handle:
        run_playlist_entries(
            playlist_id, entries, quality_preset, activity_handle=handle
        )


def start_playlist_import(
    playlist_id: int, entries: list[str], quality_preset: str
) -> None:
    thread = threading.Thread(
        target=run_playlist_import,
        args=(playlist_id, entries, quality_preset),
        daemon=True,
    )
    thread.start()

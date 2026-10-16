"""Attaching finished downloads to the playlist their job belongs to."""

import logging
import threading

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ...context import get_engine
from ...models import DownloadJob, JobStatus, Playlist, PlaylistItem, Video
from . import dbwrite

logger = logging.getLogger(__name__)


def attach_slot(session: Session, playlist_id: int, job_id: int) -> int:
    """Playlist position for a job's video, so import order survives async finishing.

    A playlist import enqueues one job per missing entry, in playlist order, so
    job ids ascend with playlist order. Entries already in the library were
    placed at their playlist index during the import, leaving holes where the
    jobs go. A job takes the first free position *after* the holes reserved by
    the still-active jobs with a lower id, so a later entry that finishes first
    cannot jump ahead of an earlier one that is still downloading.
    """
    earlier_active = int(
        session.exec(
            select(func.count())
            .select_from(DownloadJob)
            .where(
                DownloadJob.playlist_id == playlist_id,
                DownloadJob.id < job_id,
                DownloadJob.status.in_([JobStatus.queued, JobStatus.downloading]),
            )
        ).one()
    )
    occupied = set(
        session.exec(
            select(PlaylistItem.position).where(PlaylistItem.playlist_id == playlist_id)
        ).all()
    )
    pos = 0
    skipped = 0
    while True:
        if pos not in occupied:
            if skipped >= earlier_active:
                return pos
            skipped += 1
        pos += 1


# Serializes position assignment: two ffmpeg threads finishing together must not
# compute the same free slot (attach_slot is read-then-insert).
playlist_attach_lock = threading.Lock()


def attach_download_to_playlist(job_id: int, video_id: int | None) -> None:
    """Add a finished download to its playlist. Best effort; never raises.

    Runs after the job is already committed as completed, so a failure here
    (lock contention, a deleted playlist) is logged and must never change the
    job's status.
    """
    if video_id is None:
        return
    try:
        with playlist_attach_lock:
            dbwrite.retry_db_locked(
                lambda: _attach_once(job_id, video_id),
                what=f"playlist attach for job {job_id}",
            )
    except Exception:
        logger.warning(
            "could not attach job %s (video %s) to its playlist",
            job_id,
            video_id,
            exc_info=True,
        )


def _attach_once(job_id: int, video_id: int) -> None:
    with Session(get_engine()) as session:
        job = session.get(DownloadJob, job_id)
        if job is None or job.playlist_id is None:
            return
        if session.get(Playlist, job.playlist_id) is None:
            return
        if session.get(Video, video_id) is None:
            return
        if (
            session.exec(
                select(PlaylistItem).where(
                    PlaylistItem.playlist_id == job.playlist_id,
                    PlaylistItem.video_id == video_id,
                )
            ).first()
            is not None
        ):
            return
        playlist_id = job.playlist_id
        session.add(
            PlaylistItem(
                playlist_id=playlist_id,
                video_id=video_id,
                position=attach_slot(session, playlist_id, job_id),
            )
        )
        try:
            session.commit()
        except IntegrityError:
            # UNIQUE(playlist_id, video_id): another worker or the user added it
            # first; or the playlist/video was deleted meanwhile (FK). Either
            # way there is nothing left to attach.
            session.rollback()
            logger.info(
                "playlist %s item for video %s already present or gone",
                playlist_id,
                video_id,
            )


def upsert_playlist_item(
    session: Session, playlist_id: int, video_id: int, position: int
) -> None:
    existing = session.exec(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist_id,
            PlaylistItem.video_id == video_id,
        )
    ).first()
    if existing is None:
        session.add(
            PlaylistItem(
                playlist_id=playlist_id,
                video_id=video_id,
                position=position,
            )
        )
    else:
        existing.position = position
        session.add(existing)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        # Lost a race with an attach (UNIQUE(playlist_id, video_id)): set the
        # position on the row that won. If the playlist is gone, give up.
        row = session.exec(
            select(PlaylistItem).where(
                PlaylistItem.playlist_id == playlist_id,
                PlaylistItem.video_id == video_id,
            )
        ).first()
        if row is None:
            logger.info("playlist %s no longer exists; skipping item", playlist_id)
            return
        row.position = position
        session.add(row)
        session.commit()


def append_unlisted_playlist_items(
    playlist_id: int, placed_video_ids: set[int], start_pos: int
) -> None:
    """Keep items that are not on the remote list, after YouTube order."""
    with Session(get_engine()) as session:
        items = session.exec(
            select(PlaylistItem)
            .where(PlaylistItem.playlist_id == playlist_id)
            .order_by(PlaylistItem.position)
        ).all()
        pos = start_pos
        for item in items:
            if item.video_id in placed_video_ids:
                continue
            item.position = pos
            session.add(item)
            pos += 1
        session.commit()

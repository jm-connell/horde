"""The comment fetcher: saves the top comments of every YouTube video in the library.

Each pass fetches one video: one without saved comments (newest added first, so
a finished download gets its comments within a minute), else one whose retry or
new-upload refresh is due. Fetches run at background priority in the extract
gate, at most one every ``FETCH_SPACING_SEC``; a rate limit or bot check pauses
the fetcher for ``PAUSE_ON_LIMIT_SEC``. ``save_comments`` (Settings → Library)
turns it off.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlmodel import Session, col, or_, select

from ...context import current, get_engine
from ...models import Video, VideoCommentState, VideoStatus, require_id
from .. import activity, app_settings
from ..workers import BackgroundWorker
from . import fetch, store

logger = logging.getLogger(__name__)

SETTING = "save_comments"
STARTUP_DELAY_SEC = 60
IDLE_POLL_SEC = 5 * 60
FETCH_SPACING_SEC = 30
PAUSE_ON_LIMIT_SEC = 60 * 60


def enabled() -> bool:
    return bool(app_settings.load().get(SETTING, True))


def next_video(session: Session) -> Video | None:
    """The library video whose comments are fetched next, if any is due."""
    now = datetime.now(UTC)
    return session.exec(
        select(Video)
        .outerjoin(VideoCommentState, col(VideoCommentState.video_id) == col(Video.id))
        .where(
            col(Video.youtube_id).is_not(None),
            Video.needs_review == False,  # noqa: E712 - SQL column comparison, not a Python truth test
            Video.status == VideoStatus.ready,
            or_(
                col(VideoCommentState.video_id).is_(None),
                col(VideoCommentState.next_attempt_at) <= now,
            ),
        )
        # Never fetched before due retries and refreshes; newest additions first.
        .order_by(
            col(VideoCommentState.video_id).is_not(None),
            col(Video.added_at).desc(),
        )
        .limit(1)
    ).first()


def fetch_next() -> bool:
    """Fetch one video's comments if one is due. True when a fetch ran."""
    with Session(get_engine()) as session:
        video = next_video(session)
        if video is None:
            return False
        video_id = require_id(video)
        yt_id = str(video.youtube_id)  # next_video only picks videos with one
        title = video.title
    with activity.track(
        "comments", "Saving comments", engine="yt-dlp", detail=title, video_id=video_id
    ):
        result = fetch.fetch_comments(yt_id)
    with Session(get_engine()) as session:
        video = session.get(Video, video_id)
        if video is None:  # deleted meanwhile
            return True
        store.apply_result(session, video, result)
    if result.status == fetch.RETRY:
        current().comments.pause(PAUSE_ON_LIMIT_SEC)
        logger.info("Comments: YouTube pushed back; pausing for an hour")
    return True


def _loop(worker: BackgroundWorker) -> None:
    if worker.sleep(STARTUP_DELAY_SEC):
        return
    runtime = current().comments
    while not worker.stopping:
        paused = runtime.seconds_paused()
        if paused > 0:
            if worker.sleep(paused):
                return
            continue
        worked = False
        try:
            worked = enabled() and fetch_next()
        except Exception:
            logger.warning("Comments: worker pass failed", exc_info=True)
        if worked:
            if worker.sleep(FETCH_SPACING_SEC):
                return
            continue
        if worker.wait_for_wake(IDLE_POLL_SEC):
            return


def wake() -> None:
    """Fetch soon: a download finished or the setting was turned on."""
    current().comments.wake.set()


def create_worker() -> BackgroundWorker:
    return BackgroundWorker("comments", _loop, wake_event=current().comments.wake)

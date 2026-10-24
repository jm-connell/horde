"""Per-channel retention: old videos of a channel leave on their own.

A channel (by the name the library groups its videos by) may have one rule set with
any mix of three limits:

* ``keep_latest``: only the newest N videos stay (publish date, else added date);
* ``max_age_days``: videos added to the library more than D days ago go;
* ``remove_watched_after_days``: videos some account finished more than D days ago go,
  provided no account has watched them since (every finish and every viewing is
  older than D days).

Every removal is ``trash.trash_video``, so it can be undone from the trash for
``HORDE_TRASH_DAYS`` and records the ``deleted`` skip that keeps the channel's
automatic download from fetching the video again. With the trash turned off
(``HORDE_TRASH_DAYS=0``) nothing is removed: an unattended permanent delete is
never the fallback. A removal does not free disk (the trash still counts), so it
never wakes downloads held by the disk cap.

Whatever the limits say, these videos stay (``ALWAYS_KEPT``): in any playlist, with
notes, partway through for someone (watched within the last 7 days, not finished),
added in the last 24 hours, and restored from the trash (``RetentionKeep``).

``plan`` decides, ``apply_rule`` carries it out; the preview endpoint uses ``plan``
alone, so what it promises is what a run does. The worker runs every enabled rule
about hourly and right after one is saved (``wake_worker``).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, func
from sqlalchemy import select as sa_select
from sqlmodel import Session, col, select

from ..context import current, get_engine
from ..models import (
    ChannelRetention,
    PlaylistItem,
    RetentionKeep,
    UserVideoState,
    Video,
    VideoStatus,
    as_utc,
    require_id,
    utcnow,
)
from . import trash
from .workers import BackgroundWorker

logger = logging.getLogger(__name__)

WORKER_NAME = "channel-retention"
STARTUP_DELAY_SEC = 120.0
INTERVAL_SEC = 3600.0

#: A video added within this long is never removed.
NEW_VIDEO_GRACE = timedelta(hours=24)
#: Partway through for someone within this long: not removed (the same window
#: as the Continue watching row).
IN_PROGRESS_WINDOW = timedelta(days=7)

#: (code, label) of every exception, in the order the UI lists them.
ALWAYS_KEPT: tuple[tuple[str, str], ...] = (
    ("playlist", "It is in a playlist"),
    ("notes", "It has notes"),
    ("in_progress", "Someone is partway through it (watched in the last 7 days)"),
    ("new", "It was added in the last 24 hours"),
    ("restored", "It was restored from the trash"),
)


@dataclass(frozen=True)
class Rule:
    keep_latest: int | None = None
    max_age_days: int | None = None
    remove_watched_after_days: int | None = None

    @property
    def active(self) -> bool:
        return any(
            limit is not None
            for limit in (
                self.keep_latest,
                self.max_age_days,
                self.remove_watched_after_days,
            )
        )


@dataclass(frozen=True)
class Removal:
    video_id: int
    title: str
    size_bytes: int
    reason: str


@dataclass(frozen=True)
class Plan:
    removals: list[Removal]
    #: Videos a limit matched that an exception keeps.
    kept_by_exception: int


def rule_of(row: ChannelRetention) -> Rule:
    return Rule(row.keep_latest, row.max_age_days, row.remove_watched_after_days)


def get(session: Session, channel: str) -> ChannelRetention | None:
    return session.exec(
        select(ChannelRetention).where(col(ChannelRetention.channel) == channel)
    ).first()


def enabled_rows(session: Session) -> list[ChannelRetention]:
    return list(
        session.exec(
            select(ChannelRetention).where(col(ChannelRetention.enabled) == True)  # noqa: E712 - SQL column comparison, not a Python truth test
        ).all()
    )


def channel_exists(session: Session, channel: str) -> bool:
    return (
        session.exec(
            select(col(Video.id)).where(col(Video.channel) == channel).limit(1)
        ).first()
        is not None
    )


def save(
    session: Session, channel: str, *, enabled: bool, rule: Rule
) -> ChannelRetention:
    """Create or replace the channel's rule. Commits."""
    row = get(session, channel)
    if row is None:
        row = ChannelRetention(channel=channel)
    row.enabled = enabled
    row.keep_latest = rule.keep_latest
    row.max_age_days = rule.max_age_days
    row.remove_watched_after_days = rule.remove_watched_after_days
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def _days(n: int) -> str:
    return f"{n} day" if n == 1 else f"{n} days"


def _reasons(rule: Rule) -> tuple[str | None, str | None, str | None]:
    """The trash-list reason for each limit (None for a limit that is not set)."""
    return (
        f"Retention: keep latest {rule.keep_latest}"
        if rule.keep_latest is not None
        else None,
        f"Retention: older than {_days(rule.max_age_days)}"
        if rule.max_age_days is not None
        else None,
        f"Retention: watched more than {_days(rule.remove_watched_after_days)} ago"
        if rule.remove_watched_after_days is not None
        else None,
    )


def _ids(session: Session, statement) -> set[int]:
    return {int(v) for v in session.exec(statement).all()}


def _exempt_ids(
    session: Session, channel: str, now: datetime, video_id: int | None = None
) -> set[int]:
    """Videos of ``channel`` kept by the exceptions that live in other tables.

    With ``video_id``, only that video is looked at.
    """
    in_channel = col(Video.channel) == channel
    if video_id is not None:
        in_channel = and_(in_channel, col(Video.id) == video_id)
    exempt = _ids(
        session,
        select(col(PlaylistItem.video_id))
        .join(Video, col(Video.id) == col(PlaylistItem.video_id))
        .where(in_channel),
    )
    exempt |= _ids(
        session,
        select(col(UserVideoState.video_id))
        .join(Video, col(Video.id) == col(UserVideoState.video_id))
        .where(
            in_channel,
            col(UserVideoState.position_sec) > 0,
            col(UserVideoState.last_watched_at) >= now - IN_PROGRESS_WINDOW,
        ),
    )
    exempt |= _ids(
        session,
        select(col(RetentionKeep.video_id))
        .join(Video, col(Video.id) == col(RetentionKeep.video_id))
        .where(in_channel),
    )
    return exempt


def plan(
    session: Session, channel: str, rule: Rule, now: datetime | None = None
) -> Plan:
    """What the rule removes from ``channel`` right now. Changes nothing."""
    if not rule.active:
        return Plan([], 0)
    now = now or utcnow()
    videos = session.exec(
        select(Video).where(
            col(Video.channel) == channel,
            col(Video.status) == VideoStatus.ready,
            col(Video.needs_review).is_(False),
        )
    ).all()
    keep_reason, age_reason, watched_reason = _reasons(rule)
    reasons: dict[int, str] = {}

    if rule.keep_latest is not None and keep_reason:
        newest_first = sorted(
            videos,
            key=lambda v: (as_utc(v.published_at or v.added_at), require_id(v)),
            reverse=True,
        )
        for video in newest_first[rule.keep_latest :]:
            reasons[require_id(video)] = keep_reason

    if rule.max_age_days is not None and age_reason:
        cutoff = now - timedelta(days=rule.max_age_days)
        for video in videos:
            if as_utc(video.added_at) <= cutoff:
                reasons.setdefault(require_id(video), age_reason)

    if rule.remove_watched_after_days is not None and watched_reason:
        cutoff = now - timedelta(days=rule.remove_watched_after_days)
        # Every finish and every viewing by anyone is older than the wait: one
        # account's old finish must not take a video another just watched.
        finished = {
            int(video_id)
            for video_id in session.execute(
                sa_select(col(UserVideoState.video_id))
                .join(Video, col(Video.id) == col(UserVideoState.video_id))
                .where(col(Video.channel) == channel)
                .group_by(col(UserVideoState.video_id))
                .having(
                    func.max(col(UserVideoState.finished_at)) <= cutoff,
                    func.coalesce(func.max(col(UserVideoState.last_watched_at)), cutoff)
                    <= cutoff,
                )
            ).scalars()
        }
        for video in videos:
            if require_id(video) in finished:
                reasons.setdefault(require_id(video), watched_reason)

    exempt = _exempt_ids(session, channel, now) if reasons else set()
    new_since = now - NEW_VIDEO_GRACE
    removals: list[Removal] = []
    kept = 0
    for video in sorted(videos, key=lambda v: as_utc(v.added_at)):
        video_id = require_id(video)
        reason = reasons.get(video_id)
        if reason is None:
            continue
        if (
            video_id in exempt
            or (video.notes or "").strip()
            or as_utc(video.added_at) > new_since
        ):
            kept += 1
            continue
        removals.append(
            Removal(
                video_id=video_id,
                title=video.title,
                size_bytes=(video.file_size or 0) + (video.compat_size or 0),
                reason=reason,
            )
        )
    return Plan(removals, kept)


def apply_rule(
    session: Session,
    row: ChannelRetention,
    *,
    now: datetime | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> int:
    """Move what the channel's rule removes to the trash. Returns how many went.

    A video that cannot be moved (another filesystem, a locked database) is logged
    and left; the rest still go. Records the run on the rule. Commits.
    """
    channel = row.channel
    rule = rule_of(row)
    removed = 0
    failed = 0
    for removal in plan(session, channel, rule, now).removals:
        if should_stop is not None and should_stop():
            break
        video = session.get(Video, removal.video_id)
        if video is None:
            continue  # deleted by hand in the meantime
        # The plan may be minutes old by now (every move copies a file): honour a
        # playlist add, a note or a viewing made since it was drawn up.
        session.refresh(video)
        if (video.notes or "").strip() or _exempt_ids(
            session, channel, now or utcnow(), removal.video_id
        ):
            continue
        try:
            trash.trash_video(session, video, None, removal.reason)
        except trash.VideoAlreadyDeleted:
            continue
        except trash.TrashError:
            failed += 1  # trash_video logged why
            continue
        removed += 1
    row = get(session, channel) or row
    row.last_run_at = utcnow()
    if removed:
        row.last_removed_count = removed
        row.last_removed_at = row.last_run_at
    session.add(row)
    session.commit()
    if removed or failed:
        logger.info(
            "retention for %r: moved %d video(s) to the trash, %d could not be moved",
            channel,
            removed,
            failed,
        )
    else:
        logger.info("retention for %r: nothing to remove", channel)
    return removed


def run_all(should_stop: Callable[[], bool] | None = None) -> int:
    """Apply every enabled rule. Returns how many videos went to the trash."""
    if not trash.enabled():
        logger.info(
            "retention rules are not applied: the trash is off (HORDE_TRASH_DAYS=0)"
        )
        return 0
    total = 0
    with Session(get_engine()) as session:
        for row in enabled_rows(session):
            if should_stop is not None and should_stop():
                break
            if not rule_of(row).active:
                continue
            try:
                total += apply_rule(session, row, should_stop=should_stop)
            except Exception:
                session.rollback()
                logger.warning("retention for %r failed", row.channel, exc_info=True)
    return total


def wake_worker() -> None:
    """Run the rules now instead of at the next hourly pass (a rule was just saved)."""
    for worker in current().workers.workers:
        if worker.name == WORKER_NAME and isinstance(worker, BackgroundWorker):
            worker.wake()


def _worker_loop(worker: BackgroundWorker) -> None:
    if worker.wait_for_wake(STARTUP_DELAY_SEC):
        return
    while not worker.stopping:
        try:
            run_all(lambda: worker.stopping)
        except Exception:
            logger.warning("retention pass failed", exc_info=True)
        if worker.wait_for_wake(INTERVAL_SEC):
            return


def create_worker() -> BackgroundWorker:
    return BackgroundWorker(WORKER_NAME, _worker_loop)

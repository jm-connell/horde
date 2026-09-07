"""Per-channel autodownload: persist policy, enqueue catalog uploads, poll for new ones."""

from __future__ import annotations

import logging
import threading
from typing import Any, Optional

from sqlmodel import Session, select

from ..database import engine
from ..models import (
    ChannelAutodownload,
    ChannelCatalog,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    DownloadDestination,
    DownloadJob,
    JobStatus,
    utcnow,
)
from . import app_settings, library
from .url_clean import clean_url, youtube_video_id
from .ytdlp_extract import is_youtube_short_entry
from .ytdlp_formats import QUALITY_FORMATS, default_download_video_codec

logger = logging.getLogger(__name__)

PREVIOUS_MODES = frozenset({"none", "count", "all"})
DEFAULT_PRESET = "1080p"
DEFAULT_PREVIOUS_COUNT = 10
PREVIOUS_COUNT_MIN = 1
PREVIOUS_COUNT_MAX = 500
POLL_INTERVAL_SEC = 15 * 60
STARTUP_DELAY_SEC = 60
LIVE_ACTIVE = frozenset({"is_live", "is_upcoming", "post_live"})

_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def normalize_previous_mode(value: Any) -> str:
    raw = str(value or "none").strip().lower()
    return raw if raw in PREVIOUS_MODES else "none"


def normalize_previous_count(value: Any) -> int:
    try:
        n = int(value) if value is not None else DEFAULT_PREVIOUS_COUNT
    except (TypeError, ValueError):
        n = DEFAULT_PREVIOUS_COUNT
    return max(PREVIOUS_COUNT_MIN, min(PREVIOUS_COUNT_MAX, n))


def normalize_quality_preset(value: Any) -> str:
    raw = str(value or DEFAULT_PRESET).strip()
    return raw if raw in QUALITY_FORMATS else DEFAULT_PRESET


def catalog_max_videos() -> int:
    return int(app_settings.load().get("channel_catalog_max_videos") or 1000)


def catalog_row_is_short(row: ChannelCatalogVideo) -> bool:
    return is_youtube_short_entry(
        {
            "url": row.url,
            "title": row.title,
            "duration": row.duration,
            "published_at": row.published_at,
        }
    )


def should_skip_live(
    live_status: Optional[str],
    duration: Optional[float],
    *,
    include_completed_streams: bool,
) -> Optional[str]:
    """Return a skip reason, or None if the row may be downloaded."""
    status = (live_status or "").strip().lower()
    if status in LIVE_ACTIVE:
        return "live"
    if status == "was_live":
        return None if include_completed_streams else "completed_stream"
    dur_ok = False
    try:
        dur_ok = duration is not None and float(duration) > 0
    except (TypeError, ValueError):
        dur_ok = False
    if not status and not dur_ok:
        return "live"
    return None


def is_active_live_status(live_status: Optional[str]) -> bool:
    return (live_status or "").strip().lower() in LIVE_ACTIVE


def get_policy(session: Session, channel_url: str) -> Optional[ChannelAutodownload]:
    from .channel_catalog.runtime import (
        _channel_identity_keys,
        _normalize_channel_url,
    )

    url = _normalize_channel_url(channel_url)
    exact = session.exec(
        select(ChannelAutodownload).where(ChannelAutodownload.channel_url == url)
    ).first()
    if exact is not None:
        return exact
    keys = _channel_identity_keys(url)
    if not keys:
        return None
    for row in session.exec(select(ChannelAutodownload)).all():
        if _channel_identity_keys(row.channel_url) & keys:
            return row
    return None


def list_enabled_policies(session: Session) -> list[ChannelAutodownload]:
    return list(
        session.exec(
            select(ChannelAutodownload).where(ChannelAutodownload.enabled == True)  # noqa: E712
        ).all()
    )


def upsert_policy(
    session: Session,
    *,
    channel_url: str,
    channel_name: Optional[str],
    enabled: bool,
    previous_mode: str,
    previous_count: Optional[int],
    quality_preset: str,
    include_completed_streams: bool,
) -> ChannelAutodownload:
    from .channel_catalog.runtime import _normalize_channel_url

    url = _normalize_channel_url(channel_url)
    row = get_policy(session, url)
    was_enabled = bool(row and row.enabled)
    if row is None:
        row = ChannelAutodownload(channel_url=url)
        session.add(row)
    row.channel_name = (channel_name or "").strip() or row.channel_name
    row.enabled = bool(enabled)
    row.previous_mode = normalize_previous_mode(previous_mode)
    row.previous_count = normalize_previous_count(previous_count)
    row.quality_preset = normalize_quality_preset(quality_preset)
    row.include_completed_streams = bool(include_completed_streams)
    if row.enabled and not was_enabled:
        row.anchor_ready = False
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def active_youtube_ids(session: Session) -> set[str]:
    jobs = session.exec(
        select(DownloadJob).where(
            DownloadJob.status.in_([JobStatus.queued, JobStatus.downloading]),
            DownloadJob.destination == DownloadDestination.library.value,
        )
    ).all()
    ids: set[str] = set()
    for job in jobs:
        yt_id = youtube_video_id(job.url or "")
        if yt_id:
            ids.add(yt_id)
    return ids


def candidate_skip_reason(
    row: ChannelCatalogVideo,
    *,
    include_completed_streams: bool,
    library_ids: set[str],
    queued_ids: set[str],
) -> Optional[str]:
    if catalog_row_is_short(row):
        return "short"
    live = should_skip_live(
        row.live_status,
        row.duration,
        include_completed_streams=include_completed_streams,
    )
    if live:
        return live
    if row.yt_id in library_ids:
        return "library"
    if row.yt_id in queued_ids:
        return "queued"
    return None


def backfill_window(
    rows: list[ChannelCatalogVideo],
    previous_mode: str,
    previous_count: Optional[int],
) -> list[ChannelCatalogVideo]:
    ordered = sorted(rows, key=lambda r: int(r.position or 0))
    mode = normalize_previous_mode(previous_mode)
    if mode == "none":
        return []
    if mode == "all":
        return ordered
    n = normalize_previous_count(previous_count)
    return ordered[:n]


def enqueue_catalog_row(
    session: Session,
    row: ChannelCatalogVideo,
    policy: ChannelAutodownload,
) -> Optional[int]:
    from . import downloader

    yt_id = row.yt_id
    if not yt_id:
        return None
    raw_url = row.url or f"https://www.youtube.com/watch?v={yt_id}"
    url = clean_url(raw_url, keep_playlist=False)
    with downloader.job_mutate_lock:
        queued = active_youtube_ids(session)
        if yt_id in queued:
            return None
        if library.find_video_by_youtube_id(session, yt_id) is not None:
            return None
        job = DownloadJob(
            url=url,
            quality_preset=policy.quality_preset or DEFAULT_PRESET,
            status=JobStatus.queued,
            title=row.title,
            channel=policy.channel_name,
            thumbnail_url=row.thumbnail_url,
            video_codec=default_download_video_codec(),
            destination=DownloadDestination.library.value,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id
    if job_id is not None:
        downloader.enqueue_download(job_id)
    return job_id


def _eligible_rows(
    session: Session,
    policy: ChannelAutodownload,
    rows: list[ChannelCatalogVideo],
    *,
    queued_ids: set[str],
) -> list[ChannelCatalogVideo]:
    lib_ids = set(library.youtube_library_map(session).keys())
    out: list[ChannelCatalogVideo] = []
    for row in rows:
        if candidate_skip_reason(
            row,
            include_completed_streams=policy.include_completed_streams,
            library_ids=lib_ids,
            queued_ids=queued_ids,
        ):
            continue
        out.append(row)
    return out


def pending_estimate(session: Session, policy: ChannelAutodownload) -> int:
    from .channel_catalog.runtime import get_catalog_by_url

    catalog = get_catalog_by_url(session, policy.channel_url)
    if catalog is None or catalog.id is None:
        return 0
    rows = list(
        session.exec(
            select(ChannelCatalogVideo)
            .where(ChannelCatalogVideo.catalog_id == catalog.id)
            .order_by(ChannelCatalogVideo.position.asc())
        ).all()
    )
    window = backfill_window(rows, policy.previous_mode, policy.previous_count)
    queued = active_youtube_ids(session)
    return len(_eligible_rows(session, policy, window, queued_ids=queued))


def policy_to_read(
    session: Session,
    policy: Optional[ChannelAutodownload],
    *,
    channel_url: Optional[str] = None,
    channel_name: Optional[str] = None,
) -> dict[str, Any]:
    max_videos = catalog_max_videos()
    if policy is None:
        return {
            "configured": False,
            "enabled": False,
            "previous_mode": "none",
            "previous_count": DEFAULT_PREVIOUS_COUNT,
            "quality_preset": DEFAULT_PRESET,
            "include_completed_streams": False,
            "channel_url": channel_url,
            "channel_name": channel_name,
            "pending_estimate": 0,
            "catalog_max_videos": max_videos,
        }
    return {
        "configured": True,
        "enabled": bool(policy.enabled),
        "previous_mode": normalize_previous_mode(policy.previous_mode),
        "previous_count": normalize_previous_count(policy.previous_count),
        "quality_preset": normalize_quality_preset(policy.quality_preset),
        "include_completed_streams": bool(policy.include_completed_streams),
        "channel_url": policy.channel_url,
        "channel_name": policy.channel_name or channel_name,
        "pending_estimate": pending_estimate(session, policy),
        "catalog_max_videos": max_videos,
    }


def after_catalog_update(
    channel_url: str,
    *,
    new_yt_ids: Optional[list[str]] = None,
    live_finished_ids: Optional[list[str]] = None,
    source: str = "head",
) -> int:
    """Enqueue matching catalog videos after a feed-head sync or index page."""
    from .channel_catalog.runtime import _normalize_channel_url, get_catalog_by_url

    url = _normalize_channel_url(channel_url)
    new_ids = [i for i in (new_yt_ids or []) if i]
    finished_ids = [i for i in (live_finished_ids or []) if i]
    enqueued = 0
    with Session(engine) as session:
        policy = get_policy(session, url)
        if policy is None or not policy.enabled:
            return 0
        catalog = get_catalog_by_url(session, url)
        if catalog is None or catalog.id is None:
            if source == "head" and not policy.anchor_ready:
                policy.anchor_ready = True
                policy.updated_at = utcnow()
                session.add(policy)
                session.commit()
            return 0
        rows = list(
            session.exec(
                select(ChannelCatalogVideo)
                .where(ChannelCatalogVideo.catalog_id == catalog.id)
                .order_by(ChannelCatalogVideo.position.asc())
            ).all()
        )
        by_id = {r.yt_id: r for r in rows}
        queued = active_youtube_ids(session)
        want_ids: list[str] = []
        if source == "head":
            ready = bool(policy.anchor_ready)
            if not ready:
                policy.anchor_ready = True
                policy.updated_at = utcnow()
                session.add(policy)
                session.commit()
            if ready:
                want_ids.extend(new_ids)
                want_ids.extend(finished_ids)
        window = backfill_window(rows, policy.previous_mode, policy.previous_count)
        seen: set[str] = set()
        targets: list[ChannelCatalogVideo] = []
        for yt_id in want_ids:
            row = by_id.get(yt_id)
            if row is None or yt_id in seen:
                continue
            seen.add(yt_id)
            targets.append(row)
        for row in window:
            if row.yt_id in seen:
                continue
            seen.add(row.yt_id)
            targets.append(row)
        eligible = _eligible_rows(session, policy, targets, queued_ids=queued)
        for row in eligible:
            job_id = enqueue_catalog_row(session, row, policy)
            if job_id is not None:
                enqueued += 1
                queued.add(row.yt_id)
    return enqueued


def apply_saved_policy(
    channel_url: str, *, channel_name: Optional[str] = None
) -> None:
    """Sync the feed head (and maybe full index) then enqueue per the saved policy."""
    from .channel_catalog import enqueue_channel, sync_feed_head
    from .channel_catalog.runtime import _normalize_channel_url, get_catalog_by_url

    url = _normalize_channel_url(channel_url)
    with Session(engine) as session:
        policy = get_policy(session, url)
        if policy is None or not policy.enabled:
            return
        catalog = get_catalog_by_url(session, url)
        incomplete = (
            catalog is None
            or catalog.status
            not in (ChannelCatalogStatus.ready, ChannelCatalogStatus.indexing)
            or not catalog.complete
        )
        if policy.previous_mode == "all" and incomplete:
            enqueue_channel(url, channel_name=channel_name or policy.channel_name)
    try:
        sync_feed_head(url, channel_name=channel_name, limit=50)
    except Exception:  # noqa: BLE001
        logger.debug("autodownload feed-head sync failed for %s", url, exc_info=True)
        after_catalog_update(url, new_yt_ids=[], source="head")


def schedule_apply_saved_policy(
    channel_url: str, *, channel_name: Optional[str] = None
) -> None:
    thread = threading.Thread(
        target=apply_saved_policy,
        kwargs={"channel_url": channel_url, "channel_name": channel_name},
        daemon=True,
        name="autodownload-apply",
    )
    thread.start()


def poll_enabled_channels() -> None:
    from .channel_catalog import sync_feed_head

    with Session(engine) as session:
        policies = list_enabled_policies(session)
        targets = [(p.channel_url, p.channel_name) for p in policies]
    for channel_url, channel_name in targets:
        if _stop.is_set():
            return
        try:
            sync_feed_head(channel_url, channel_name=channel_name, limit=50)
        except Exception:  # noqa: BLE001
            logger.debug(
                "autodownload poll failed for %s", channel_url, exc_info=True
            )


def _worker_loop() -> None:
    if _stop.wait(timeout=STARTUP_DELAY_SEC):
        return
    while not _stop.is_set():
        try:
            poll_enabled_channels()
        except Exception:  # noqa: BLE001
            logger.debug("autodownload poller error", exc_info=True)
        if _stop.wait(timeout=POLL_INTERVAL_SEC):
            return


def start_autodownload_worker() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(
        target=_worker_loop, daemon=True, name="autodownload-poller"
    )
    _thread.start()


def stop_autodownload_worker() -> None:
    _stop.set()
    thread = _thread
    if thread is not None and thread.is_alive():
        thread.join(timeout=5)

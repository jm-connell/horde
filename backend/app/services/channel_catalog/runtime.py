"""Catalog worker runtime state, enqueue, and background loop."""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from sqlmodel import Session, col, select

from ...database import engine
from ...models import ChannelCatalog, ChannelCatalogStatus, ChannelCatalogVideo, utcnow
from .. import app_settings

logger = logging.getLogger(__name__)

_PAGE_SIZE = 50
_DESC_LIMIT = app_settings.CHANNEL_CATALOG_DESC_LIMIT
_MAX_DESC_CHARS = 4000

_stop = threading.Event()
_wake = threading.Event()
_thread: Optional[threading.Thread] = None
_state_lock = threading.Lock()
_runtime: dict[str, Any] = {
    "running": False,
    "current_channel": None,
    "current_channel_url": None,
    "current_phase": None,
    "done": 0,
    "total": 0,
    "catalog_id": None,
}


def _normalize_channel_url(channel_url: str) -> str:
    url = channel_url.strip().rstrip("/")
    for suffix in ("/videos", "/shorts", "/streams", "/playlists", "/featured", "/about"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
            break
    return url.rstrip("/")


def _enabled() -> bool:
    return bool(app_settings.load().get("channel_catalog_enabled", True))


def _max_videos() -> int:
    return app_settings.clamp_catalog_max_videos(
        app_settings.load().get("channel_catalog_max_videos")
    )


def _set_runtime(**kwargs: Any) -> None:
    with _state_lock:
        _runtime.update(kwargs)


def get_runtime_status() -> dict[str, Any]:
    with _state_lock:
        runtime = dict(_runtime)
    with Session(engine) as session:
        queued = session.exec(
            select(func.count(ChannelCatalog.id)).where(
                ChannelCatalog.status.in_(  # type: ignore[attr-defined]
                    [ChannelCatalogStatus.queued, ChannelCatalogStatus.indexing]
                )
            )
        ).one()
        catalogs = session.exec(
            select(ChannelCatalog).order_by(ChannelCatalog.updated_at.desc()).limit(40)
        ).all()
        items = [
            {
                "id": c.id,
                "channel_url": c.channel_url,
                "channel_name": c.channel_name,
                "status": c.status.value if hasattr(c.status, "value") else str(c.status),
                "indexed_count": c.indexed_count,
                "channel_total": c.channel_total,
                "complete": bool(c.complete),
                "max_videos": c.max_videos,
                "phase": c.phase,
                "last_error": c.last_error,
                "started_at": c.started_at.isoformat() if c.started_at else None,
                "finished_at": c.finished_at.isoformat() if c.finished_at else None,
                "updated_at": c.updated_at.isoformat() if c.updated_at else None,
            }
            for c in catalogs
        ]
    return {
        **runtime,
        "enabled": _enabled(),
        "queue_depth": int(queued or 0),
        "catalogs": items,
    }


def get_catalog_by_url(
    session: Session, channel_url: str
) -> Optional[ChannelCatalog]:
    norm = _normalize_channel_url(channel_url)
    rows = session.exec(select(ChannelCatalog)).all()
    for row in rows:
        if _normalize_channel_url(row.channel_url) == norm:
            return row
    return None


def enqueue_channel(
    channel_url: str,
    *,
    channel_name: Optional[str] = None,
    force: bool = False,
) -> Optional[int]:
    """Queue a channel for catalog indexing. Returns catalog id or None."""
    if not _enabled():
        return None
    url = _normalize_channel_url(channel_url)
    if not url:
        return None
    host = urlparse(url).netloc.lower().replace("www.", "")
    if "youtube" not in host and "youtu.be" not in host:
        return None

    max_videos = _max_videos()
    with Session(engine) as session:
        catalog = get_catalog_by_url(session, url)
        if catalog is None:
            catalog = ChannelCatalog(
                channel_url=url,
                channel_name=channel_name,
                status=ChannelCatalogStatus.queued,
                max_videos=max_videos,
                updated_at=utcnow(),
            )
            session.add(catalog)
            session.commit()
            session.refresh(catalog)
            catalog_id = catalog.id
        else:
            if channel_name and not catalog.channel_name:
                catalog.channel_name = channel_name
            active = catalog.status in (
                ChannelCatalogStatus.queued,
                ChannelCatalogStatus.indexing,
            )
            if active and not force:
                return catalog.id
            if (
                catalog.status == ChannelCatalogStatus.ready
                and not force
                and catalog.indexed_count > 0
            ):
                # Already indexed; periodic refresh handles updates.
                return catalog.id
            catalog.status = ChannelCatalogStatus.queued
            catalog.max_videos = max_videos
            catalog.last_error = None
            catalog.phase = None
            catalog.updated_at = utcnow()
            session.add(catalog)
            session.commit()
            catalog_id = catalog.id

    _wake.set()
    return catalog_id


def maybe_enqueue_for_feed(
    channel_url: str, *, channel_name: Optional[str] = None
) -> None:
    """Enqueue if missing or stale beyond metadata sync interval."""
    if not _enabled():
        return
    try:
        interval = int(
            app_settings.load().get("metadata_sync_interval_hours") or 24
        )
    except (TypeError, ValueError):
        interval = 24
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, interval))

    with Session(engine) as session:
        catalog = get_catalog_by_url(session, channel_url)
        if catalog is None:
            enqueue_channel(channel_url, channel_name=channel_name)
            return
        if catalog.status in (
            ChannelCatalogStatus.queued,
            ChannelCatalogStatus.indexing,
        ):
            return
        updated = catalog.updated_at
        if updated is not None and updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        if catalog.status == ChannelCatalogStatus.ready and updated and updated >= cutoff:
            return
        if catalog.status == ChannelCatalogStatus.error:
            enqueue_channel(channel_url, channel_name=channel_name, force=True)
            return
        # Stale ready catalog — refresh.
        enqueue_channel(channel_url, channel_name=channel_name, force=True)


def _library_channel_targets() -> list[tuple[Optional[str], str]]:
    """Library channels that have a YouTube URL: (name, url)."""
    with Session(engine) as session:
        from . import library as library_svc

        stats = library_svc.channel_stats(session)
        return [
            (row.channel, row.channel_url)
            for row in stats
            if row.channel_url
        ]


def enqueue_all_library_channels(*, force: bool = True) -> dict[str, Any]:
    """Queue catalog indexing for every library channel that has a URL."""
    if not _enabled():
        return {
            "queued": 0,
            "skipped": 0,
            "refreshed": 0,
            "detail": "Channel catalog indexing is disabled",
        }
    queued = 0
    skipped = 0
    for name, url in _library_channel_targets():
        catalog_id = enqueue_channel(url, channel_name=name, force=force)
        if catalog_id is None:
            skipped += 1
        else:
            # Count as queued if we just set it (or it was already active).
            queued += 1
    return {
        "queued": queued,
        "skipped": skipped,
        "refreshed": 0,
        "detail": f"Queued {queued} channel(s)"
        + (f", skipped {skipped}" if skipped else ""),
    }


def refresh_all_library_channels() -> dict[str, Any]:
    """Incremental refresh: full index for new/error; head sync for ready catalogs."""
    if not _enabled():
        return {
            "queued": 0,
            "skipped": 0,
            "refreshed": 0,
            "detail": "Channel catalog indexing is disabled",
        }
    queued = 0
    skipped = 0
    refreshed = 0
    for name, url in _library_channel_targets():
        with Session(engine) as session:
            catalog = get_catalog_by_url(session, url)
            status = catalog.status if catalog else None
            indexed = int(catalog.indexed_count or 0) if catalog else 0

        if status in (
            ChannelCatalogStatus.queued,
            ChannelCatalogStatus.indexing,
        ):
            skipped += 1
            continue

        if (
            status == ChannelCatalogStatus.ready
            and indexed > 0
        ):
            try:
                sync_feed_head(url, channel_name=name, limit=50)
                refreshed += 1
            except Exception:  # noqa: BLE001
                logger.debug(
                    "incremental head sync failed for %s", url, exc_info=True
                )
                skipped += 1
            continue

        # Missing, idle/incomplete, or error → full index queue.
        force = status == ChannelCatalogStatus.error
        catalog_id = enqueue_channel(url, channel_name=name, force=force)
        if catalog_id is None:
            skipped += 1
        else:
            queued += 1

    parts: list[str] = []
    if queued:
        parts.append(f"queued {queued} for full index")
    if refreshed:
        parts.append(f"refreshed {refreshed} ready channel(s)")
    if skipped:
        parts.append(f"skipped {skipped}")
    detail = (
        "; ".join(parts).capitalize()
        if parts
        else "No library channels to refresh"
    )
    return {
        "queued": queued,
        "skipped": skipped,
        "refreshed": refreshed,
        "detail": detail,
    }


def refresh_stale_catalogs() -> None:
    """Called from metadata sync worker: re-queue ready catalogs past interval."""
    if not _enabled():
        return
    try:
        interval = int(
            app_settings.load().get("metadata_sync_interval_hours") or 24
        )
    except (TypeError, ValueError):
        interval = 24
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, interval))
    with Session(engine) as session:
        rows = session.exec(
            select(ChannelCatalog).where(
                ChannelCatalog.status == ChannelCatalogStatus.ready
            )
        ).all()
        stale_urls: list[tuple[str, Optional[str]]] = []
        for catalog in rows:
            updated = catalog.updated_at
            if updated is not None and updated.tzinfo is None:
                updated = updated.replace(tzinfo=timezone.utc)
            if updated is None or updated < cutoff:
                stale_urls.append((catalog.channel_url, catalog.channel_name))
    for channel_url, channel_name in stale_urls:
        enqueue_channel(channel_url, channel_name=channel_name, force=True)



def _next_queued(session: Session) -> Optional[ChannelCatalog]:
    return session.exec(
        select(ChannelCatalog)
        .where(ChannelCatalog.status == ChannelCatalogStatus.queued)
        .order_by(ChannelCatalog.updated_at.asc())
        .limit(1)
    ).first()


def _worker_loop() -> None:
    from .index import index_catalog

    while not _stop.is_set():
        if not _enabled():
            _wake.wait(timeout=30)
            _wake.clear()
            continue
        catalog_id: Optional[int] = None
        with Session(engine) as session:
            job = _next_queued(session)
            if job is not None and job.id is not None:
                catalog_id = job.id
        if catalog_id is not None:
            index_catalog(catalog_id)
            continue
        _wake.wait(timeout=15)
        _wake.clear()


def start_catalog_worker() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(
        target=_worker_loop, daemon=True, name="horde-channel-catalog"
    )
    _thread.start()


def recover_catalog_jobs() -> int:
    """Requeue catalogs left indexing after a process crash/restart."""
    reset = 0
    with Session(engine) as session:
        rows = session.exec(
            select(ChannelCatalog).where(
                ChannelCatalog.status == ChannelCatalogStatus.indexing
            )
        ).all()
        for catalog in rows:
            catalog.status = ChannelCatalogStatus.queued
            catalog.updated_at = utcnow()
            session.add(catalog)
            reset += 1
        if reset:
            session.commit()
    if reset:
        logger.info("Recovered %s stuck catalog(s) → queued", reset)
        _wake.set()
    return reset


def stop_catalog_worker() -> None:
    _stop.set()
    _wake.set()



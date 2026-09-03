"""Catalog worker runtime state, enqueue, and background loop."""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from sqlmodel import Session, col, func, select

from ...database import engine
from ...models import (
    ChannelCatalog,
    ChannelCatalogSkip,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    utcnow,
)
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


_TAB_SUFFIXES = (
    "/videos",
    "/shorts",
    "/streams",
    "/playlists",
    "/featured",
    "/about",
    "/search",
)


def _normalize_channel_url(channel_url: str) -> str:
    raw = (channel_url or "").strip()
    if not raw:
        return raw
    parsed = urlparse(raw)
    host = (parsed.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = (parsed.path or "").rstrip("/")
    for suffix in _TAB_SUFFIXES:
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    path = path.rstrip("/")
    parts = path.split("/")
    if len(parts) >= 2 and parts[1].startswith("@"):
        parts[1] = parts[1].lower()
        path = "/".join(parts)
    if not host:
        return path or raw.rstrip("/")
    scheme = (parsed.scheme or "https").lower()
    return f"{scheme}://{host}{path}"


def _channel_identity_keys(channel_url: str) -> frozenset[str]:
    """Comparable keys for a YouTube channel URL (normalized url, handle, UC id)."""
    norm = _normalize_channel_url(channel_url)
    if not norm:
        return frozenset()
    keys = {f"url:{norm.casefold()}"}
    parsed = urlparse(norm if "://" in norm else f"https://{norm}")
    parts = [p for p in (parsed.path or "").split("/") if p]
    if not parts:
        return frozenset(keys)
    if parts[0].startswith("@"):
        keys.add(f"handle:{parts[0].casefold()}")
    elif parts[0] == "channel" and len(parts) >= 2:
        keys.add(f"id:{parts[1]}")
    elif parts[0] in ("c", "user") and len(parts) >= 2:
        keys.add(f"{parts[0]}:{parts[1].casefold()}")
    return frozenset(keys)


def _identity_conflict(a: frozenset[str], b: frozenset[str]) -> bool:
    a_handles = {k for k in a if k.startswith("handle:")}
    b_handles = {k for k in b if k.startswith("handle:")}
    a_ids = {k for k in a if k.startswith("id:")}
    b_ids = {k for k in b if k.startswith("id:")}
    if a_handles and b_handles and a_handles != b_handles:
        return True
    if a_ids and b_ids and a_ids != b_ids:
        return True
    return False


def _compatible_url_shapes(a: frozenset[str], b: frozenset[str]) -> bool:
    """True when one URL is /@handle and the other is /channel/UC… (aliases)."""
    a_handle = any(k.startswith("handle:") for k in a)
    b_handle = any(k.startswith("handle:") for k in b)
    a_id = any(k.startswith("id:") for k in a)
    b_id = any(k.startswith("id:") for k in b)
    return (a_handle and b_id) or (a_id and b_handle)


def _same_channel_catalog(
    row: ChannelCatalog,
    channel_url: str,
    *,
    channel_name: Optional[str] = None,
) -> bool:
    row_keys = _channel_identity_keys(row.channel_url)
    req_keys = _channel_identity_keys(channel_url)
    if row_keys & req_keys:
        return True
    if _identity_conflict(row_keys, req_keys):
        return False
    name = (channel_name or "").strip().casefold()
    row_name = (row.channel_name or "").strip().casefold()
    if not name or name != row_name:
        return False
    return _compatible_url_shapes(row_keys, req_keys)


def _catalogs_are_aliases(left: ChannelCatalog, right: ChannelCatalog) -> bool:
    left_keys = _channel_identity_keys(left.channel_url)
    right_keys = _channel_identity_keys(right.channel_url)
    if left_keys & right_keys:
        return True
    if _identity_conflict(left_keys, right_keys):
        return False
    left_name = (left.channel_name or "").strip().casefold()
    right_name = (right.channel_name or "").strip().casefold()
    if not left_name or left_name != right_name:
        return False
    return _compatible_url_shapes(left_keys, right_keys)


def _catalog_keeper_rank(catalog: ChannelCatalog) -> tuple:
    keys = _channel_identity_keys(catalog.channel_url)
    handle = any(k.startswith("handle:") for k in keys)
    ready = catalog.status == ChannelCatalogStatus.ready
    not_error = catalog.status != ChannelCatalogStatus.error
    return (
        int(catalog.indexed_count or 0),
        int(ready),
        int(not_error),
        int(handle),
        -(catalog.id or 0),
    )


def _prefer_channel_url(urls: list[str]) -> str:
    def quality(url: str) -> tuple:
        keys = _channel_identity_keys(url)
        handle = any(k.startswith("handle:") for k in keys)
        channel_id = any(k.startswith("id:") for k in keys)
        return (int(handle), int(channel_id), -len(url))

    return max(urls, key=quality)


def _delete_catalog_tree(session: Session, catalog: ChannelCatalog) -> None:
    from .skips import delete_catalog_video_row

    videos = session.exec(
        select(ChannelCatalogVideo).where(
            ChannelCatalogVideo.catalog_id == catalog.id
        )
    ).all()
    for row in videos:
        delete_catalog_video_row(session, row)
    skips = session.exec(
        select(ChannelCatalogSkip).where(ChannelCatalogSkip.catalog_id == catalog.id)
    ).all()
    for skip in skips:
        session.delete(skip)
    session.flush()
    session.delete(catalog)


def reconcile_duplicate_catalogs(session: Session) -> int:
    """Merge catalogs that are the same YouTube channel. Returns rows removed."""
    rows = session.exec(select(ChannelCatalog)).all()
    if len(rows) < 2:
        return 0

    parent = {c.id: c.id for c in rows if c.id is not None}

    def find(cid: int) -> int:
        while parent[cid] != cid:
            parent[cid] = parent[parent[cid]]
            cid = parent[cid]
        return cid

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i, left in enumerate(rows):
        if left.id is None:
            continue
        for right in rows[i + 1 :]:
            if right.id is None:
                continue
            if _catalogs_are_aliases(left, right):
                union(left.id, right.id)

    groups: dict[int, list[ChannelCatalog]] = {}
    by_id = {c.id: c for c in rows if c.id is not None}
    for cid in parent:
        groups.setdefault(find(cid), []).append(by_id[cid])

    removed = 0
    for group in groups.values():
        if len(group) < 2:
            continue
        keeper = max(group, key=_catalog_keeper_rank)
        losers = [c for c in group if c.id != keeper.id]
        preferred = _prefer_channel_url(
            [keeper.channel_url] + [c.channel_url for c in losers]
        )
        sibling_ready = any(c.status == ChannelCatalogStatus.ready for c in group)
        for loser in losers:
            logger.info(
                "Merging duplicate catalog %s (%s) into %s (%s)",
                loser.id,
                loser.channel_url,
                keeper.id,
                keeper.channel_url,
            )
            _delete_catalog_tree(session, loser)
            removed += 1
        if preferred and preferred != keeper.channel_url:
            keeper.channel_url = preferred
        if (
            sibling_ready
            and keeper.status
            not in (ChannelCatalogStatus.queued, ChannelCatalogStatus.indexing)
        ):
            keeper.status = ChannelCatalogStatus.ready
            keeper.last_error = None
        if not keeper.channel_name:
            for c in group:
                if c.channel_name:
                    keeper.channel_name = c.channel_name
                    break
        session.add(keeper)
        session.commit()
    return removed


def _enabled() -> bool:
    return bool(app_settings.load().get("channel_catalog_enabled", True))


def _max_videos() -> int:
    return app_settings.clamp_catalog_max_videos(
        app_settings.load().get("channel_catalog_max_videos")
    )


def _set_runtime(**kwargs: Any) -> None:
    with _state_lock:
        _runtime.update(kwargs)


def should_stop() -> bool:
    """True when the catalog worker has been asked to shut down."""
    return _stop.is_set()


def get_runtime_status() -> dict[str, Any]:
    with _state_lock:
        runtime = dict(_runtime)
    with Session(engine) as session:
        reconcile_duplicate_catalogs(session)
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
        system_yt = app_settings.direct_youtube_search_system()
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
                "direct_youtube_search": c.direct_youtube_search,
                "direct_youtube_search_effective": (
                    app_settings.direct_youtube_search_effective(
                        c.direct_youtube_search, system_yt
                    )
                ),
            }
            for c in catalogs
        ]
    return {
        **runtime,
        "enabled": _enabled(),
        "queue_depth": int(queued or 0),
        "catalogs": items,
        "direct_youtube_search": system_yt,
    }


def get_catalog_by_url(
    session: Session,
    channel_url: str,
    *,
    channel_name: Optional[str] = None,
) -> Optional[ChannelCatalog]:
    rows = session.exec(select(ChannelCatalog)).all()
    matches = [
        row
        for row in rows
        if _same_channel_catalog(row, channel_url, channel_name=channel_name)
    ]
    if not matches:
        return None
    return max(matches, key=_catalog_keeper_rank)


def is_youtube_channel_url(channel_url: str) -> bool:
    url = (channel_url or "").strip()
    if not url:
        return False
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.netloc or "").lower().replace("www.", "")
    return "youtube.com" in host or host == "youtu.be"


def youtube_search_pref(
    session: Session,
    channel_url: str,
    *,
    channel_name: Optional[str] = None,
    system: Optional[bool] = None,
) -> dict[str, Any]:
    """Override + effective Direct YouTube search for a channel URL."""
    if system is None:
        system = app_settings.direct_youtube_search_system()
    catalog = get_catalog_by_url(
        session, channel_url, channel_name=channel_name
    )
    override = catalog.direct_youtube_search if catalog is not None else None
    return {
        "channel_url": (
            catalog.channel_url if catalog is not None else _normalize_channel_url(channel_url)
        ),
        "direct_youtube_search": override,
        "direct_youtube_search_effective": app_settings.direct_youtube_search_effective(
            override, system
        ),
    }


def set_direct_youtube_search(
    channel_url: str,
    value: Optional[bool],
    *,
    channel_name: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Set per-channel override (None = inherit). Creates a catalog row if needed."""
    url = _normalize_channel_url(channel_url)
    if not url or not is_youtube_channel_url(url):
        return None
    with Session(engine) as session:
        reconcile_duplicate_catalogs(session)
        catalog = get_catalog_by_url(
            session, url, channel_name=channel_name
        )
        if catalog is None:
            catalog = ChannelCatalog(
                channel_url=url,
                channel_name=channel_name,
                status=ChannelCatalogStatus.idle,
                max_videos=_max_videos(),
                updated_at=utcnow(),
            )
            session.add(catalog)
            session.commit()
            session.refresh(catalog)
        catalog.direct_youtube_search = value
        if channel_name and not catalog.channel_name:
            catalog.channel_name = channel_name
        catalog.updated_at = utcnow()
        session.add(catalog)
        session.commit()
        return youtube_search_pref(
            session, catalog.channel_url, channel_name=catalog.channel_name
        )


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
        reconcile_duplicate_catalogs(session)
        catalog = get_catalog_by_url(
            session, url, channel_name=channel_name
        )
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
            dirty = False
            if channel_name and not catalog.channel_name:
                catalog.channel_name = channel_name
                dirty = True
            preferred = _prefer_channel_url([catalog.channel_url, url])
            if preferred != catalog.channel_url:
                catalog.channel_url = preferred
                dirty = True
            active = catalog.status in (
                ChannelCatalogStatus.queued,
                ChannelCatalogStatus.indexing,
            )
            if active and not force:
                if dirty:
                    session.add(catalog)
                    session.commit()
                return catalog.id
            if (
                catalog.status == ChannelCatalogStatus.ready
                and not force
                and catalog.indexed_count > 0
            ):
                if dirty:
                    session.add(catalog)
                    session.commit()
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
        catalog = get_catalog_by_url(
            session, channel_url, channel_name=channel_name
        )
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
        from .. import library as library_svc

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
            reconcile_duplicate_catalogs(session)
            catalog = get_catalog_by_url(session, url, channel_name=name)
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
                from .index import sync_feed_head

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
    try:
        with Session(engine) as session:
            reconcile_duplicate_catalogs(session)
    except Exception:  # noqa: BLE001
        logger.debug("catalog duplicate reconcile skipped", exc_info=True)
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



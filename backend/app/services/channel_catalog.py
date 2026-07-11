"""Background channel catalog indexing (flat list + newest descriptions)."""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from sqlmodel import Session, col, func, or_, select

from ..database import engine
from ..models import (
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    utcnow,
)
from . import app_settings
from .feed_meta_cache import parse_upload_date
from .ytdlp_common import apply_cookie_opts, extract_info_gated, youtube_extractor_args

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


def enqueue_all_library_channels(*, force: bool = True) -> dict[str, Any]:
    """Queue catalog indexing for every library channel that has a URL."""
    if not _enabled():
        return {"queued": 0, "skipped": 0, "detail": "Channel catalog indexing is disabled"}
    queued = 0
    skipped = 0
    with Session(engine) as session:
        from . import library as library_svc

        stats = library_svc.channel_stats(session)
        targets = [
            (row.channel, row.channel_url)
            for row in stats
            if row.channel_url
        ]
    for name, url in targets:
        catalog_id = enqueue_channel(url, channel_name=name, force=force)
        if catalog_id is None:
            skipped += 1
        else:
            # Count as queued if we just set it (or it was already active).
            queued += 1
    return {
        "queued": queued,
        "skipped": skipped,
        "detail": f"Queued {queued} channel(s)"
        + (f", skipped {skipped}" if skipped else ""),
    }
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
        for catalog in rows:
            updated = catalog.updated_at
            if updated is not None and updated.tzinfo is None:
                updated = updated.replace(tzinfo=timezone.utc)
            if updated is None or updated < cutoff:
                enqueue_channel(
                    catalog.channel_url,
                    channel_name=catalog.channel_name,
                    force=True,
                )


def _fetch_flat_page(channel_url: str, offset: int, limit: int) -> dict[str, Any]:
    from . import downloader

    return downloader.fetch_channel_feed(channel_url, offset=offset, limit=limit)


def _upsert_flat_entries(
    session: Session,
    catalog: ChannelCatalog,
    entries: list[dict[str, Any]],
    start_position: int,
) -> int:
    """Upsert flat entries starting at start_position. Returns next position."""
    pos = start_position
    for raw in entries:
        yt_id = raw.get("id")
        entry_url = raw.get("url")
        if not yt_id or not entry_url:
            continue
        existing = session.exec(
            select(ChannelCatalogVideo).where(
                ChannelCatalogVideo.catalog_id == catalog.id,
                ChannelCatalogVideo.yt_id == str(yt_id),
            )
        ).first()
        published = raw.get("published_at")
        if published is not None and not isinstance(published, str):
            published = parse_upload_date(published)
        if existing is None:
            existing = ChannelCatalogVideo(
                catalog_id=catalog.id,  # type: ignore[arg-type]
                yt_id=str(yt_id),
                url=str(entry_url),
            )
        existing.url = str(entry_url)
        existing.title = raw.get("title") or existing.title
        existing.duration = raw.get("duration") if raw.get("duration") is not None else existing.duration
        existing.view_count = (
            raw.get("view_count")
            if raw.get("view_count") is not None
            else existing.view_count
        )
        existing.published_at = published or existing.published_at
        existing.thumbnail_url = raw.get("thumbnail_url") or existing.thumbnail_url
        existing.position = pos
        existing.indexed_at = utcnow()
        session.add(existing)
        pos += 1
    session.commit()
    return pos


def _trim_beyond_cap(session: Session, catalog: ChannelCatalog) -> None:
    rows = session.exec(
        select(ChannelCatalogVideo)
        .where(ChannelCatalogVideo.catalog_id == catalog.id)
        .order_by(ChannelCatalogVideo.position.asc())
    ).all()
    keep_ids = {r.id for r in rows[: catalog.max_videos] if r.id is not None}
    for row in rows:
        if row.id is not None and row.id not in keep_ids:
            emb = session.exec(
                select(ChannelCatalogEmbedding).where(
                    ChannelCatalogEmbedding.catalog_video_id == row.id
                )
            ).first()
            if emb is not None:
                session.delete(emb)
            session.delete(row)
    session.commit()


def sync_feed_head(
    channel_url: str,
    *,
    channel_name: Optional[str] = None,
    limit: int = 50,
) -> dict[str, Any]:
    """Fetch the newest uploads from YouTube and merge into the local catalog.

    Used to keep the feed snappy (serve catalog first) while catching new uploads
    and refreshing metadata in the background.
    """
    url = _normalize_channel_url(channel_url)
    data = _fetch_flat_page(url, offset=0, limit=limit)
    entries = [e for e in (data.get("entries") or []) if e.get("id") and e.get("url")]
    pc = data.get("playlist_count")
    live_name = data.get("channel") or channel_name

    with Session(engine) as session:
        catalog = get_catalog_by_url(session, url)
        if catalog is None:
            if not _enabled():
                return data
            catalog = ChannelCatalog(
                channel_url=url,
                channel_name=live_name,
                status=ChannelCatalogStatus.ready,
                max_videos=_max_videos(),
                updated_at=utcnow(),
            )
            session.add(catalog)
            session.commit()
            session.refresh(catalog)
        else:
            if live_name and not catalog.channel_name:
                catalog.channel_name = live_name
            if isinstance(pc, int) and pc > 0:
                catalog.channel_total = pc

        existing = session.exec(
            select(ChannelCatalogVideo)
            .where(ChannelCatalogVideo.catalog_id == catalog.id)
            .order_by(ChannelCatalogVideo.position.asc())
        ).all()
        by_yt: dict[str, ChannelCatalogVideo] = {v.yt_id: v for v in existing}

        live_ids: list[str] = []
        for pos, raw in enumerate(entries):
            yt_id = str(raw["id"])
            live_ids.append(yt_id)
            row = by_yt.get(yt_id)
            published = raw.get("published_at")
            if published is not None and not isinstance(published, str):
                published = parse_upload_date(published)
            if row is None:
                row = ChannelCatalogVideo(
                    catalog_id=catalog.id,  # type: ignore[arg-type]
                    yt_id=yt_id,
                    url=str(raw["url"]),
                )
                by_yt[yt_id] = row
            row.url = str(raw["url"])
            row.title = raw.get("title") or row.title
            if raw.get("duration") is not None:
                row.duration = raw.get("duration")
            if raw.get("view_count") is not None:
                row.view_count = raw.get("view_count")
            if published:
                row.published_at = published
            if raw.get("thumbnail_url"):
                row.thumbnail_url = raw.get("thumbnail_url")
            row.position = pos
            row.indexed_at = utcnow()
            session.add(row)

        live_set = set(live_ids)
        next_pos = len(live_ids)
        for row in existing:
            if row.yt_id in live_set:
                continue
            row.position = next_pos
            next_pos += 1
            session.add(row)

        session.commit()
        _trim_beyond_cap(session, catalog)
        count = session.exec(
            select(func.count(ChannelCatalogVideo.id)).where(
                ChannelCatalogVideo.catalog_id == catalog.id
            )
        ).one()
        catalog.indexed_count = int(count or 0)
        if isinstance(pc, int) and pc > 0:
            catalog.channel_total = pc
        catalog.updated_at = utcnow()
        # Keep ready if we already were; don't clobber an in-progress full index.
        if catalog.status == ChannelCatalogStatus.idle:
            catalog.status = ChannelCatalogStatus.ready
        session.add(catalog)
        session.commit()

    return data


_head_sync_lock = threading.Lock()
_head_sync_inflight: set[str] = set()


def schedule_feed_head_sync(
    channel_url: str, *, channel_name: Optional[str] = None
) -> None:
    """Non-blocking newest-page sync; coalesces duplicate requests per channel."""
    url = _normalize_channel_url(channel_url)
    with _head_sync_lock:
        if url in _head_sync_inflight:
            return
        _head_sync_inflight.add(url)

    def _run() -> None:
        try:
            sync_feed_head(url, channel_name=channel_name, limit=50)
        except Exception:  # noqa: BLE001
            logger.debug("feed head sync failed for %s", url, exc_info=True)
        finally:
            with _head_sync_lock:
                _head_sync_inflight.discard(url)

    threading.Thread(target=_run, daemon=True, name="catalog-feed-head").start()


def _fetch_description(url: str) -> Optional[str]:
    opts = apply_cookie_opts(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extractor_args": youtube_extractor_args(),
        }
    )
    try:
        info = extract_info_gated(url, opts, cache_key=f"catalog-desc:{url}")
    except Exception:  # noqa: BLE001
        return None
    desc = info.get("description")
    if not isinstance(desc, str) or not desc.strip():
        return None
    return desc[:_MAX_DESC_CHARS]


def _run_description_pass(session: Session, catalog: ChannelCatalog) -> None:
    catalog.phase = "descriptions"
    catalog.updated_at = utcnow()
    session.add(catalog)
    session.commit()
    _set_runtime(current_phase="descriptions")

    rows = session.exec(
        select(ChannelCatalogVideo)
        .where(ChannelCatalogVideo.catalog_id == catalog.id)
        .where(ChannelCatalogVideo.position < _DESC_LIMIT)
        .order_by(ChannelCatalogVideo.position.asc())
    ).all()
    total = len(rows)
    _set_runtime(done=0, total=total)
    for i, row in enumerate(rows):
        if _stop.is_set():
            return
        if row.description:
            _set_runtime(done=i + 1)
            continue
        desc = _fetch_description(row.url)
        if desc:
            row.description = desc
            row.indexed_at = utcnow()
            session.add(row)
            session.commit()
        _set_runtime(done=i + 1)


def _enqueue_catalog_embeds(catalog_id: int) -> None:
    try:
        from ..models import AiJobKind
        from .ai import worker as ai_worker

        ai = app_settings.ai_settings()
        if not ai.get("enabled", True) or ai.get("paused"):
            return
        with Session(engine) as session:
            rows = session.exec(
                select(ChannelCatalogVideo)
                .where(ChannelCatalogVideo.catalog_id == catalog_id)
                .where(ChannelCatalogVideo.position < _DESC_LIMIT)
                .order_by(ChannelCatalogVideo.position.asc())
            ).all()
            for row in rows:
                if row.id is None:
                    continue
                if not (row.title or row.description):
                    continue
                ai_worker.enqueue_job(
                    AiJobKind.embed_catalog_video,
                    catalog_video_id=row.id,
                    force=False,
                )
    except Exception:  # noqa: BLE001
        logger.debug("catalog embed enqueue skipped", exc_info=True)


def _index_catalog(catalog_id: int) -> None:
    with Session(engine) as session:
        catalog = session.get(ChannelCatalog, catalog_id)
        if catalog is None:
            return
        catalog.status = ChannelCatalogStatus.indexing
        catalog.started_at = utcnow()
        catalog.finished_at = None
        catalog.last_error = None
        catalog.phase = "flat"
        catalog.max_videos = _max_videos()
        catalog.updated_at = utcnow()
        session.add(catalog)
        session.commit()
        session.refresh(catalog)

        channel_url = catalog.channel_url
        channel_name = catalog.channel_name
        max_videos = catalog.max_videos

    _set_runtime(
        running=True,
        current_channel=channel_name,
        current_channel_url=channel_url,
        current_phase="flat",
        done=0,
        total=max_videos,
        catalog_id=catalog_id,
    )

    try:
        offset = 0
        position = 0
        reached_end = False
        channel_total: Optional[int] = None
        while position < max_videos and not _stop.is_set():
            limit = min(_PAGE_SIZE, max_videos - position)
            data = _fetch_flat_page(channel_url, offset=offset, limit=limit)
            entries = data.get("entries") or []
            if data.get("channel") and not channel_name:
                channel_name = data.get("channel")
            pc = data.get("playlist_count")
            if isinstance(pc, int) and pc > 0:
                channel_total = pc
            with Session(engine) as session:
                catalog = session.get(ChannelCatalog, catalog_id)
                if catalog is None:
                    return
                if channel_name and catalog.channel_name != channel_name:
                    catalog.channel_name = channel_name
                if channel_total is not None:
                    catalog.channel_total = channel_total
                position = _upsert_flat_entries(session, catalog, entries, position)
                catalog.indexed_count = position
                catalog.updated_at = utcnow()
                session.add(catalog)
                session.commit()
            _set_runtime(
                done=position,
                total=channel_total or max_videos,
                current_channel=channel_name,
            )
            if not entries or not data.get("has_more"):
                reached_end = True
                break
            offset += len(entries)
            # Brief yield so downloads/previews can use the extract gate.
            time.sleep(0.35)

        with Session(engine) as session:
            catalog = session.get(ChannelCatalog, catalog_id)
            if catalog is None:
                return
            _trim_beyond_cap(session, catalog)
            count = session.exec(
                select(func.count(ChannelCatalogVideo.id)).where(
                    ChannelCatalogVideo.catalog_id == catalog_id
                )
            ).one()
            catalog.indexed_count = int(count or 0)
            if channel_total is not None:
                catalog.channel_total = channel_total
            # Don't mark complete until descriptions finish — flat pass alone
            # would make the UI look done while enrichment is still running.
            catalog.complete = False
            if reached_end and catalog.channel_total is None:
                catalog.channel_total = catalog.indexed_count
            catalog.updated_at = utcnow()
            session.add(catalog)
            session.commit()
            _run_description_pass(session, catalog)
            catalog = session.get(ChannelCatalog, catalog_id)
            if catalog is None:
                return
            catalog.complete = bool(
                reached_end
                or (
                    catalog.channel_total is not None
                    and catalog.indexed_count >= catalog.channel_total
                )
            )
            if catalog.complete and catalog.channel_total is None:
                catalog.channel_total = catalog.indexed_count
            catalog.status = ChannelCatalogStatus.ready
            catalog.phase = "embed"
            catalog.finished_at = utcnow()
            catalog.updated_at = utcnow()
            catalog.last_error = None
            session.add(catalog)
            session.commit()

        _set_runtime(current_phase="embed")
        _enqueue_catalog_embeds(catalog_id)

        with Session(engine) as session:
            catalog = session.get(ChannelCatalog, catalog_id)
            if catalog is not None:
                catalog.phase = None
                catalog.status = ChannelCatalogStatus.ready
                catalog.updated_at = utcnow()
                session.add(catalog)
                session.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Catalog index failed for %s: %s", channel_url, exc)
        with Session(engine) as session:
            catalog = session.get(ChannelCatalog, catalog_id)
            if catalog is not None:
                catalog.status = ChannelCatalogStatus.error
                catalog.last_error = str(exc)[:500]
                catalog.phase = None
                catalog.finished_at = utcnow()
                catalog.updated_at = utcnow()
                session.add(catalog)
                session.commit()
    finally:
        _set_runtime(
            running=False,
            current_channel=None,
            current_channel_url=None,
            current_phase=None,
            done=0,
            total=0,
            catalog_id=None,
        )


def _next_queued(session: Session) -> Optional[ChannelCatalog]:
    return session.exec(
        select(ChannelCatalog)
        .where(ChannelCatalog.status == ChannelCatalogStatus.queued)
        .order_by(ChannelCatalog.updated_at.asc())
        .limit(1)
    ).first()


def _worker_loop() -> None:
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
            _index_catalog(catalog_id)
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


def stop_catalog_worker() -> None:
    _stop.set()
    _wake.set()


def catalog_progress(
    session: Session, channel_url: str
) -> dict[str, Any]:
    """Indexed/total/complete/status for a channel URL (empty defaults if none)."""
    catalog = get_catalog_by_url(session, channel_url)
    if catalog is None:
        return {
            "catalog_indexed": 0,
            "catalog_total": None,
            "catalog_complete": False,
            "catalog_status": None,
            "indexing": False,
        }
    status = (
        catalog.status.value if hasattr(catalog.status, "value") else str(catalog.status)
    )
    return {
        "catalog_indexed": catalog.indexed_count,
        "catalog_total": catalog.channel_total,
        "catalog_complete": bool(catalog.complete),
        "catalog_status": status,
        "indexing": status in ("queued", "indexing"),
    }


def catalog_feed_page(
    session: Session,
    channel_url: str,
    *,
    offset: int = 0,
    limit: int = 30,
) -> Optional[dict[str, Any]]:
    """Return a feed page from the local catalog, or None if not usable yet."""
    catalog = get_catalog_by_url(session, channel_url)
    if catalog is None:
        return None
    if catalog.status not in (
        ChannelCatalogStatus.ready,
        ChannelCatalogStatus.indexing,
        ChannelCatalogStatus.error,
    ):
        return None
    total = session.exec(
        select(func.count(ChannelCatalogVideo.id)).where(
            ChannelCatalogVideo.catalog_id == catalog.id
        )
    ).one()
    total_n = int(total or 0)
    if total_n == 0:
        return None
    rows = session.exec(
        select(ChannelCatalogVideo)
        .where(ChannelCatalogVideo.catalog_id == catalog.id)
        .order_by(ChannelCatalogVideo.position.asc())
        .offset(offset)
        .limit(limit)
    ).all()
    entries = [
        {
            "id": r.yt_id,
            "url": r.url,
            "title": r.title,
            "duration": r.duration,
            "thumbnail_url": r.thumbnail_url,
            "view_count": r.view_count,
            "published_at": r.published_at,
        }
        for r in rows
    ]
    return {
        "channel": catalog.channel_name,
        "channel_url": catalog.channel_url,
        "entries": entries,
        "has_more": offset + len(entries) < total_n,
        "indexing": catalog.status == ChannelCatalogStatus.indexing,
        "from_catalog": True,
        "catalog_indexed": catalog.indexed_count,
        "catalog_total": catalog.channel_total,
        "catalog_complete": bool(catalog.complete),
        "catalog_status": (
            catalog.status.value if hasattr(catalog.status, "value") else str(catalog.status)
        ),
    }


def search_catalog(
    session: Session,
    channel_url: str,
    query: str,
    *,
    limit: int = 60,
) -> list[dict[str, Any]]:
    catalog = get_catalog_by_url(session, channel_url)
    if catalog is None or catalog.id is None:
        return []
    q = query.strip()
    if not q:
        return []
    pattern = f"%{q}%"
    rows = session.exec(
        select(ChannelCatalogVideo)
        .where(ChannelCatalogVideo.catalog_id == catalog.id)
        .where(
            or_(
                col(ChannelCatalogVideo.title).ilike(pattern),
                col(ChannelCatalogVideo.description).ilike(pattern),
            )
        )
        .order_by(ChannelCatalogVideo.position.asc())
        .limit(limit)
    ).all()

    # Hybrid: boost with embedding similarity when available.
    semantic_extra: list[ChannelCatalogVideo] = []
    try:
        from .ai import embeddings as emb_mod
        from .ai.provider import get_provider

        provider = get_provider()
        ai = app_settings.ai_settings()
        if provider is not None and ai.get("enabled", True):
            model = str(ai.get("embed_model") or "nomic-embed-text")
            query_vec = provider.embed(q, model)
            emb_rows = session.exec(select(ChannelCatalogEmbedding)).all()
            scored: list[tuple[float, ChannelCatalogVideo]] = []
            for emb in emb_rows:
                video = session.get(ChannelCatalogVideo, emb.catalog_video_id)
                if video is None or video.catalog_id != catalog.id:
                    continue
                vec = emb_mod.unpack_vector(emb.vector, emb.dim)
                score = emb_mod.cosine(query_vec, vec)
                if score >= 0.35:
                    scored.append((score, video))
            scored.sort(key=lambda x: x[0], reverse=True)
            semantic_extra = [v for _, v in scored[:limit]]
    except Exception:  # noqa: BLE001
        semantic_extra = []

    # Preserve keyword order first, then semantic extras.
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for r in list(rows) + semantic_extra:
        if r.yt_id in seen:
            continue
        seen.add(r.yt_id)
        out.append(
            {
                "id": r.yt_id,
                "url": r.url,
                "title": r.title,
                "duration": r.duration,
                "thumbnail_url": r.thumbnail_url,
                "view_count": r.view_count,
                "published_at": r.published_at,
            }
        )
        if len(out) >= limit:
            break
    return out


def catalog_document(video: ChannelCatalogVideo) -> str:
    parts = [f"Title: {video.title or ''}"]
    if video.description:
        parts.append("Description: " + video.description[:_MAX_DESC_CHARS])
    return "\n".join(parts).strip()


def catalog_content_hash(video: ChannelCatalogVideo) -> str:
    text = catalog_document(video)
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()

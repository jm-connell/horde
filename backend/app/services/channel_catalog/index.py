"""Flat index, description pass, embeds, and feed-head sync."""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

from sqlmodel import Session, func, select

from ...database import engine
from ...models import (
    ChannelCatalog,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    utcnow,
)
from .. import activity, app_settings
from .. import feed_meta_cache
from ..feed_meta_cache import parse_upload_date
from ..ytdlp_common import (
    MembersOnlyError,
    QuietYtdlpLogger,
    apply_cookie_opts,
    extract_info_gated,
    is_members_only_entry,
    is_members_only_error,
    youtube_extractor_args,
)
from .runtime import (
    _DESC_LIMIT,
    _MAX_DESC_CHARS,
    _PAGE_SIZE,
    _enabled,
    _max_videos,
    _normalize_channel_url,
    _set_runtime,
    get_catalog_by_url,
    should_stop,
)
from .skips import (
    _reject_members_or_skipped,
    delete_catalog_video_row,
    purge_catalog_video,
    record_members_only_skip,
    skipped_yt_ids,
)

logger = logging.getLogger(__name__)

def _fetch_flat_page(channel_url: str, offset: int, limit: int) -> dict[str, Any]:
    from ..ytdlp_extract import fetch_channel_feed

    return fetch_channel_feed(channel_url, offset=offset, limit=limit)


def _upsert_flat_entries(
    session: Session,
    catalog: ChannelCatalog,
    entries: list[dict[str, Any]],
    start_position: int,
) -> int:
    """Upsert flat entries starting at start_position. Returns next position."""
    pos = start_position
    skipped = skipped_yt_ids(session, catalog.id)  # type: ignore[arg-type]
    for raw in entries:
        rejected = _reject_members_or_skipped(
            session, catalog, raw, skipped=skipped
        )
        if rejected is not None:
            skipped.add(rejected)
            continue
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
            delete_catalog_video_row(session, row)
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
        skipped = skipped_yt_ids(session, catalog.id)  # type: ignore[arg-type]

        live_ids: list[str] = []
        pos = 0
        for raw in entries:
            rejected = _reject_members_or_skipped(
                session, catalog, raw, skipped=skipped
            )
            if rejected is not None:
                skipped.add(rejected)
                by_yt.pop(rejected, None)
                continue
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
            pos += 1

        live_set = set(live_ids)
        next_pos = len(live_ids)
        for row in list(existing):
            if row.yt_id in skipped:
                continue
            if row.yt_id in live_set:
                continue
            # Row may have been purged during reject.
            if session.get(ChannelCatalogVideo, row.id) is None:
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
            "logger": QuietYtdlpLogger(),
            "extractor_args": youtube_extractor_args(),
        }
    )
    try:
        info = extract_info_gated(url, opts, cache_key=f"catalog-desc:{url}")
    except Exception as exc:  # noqa: BLE001
        if is_members_only_error(exc):
            raise MembersOnlyError(str(exc)) from exc
        return None
    if is_members_only_entry(info):
        raise MembersOnlyError("members-only")
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
        if should_stop():
            return
        if is_members_only_entry({"title": row.title}):
            purge_catalog_video(session, row)
            _set_runtime(done=i + 1)
            continue
        if row.description:
            _set_runtime(done=i + 1)
            continue
        try:
            desc = _fetch_description(row.url)
        except MembersOnlyError:
            purge_catalog_video(session, row)
            _set_runtime(done=i + 1)
            continue
        if desc:
            row.description = desc
            row.indexed_at = utcnow()
            session.add(row)
            session.commit()
        _set_runtime(done=i + 1)


def _enqueue_catalog_embeds(catalog_id: int) -> None:
    try:
        from ...models import AiJobKind
        from ..ai import worker as ai_worker

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


def index_catalog(catalog_id: int) -> None:
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

    act = activity.start(
        "catalog",
        "Indexing channel catalog",
        reason="Channel catalog indexing queued",
        engine="yt-dlp",
        detail=channel_name or channel_url,
        total=max_videos,
        done=0,
    )

    try:
        offset = 0
        position = 0
        reached_end = False
        channel_total: Optional[int] = None
        while position < max_videos and not should_stop():
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
                    act.discard()
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
            act.update(
                done=position,
                total=channel_total or max_videos,
                detail=f"{channel_name or channel_url} · listing videos",
                label="Indexing channel catalog",
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
                act.discard()
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
            _set_runtime(current_phase="descriptions")
            act.update(
                detail=f"{channel_name or channel_url} · fetching descriptions",
                label="Enriching channel catalog",
            )
            _run_description_pass(session, catalog)
            catalog = session.get(ChannelCatalog, catalog_id)
            if catalog is None:
                act.discard()
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
        act.update(
            detail=f"{channel_name or channel_url} · queueing embeddings",
            label="Queueing catalog embeddings",
            engine="ollama",
        )
        _enqueue_catalog_embeds(catalog_id)

        with Session(engine) as session:
            catalog = session.get(ChannelCatalog, catalog_id)
            if catalog is not None:
                catalog.phase = None
                catalog.status = ChannelCatalogStatus.ready
                catalog.updated_at = utcnow()
                session.add(catalog)
                session.commit()
        act.finish(detail=channel_name or channel_url)
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
        act.finish(status="failed", error=str(exc)[:500])
    finally:
        if not act._closed:
            act.discard()
        _set_runtime(
            running=False,
            current_channel=None,
            current_channel_url=None,
            current_phase=None,
            done=0,
            total=0,
            catalog_id=None,
        )



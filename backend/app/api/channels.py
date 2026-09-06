"""Channel list, catalog, and feed routes."""

from __future__ import annotations

from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from ..database import get_session
from ..models import Video
from ..schemas import (
    ChannelCatalogIndexRequest,
    ChannelCatalogIndexResult,
    ChannelCatalogStatusResponse,
    ChannelCatalogYoutubeSearchPref,
    ChannelCatalogYoutubeSearchUpdate,
    ChannelFeedEntry,
    ChannelFeedPage,
    ChannelRename,
    ChannelSearchHit,
    ChannelSearchResponse,
    ChannelStat,
)
from ..services import channel_catalog, downloader, feed_meta_cache, library
from ..services import app_settings as app_settings_svc
from ..services.ytdlp_common import is_members_only_entry
from ..services.ytdlp_extract import (
    search_youtube_channel_videos,
    search_youtube_videos,
)
from .video_serialize import to_read

router = APIRouter(prefix="/api", tags=["channels"])

@router.get("/channels", response_model=list[ChannelStat])
def list_channels(
    sort: str = Query("recent_download"),
    order: str = Query("desc"),
    session: Session = Depends(get_session),
):
    return [
        ChannelStat(
            channel=row.channel,
            count=row.count,
            last_download_at=row.last_download_at,
            subscriber_count=row.subscriber_count,
            channel_url=row.channel_url,
        )
        for row in library.channel_stats(session, sort=sort, order=order)
    ]


@router.patch("/channels", response_model=dict)
def rename_channel(payload: ChannelRename, session: Session = Depends(get_session)):
    old = payload.old_name.strip()
    new = payload.new_name.strip()
    if not old or not new:
        raise HTTPException(status_code=400, detail="Both names are required")
    updated = library.rename_channel(session, old, new)
    return {"updated": updated}


@router.get("/channels/search", response_model=ChannelSearchResponse)
def search_channels(
    q: str = Query(..., min_length=1),
    limit: int = Query(8, ge=1, le=20),
):
    hits = downloader.search_youtube_channels(q, limit=limit)
    return ChannelSearchResponse(
        results=[ChannelSearchHit(**h) for h in hits]
    )


@router.get("/channels/catalog/status", response_model=ChannelCatalogStatusResponse)
def channel_catalog_status():
    return ChannelCatalogStatusResponse(**channel_catalog.get_runtime_status())


@router.post("/channels/catalog/index", response_model=ChannelCatalogIndexResult)
def channel_catalog_index(
    payload: ChannelCatalogIndexRequest,
    session: Session = Depends(get_session),
):
    """Manually queue catalog indexing for one channel (or all library channels)."""
    if not app_settings_svc.load().get("channel_catalog_enabled", True):
        raise HTTPException(
            status_code=400, detail="Channel catalog indexing is disabled"
        )

    channel_url = (payload.url or "").strip() or None
    channel_name = (payload.channel or "").strip() or None

    # No channel specified → refresh or full-index every library channel with a URL.
    if not channel_url and not channel_name:
        if payload.mode == "full" or payload.force:
            result = channel_catalog.enqueue_all_library_channels(force=True)
        else:
            result = channel_catalog.refresh_all_library_channels()
        return ChannelCatalogIndexResult(**result)

    if not channel_url and channel_name:
        channel_url = library.resolve_channel_url(session, channel_name)
    if not channel_url:
        raise HTTPException(
            status_code=400,
            detail="No YouTube channel URL known for this channel",
        )

    catalog_id = channel_catalog.enqueue_channel(
        channel_url,
        channel_name=channel_name,
        force=payload.force,
    )
    if catalog_id is None:
        return ChannelCatalogIndexResult(
            queued=0,
            skipped=1,
            refreshed=0,
            detail="Could not queue channel (disabled or unsupported URL)",
        )
    return ChannelCatalogIndexResult(
        queued=1,
        catalog_id=catalog_id,
        detail=f"Queued indexing for {channel_name or channel_url}",
    )


def _published_fields(
    raw: dict[str, Any],
    cached: Optional[dict[str, Any]],
    library_iso: Optional[str],
) -> tuple[Optional[str], Optional[str]]:
    """Return (sort ISO, display label). Library dates are real calendar days."""
    label = raw.get("published_label")
    if not label and cached and not raw.get("published_at"):
        label = cached.get("published_label")
    if isinstance(label, str):
        label = label.strip() or None
    else:
        label = None
    iso = feed_meta_cache.parse_upload_date(raw.get("published_at"))
    if iso is None and cached:
        iso = feed_meta_cache.parse_upload_date(cached.get("published_at"))
    if iso is None and label:
        iso = feed_meta_cache.parse_upload_date(label)
    if library_iso:
        return library_iso, None
    return iso, label


def _feed_entries_from_raw(
    session: Session,
    raw_entries: list[dict[str, Any]],
    *,
    channel_name: Optional[str],
    channel_url: Optional[str] = None,
    global_search: bool = False,
) -> list[ChannelFeedEntry]:
    lib_map = library.youtube_library_map(
        session, channel=None if global_search else channel_name
    )
    yt_ids = [str(e["id"]) for e in raw_entries if e.get("id")]
    meta_cache = feed_meta_cache.get_many(yt_ids)
    entries: list[ChannelFeedEntry] = []
    to_cache: list[dict[str, Any]] = []
    catalog_updates: list[dict[str, Any]] = []
    for raw in raw_entries:
        if is_members_only_entry(raw):
            continue
        yt_id = raw.get("id")
        lib = lib_map.get(yt_id) if yt_id else None
        video_id = lib[0] if lib else None
        library_height = lib[1] if lib else None
        in_library = video_id is not None
        if global_search and in_library:
            continue
        cached = meta_cache.get(str(yt_id)) if yt_id else None
        view_count = raw.get("view_count")
        if view_count is None and cached:
            view_count = cached.get("view_count")
        if view_count is None and lib:
            view_count = lib[2]
        like_count = cached.get("like_count") if cached else None
        dislike_count = cached.get("dislike_count") if cached else None
        published_at, published_label = _published_fields(
            raw, cached, lib[3] if lib else None
        )
        duration = raw.get("duration")
        if duration is None and cached:
            duration = cached.get("duration")
        thumbnail_url = raw.get("thumbnail_url") or (
            cached.get("thumbnail_url") if cached else None
        )
        if yt_id and (
            raw.get("published_at")
            or raw.get("published_label")
            or raw.get("view_count") is not None
            or raw.get("duration") is not None
            or raw.get("thumbnail_url")
        ):
            to_cache.append(
                {
                    "id": str(yt_id),
                    "view_count": raw.get("view_count"),
                    "published_at": published_at or raw.get("published_at"),
                    "published_label": published_label,
                    "duration": raw.get("duration"),
                    "thumbnail_url": raw.get("thumbnail_url"),
                    "title": raw.get("title"),
                }
            )
        if yt_id and (published_at or view_count is not None):
            catalog_updates.append(
                {
                    "id": str(yt_id),
                    "published_at": None if published_label else published_at,
                    "published_label": published_label,
                    "view_count": view_count,
                    "duration": duration,
                    "thumbnail_url": thumbnail_url,
                }
            )
        entries.append(
            ChannelFeedEntry(
                id=yt_id,
                url=raw["url"],
                title=raw.get("title"),
                duration=duration,
                thumbnail_url=thumbnail_url,
                view_count=view_count,
                like_count=int(like_count) if like_count is not None else None,
                dislike_count=(
                    int(dislike_count) if dislike_count is not None else None
                ),
                published_at=published_at,
                published_label=published_label,
                channel=raw.get("channel") or channel_name,
                channel_url=raw.get("channel_url") or channel_url,
                in_library=in_library,
                video_id=video_id,
                library_height_px=library_height,
                match_reason=raw.get("match_reason"),
            )
        )
    if to_cache:
        feed_meta_cache.upsert_many(to_cache)
    if channel_url and catalog_updates:
        try:
            channel_catalog.update_catalog_video_fields(
                channel_url, catalog_updates
            )
        except Exception:  # noqa: BLE001
            pass
    return entries


@router.patch(
    "/channels/catalog/youtube-search",
    response_model=ChannelCatalogYoutubeSearchPref,
)
def channel_youtube_search_pref(
    payload: ChannelCatalogYoutubeSearchUpdate,
    session: Session = Depends(get_session),
):
    """Set per-channel Direct YouTube search override (null = inherit)."""
    channel_url = (payload.url or "").strip() or None
    channel_name = (payload.channel or "").strip() or None
    if not channel_url and channel_name:
        channel_url = library.resolve_channel_url(session, channel_name)
    if not channel_url:
        raise HTTPException(
            status_code=400,
            detail="No YouTube channel URL known for this channel",
        )
    result = channel_catalog.set_direct_youtube_search(
        channel_url,
        payload.direct_youtube_search,
        channel_name=channel_name,
    )
    if result is None:
        raise HTTPException(
            status_code=400,
            detail="Direct YouTube search is only available for YouTube channels",
        )
    return ChannelCatalogYoutubeSearchPref(**result)


@router.get("/channels/youtube-search", response_model=ChannelFeedPage)
def channel_youtube_search(
    q: str = Query(..., min_length=2),
    channel: Optional[str] = None,
    url: Optional[str] = None,
    limit: int = Query(20, ge=1, le=40),
    session: Session = Depends(get_session),
):
    channel_url = (url or "").strip() or None
    channel_name = (channel or "").strip() or None
    if not channel_url and channel_name:
        channel_url = library.resolve_channel_url(session, channel_name)
    empty = ChannelFeedPage(
        channel=channel_name,
        channel_url=channel_url,
        entries=[],
        has_more=False,
        from_catalog=False,
        direct_youtube_search_effective=False,
    )
    if not channel_url or not channel_catalog.is_youtube_channel_url(channel_url):
        return empty
    pref = channel_catalog.youtube_search_pref(
        session, channel_url, channel_name=channel_name
    )
    effective = bool(pref.get("direct_youtube_search_effective"))
    empty.direct_youtube_search_effective = effective
    if not effective:
        return empty
    raw_entries = search_youtube_channel_videos(
        channel_url, q, limit=limit
    )
    entries = _feed_entries_from_raw(
        session,
        raw_entries,
        channel_name=channel_name,
        channel_url=channel_url,
    )
    return ChannelFeedPage(
        channel=channel_name,
        channel_url=channel_url,
        entries=entries,
        has_more=False,
        from_catalog=False,
        direct_youtube_search_effective=True,
    )


@router.get("/youtube/search", response_model=ChannelFeedPage)
def youtube_video_search(
    q: str = Query(..., min_length=2),
    limit: int = Query(20, ge=1, le=40),
    offset: int = Query(0, ge=0, le=200),
    session: Session = Depends(get_session),
):
    """Site-wide YouTube video search for Library home."""
    effective = app_settings_svc.youtube_video_search_system()
    empty = ChannelFeedPage(
        entries=[],
        has_more=False,
        from_catalog=False,
        youtube_video_search_effective=effective,
    )
    if not effective:
        return empty
    data = search_youtube_videos(q, limit=limit, offset=offset)
    raw_entries = data.get("entries") or []
    entries = _feed_entries_from_raw(
        session,
        raw_entries,
        channel_name=None,
        global_search=True,
    )
    return ChannelFeedPage(
        entries=entries,
        has_more=bool(data.get("has_more")),
        from_catalog=False,
        youtube_video_search_effective=True,
    )


@router.get("/channels/catalog/search", response_model=ChannelFeedPage)
def channel_catalog_search(
    q: str = Query(..., min_length=1),
    channel: Optional[str] = None,
    url: Optional[str] = None,
    limit: int = Query(60, ge=1, le=200),
    semantic: bool = Query(True),
    session: Session = Depends(get_session),
):
    channel_url = (url or "").strip() or None
    channel_name = (channel or "").strip() or None
    if not channel_url and channel_name:
        channel_url = library.resolve_channel_url(session, channel_name)

    global_search = not channel_url
    if global_search:
        raw_entries = channel_catalog.search_all_catalogs(
            session, q, limit=limit, semantic=semantic
        )
        progress: dict[str, Any] = {}
    else:
        raw_entries = channel_catalog.search_catalog(
            session, channel_url, q, limit=limit, semantic=semantic
        )
        progress = channel_catalog.catalog_progress(session, channel_url)

    entries = _feed_entries_from_raw(
        session,
        raw_entries,
        channel_name=channel_name,
        channel_url=channel_url,
        global_search=global_search,
    )
    return ChannelFeedPage(
        channel=channel_name,
        channel_url=channel_url,
        entries=entries,
        has_more=False,
        from_catalog=True,
        indexing=bool(progress.get("indexing")),
        catalog_indexed=int(progress.get("catalog_indexed") or 0),
        catalog_total=progress.get("catalog_total"),
        catalog_complete=bool(progress.get("catalog_complete")),
        catalog_status=progress.get("catalog_status"),
    )


@router.get("/channels/feed", response_model=ChannelFeedPage)
def channel_feed(
    channel: Optional[str] = None,
    url: Optional[str] = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=100),
    live: bool = Query(
        False,
        description="If true, fetch from YouTube and merge into the catalog. "
        "If false, prefer the local catalog for a fast response.",
    ),
    session: Session = Depends(get_session),
):
    channel_url = (url or "").strip() or None
    channel_name = (channel or "").strip() or None
    if not channel_url and channel_name:
        channel_url = library.resolve_channel_url(session, channel_name)
    if not channel_url:
        return ChannelFeedPage(channel=channel_name, channel_url=None, entries=[], has_more=False)

    # Kick off / refresh catalog in the background without blocking the response.
    try:
        channel_catalog.maybe_enqueue_for_feed(
            channel_url, channel_name=channel_name
        )
    except Exception:  # noqa: BLE001
        pass

    data = None
    from_catalog = False
    indexing = False

    if live:
        # Blocking YouTube fetch — used as a soft refresh after catalog paint.
        try:
            data = channel_catalog.sync_feed_head(
                channel_url, channel_name=channel_name, limit=max(limit, 50)
            )
            # Re-read the requested page from the updated catalog when possible.
            catalog_page = channel_catalog.catalog_feed_page(
                session, channel_url, offset=offset, limit=limit
            )
            if catalog_page is not None:
                data = catalog_page
                from_catalog = True
                indexing = bool(catalog_page.get("indexing"))
            else:
                from_catalog = False
        except Exception as exc:  # noqa: BLE001
            # Fall back to catalog or live flat extract below.
            data = None
            live_error = exc
        else:
            live_error = None
        if data is None:
            try:
                data = downloader.fetch_channel_feed(
                    channel_url, offset=offset, limit=limit
                )
                from_catalog = False
            except Exception as exc:  # noqa: BLE001
                err = live_error or exc
                raise HTTPException(
                    status_code=400, detail=f"Could not load channel feed: {err}"
                ) from err
    else:
        data = channel_catalog.catalog_feed_page(
            session, channel_url, offset=offset, limit=limit
        )
        from_catalog = bool(data and data.get("from_catalog"))
        indexing = bool(data and data.get("indexing"))

        if data is None:
            try:
                data = downloader.fetch_channel_feed(
                    channel_url, offset=offset, limit=limit
                )
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=400, detail=f"Could not load channel feed: {exc}"
                ) from exc
            from_catalog = False
            indexing = False
        elif offset == 0:
            # Catalog hit — refresh newest uploads in the background.
            try:
                channel_catalog.schedule_feed_head_sync(
                    channel_url, channel_name=channel_name
                )
            except Exception:  # noqa: BLE001
                pass

    lib_map = library.youtube_library_map(session, channel=channel_name)
    yt_ids = [str(e["id"]) for e in (data.get("entries") or []) if e.get("id")]
    meta_cache = feed_meta_cache.get_many(yt_ids)
    to_cache: list[dict] = []
    entries: list[ChannelFeedEntry] = []
    for raw in data.get("entries") or []:
        if is_members_only_entry(raw):
            continue
        yt_id = raw.get("id")
        lib = lib_map.get(yt_id) if yt_id else None
        video_id = lib[0] if lib else None
        library_height = lib[1] if lib else None
        library_views = lib[2] if lib else None
        cached = meta_cache.get(str(yt_id)) if yt_id else None
        feed_views = raw.get("view_count")
        view_count = (
            feed_views
            if feed_views is not None
            else (cached.get("view_count") if cached else None)
        )
        if view_count is None:
            view_count = library_views
        like_count = cached.get("like_count") if cached else None
        dislike_count = cached.get("dislike_count") if cached else None
        published_at, published_label = _published_fields(
            raw, cached, lib[3] if lib else None
        )
        duration = raw.get("duration")
        if duration is None and cached:
            duration = cached.get("duration")
        thumbnail_url = raw.get("thumbnail_url") or (
            cached.get("thumbnail_url") if cached else None
        )
        max_height = cached.get("max_height") if cached else None
        if yt_id and (
            feed_views is not None
            or raw.get("published_at")
            or raw.get("published_label")
            or raw.get("duration")
            or raw.get("thumbnail_url")
        ):
            to_cache.append(
                {
                    "id": yt_id,
                    "view_count": feed_views,
                    "published_at": published_at or raw.get("published_at"),
                    "published_label": published_label,
                    "duration": raw.get("duration"),
                    "thumbnail_url": raw.get("thumbnail_url"),
                    "title": raw.get("title"),
                }
            )
        entries.append(
            ChannelFeedEntry(
                id=yt_id,
                url=raw["url"],
                title=raw.get("title")
                or (cached.get("title") if cached else None),
                duration=duration,
                thumbnail_url=thumbnail_url,
                view_count=view_count,
                like_count=int(like_count) if like_count is not None else None,
                dislike_count=(
                    int(dislike_count) if dislike_count is not None else None
                ),
                published_at=published_at,
                published_label=published_label,
                in_library=video_id is not None,
                video_id=video_id,
                library_height_px=library_height,
                max_height=int(max_height) if max_height else None,
            )
        )
    if to_cache:
        feed_meta_cache.upsert_many(to_cache)
    if channel_url:
        catalog_updates = [
            {
                "id": e.id,
                "published_at": None if e.published_label else e.published_at,
                "published_label": e.published_label,
                "view_count": e.view_count,
                "duration": e.duration,
                "thumbnail_url": e.thumbnail_url,
            }
            for e in entries
            if e.id and (e.published_at or e.view_count is not None)
        ]
        if catalog_updates:
            try:
                channel_catalog.update_catalog_video_fields(
                    channel_url, catalog_updates
                )
            except Exception:  # noqa: BLE001
                pass

    # Background-fill missing views / dates / votes (catalog + live).
    missing_meta = [
        e
        for e in entries
        if e.id and (e.view_count is None or not e.published_at)
    ][:8]
    missing_votes = [
        e for e in entries if e.id and (e.like_count is None or e.dislike_count is None)
    ][:8]
    if missing_meta or missing_votes:
        from ..services import return_youtube_dislike

        def _enrich(
            meta_rows: list[tuple[str, str]],
            vote_ids: list[str],
            catalog_url: Optional[str],
        ) -> None:
            from ..services import activity

            total = len(meta_rows) + len(vote_ids)
            with activity.track(
                "feed_enrich",
                "Enriching channel feed metadata",
                reason="Channel feed opened with missing view counts, dates, or votes",
                engine="yt-dlp",
                detail=f"0/{total}" if total else None,
                total=total or None,
                done=0,
            ) as handle:
                updates: list[dict] = []
                catalog_field_updates: list[dict] = []
                done = 0
                for yt_id, entry_url in meta_rows:
                    try:
                        preview = downloader.extract_preview(entry_url)
                    except Exception:  # noqa: BLE001
                        done += 1
                        handle.update(done=done, detail=f"{done}/{total}")
                        continue
                    if preview.get("is_playlist"):
                        done += 1
                        handle.update(done=done, detail=f"{done}/{total}")
                        continue
                    row: dict = {"id": yt_id}
                    if preview.get("view_count") is not None:
                        row["view_count"] = preview["view_count"]
                    if preview.get("thumbnail_url"):
                        row["thumbnail_url"] = preview["thumbnail_url"]
                    if preview.get("published_at") or preview.get("published_label"):
                        row["published_at"] = preview.get("published_at")
                        row["published_label"] = preview.get("published_label")
                    if len(row) > 1:
                        updates.append(row)
                        catalog_field_updates.append(row)
                    done += 1
                    handle.update(done=done, detail=f"{done}/{total}")
                for yt_id in vote_ids:
                    votes = return_youtube_dislike.fetch_votes(yt_id)
                    if votes:
                        updates.append(
                            {
                                "id": yt_id,
                                "like_count": votes["like_count"],
                                "dislike_count": votes["dislike_count"],
                            }
                        )
                    done += 1
                    handle.update(done=done, detail=f"{done}/{total}")
                if updates:
                    feed_meta_cache.upsert_many(updates)
                if catalog_url and catalog_field_updates:
                    try:
                        channel_catalog.update_catalog_video_fields(
                            catalog_url, catalog_field_updates
                        )
                    except Exception:  # noqa: BLE001
                        pass

        import threading

        threading.Thread(
            target=_enrich,
            args=(
                [(e.id, e.url) for e in missing_meta if e.id],
                [e.id for e in missing_votes if e.id],
                channel_url,
            ),
            daemon=True,
        ).start()

    progress = channel_catalog.catalog_progress(session, channel_url)
    # Prefer live page flags when serving from catalog mid-index.
    if from_catalog:
        indexing = indexing or bool(progress.get("indexing"))
    else:
        indexing = bool(progress.get("indexing"))

    return ChannelFeedPage(
        channel=channel_name or data.get("channel"),
        channel_url=data.get("channel_url") or channel_url,
        entries=entries,
        has_more=bool(data.get("has_more")),
        indexing=indexing,
        from_catalog=from_catalog,
        catalog_indexed=int(
            data.get("catalog_indexed")
            if data.get("catalog_indexed") is not None
            else progress.get("catalog_indexed")
            or 0
        ),
        catalog_total=(
            data.get("catalog_total")
            if data.get("catalog_total") is not None
            else progress.get("catalog_total")
        ),
        catalog_complete=bool(
            data.get("catalog_complete")
            if data.get("catalog_complete") is not None
            else progress.get("catalog_complete")
        ),
        catalog_status=(
            data.get("catalog_status")
            if data.get("catalog_status") is not None
            else progress.get("catalog_status")
        ),
    )



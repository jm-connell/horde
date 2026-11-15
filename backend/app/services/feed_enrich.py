"""Background fill of a channel feed's missing views, dates and votes.

Opening or scrolling a channel feed asks for the entries it shows that lack those
fields. Each video is looked up once at a time, and one that came back empty is
left alone for ``RETRY_AFTER_SEC``: otherwise every feed load re-queued the same
unresolvable videos and kept YouTube busy. The lookups run at background priority
so they wait behind previews, downloads and the catalog indexer's turn order.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field

from .. import context as app_context
from . import (
    activity,
    channel_catalog,
    feed_meta_cache,
    return_youtube_dislike,
    ytdlp_extract,
)
from .ytdlp_common import EXTRACT_PRIORITY_BACKGROUND

logger = logging.getLogger(__name__)

#: How long a video whose lookup came back empty is skipped.
RETRY_AFTER_SEC = 3600.0


@dataclass
class FeedEnrichState:
    """Lookups in flight and recent empty results, keyed ``meta:<id>`` / ``votes:<id>``."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    inflight: set[str] = field(default_factory=set)
    empty_at: dict[str, float] = field(default_factory=dict)


def _state() -> FeedEnrichState:
    found: FeedEnrichState = app_context.current().caches.setdefault(
        "feed_enrich", FeedEnrichState()
    )
    return found


def _claim(state: FeedEnrichState, keys: list[str]) -> list[str]:
    """Mark and return the keys nobody is looking up and that did not just fail."""
    now = time.monotonic()
    claimed: list[str] = []
    with state.lock:
        for key in keys:
            if key in state.inflight:
                continue
            failed = state.empty_at.get(key)
            if failed is not None and now - failed < RETRY_AFTER_SEC:
                continue
            state.empty_at.pop(key, None)
            state.inflight.add(key)
            claimed.append(key)
    return claimed


def schedule(
    meta_rows: list[tuple[str, str]],
    vote_ids: list[str],
    catalog_url: str | None,
) -> threading.Thread | None:
    """Start one background fill for the videos not already covered.

    ``meta_rows`` are ``(yt_id, url)`` pairs missing views or a date; ``vote_ids``
    are missing like/dislike counts. Returns the thread, or None when every video
    is already being looked up or recently came back empty.
    """
    state = _state()
    urls = dict(meta_rows)
    meta_keys = _claim(state, [f"meta:{yt_id}" for yt_id, _url in meta_rows])
    vote_keys = _claim(state, [f"votes:{yt_id}" for yt_id in vote_ids])
    if not meta_keys and not vote_keys:
        return None
    rows = [(key[len("meta:") :], urls[key[len("meta:") :]]) for key in meta_keys]
    votes = [key[len("votes:") :] for key in vote_keys]
    thread = threading.Thread(
        target=_run,
        args=(state, rows, votes, catalog_url),
        daemon=True,
        name="feed-enrich",
    )
    thread.start()
    return thread


def _finish(state: FeedEnrichState, key: str, *, empty: bool) -> None:
    with state.lock:
        state.inflight.discard(key)
        if empty:
            state.empty_at[key] = time.monotonic()


def _lookup_meta(entry_url: str) -> dict | None:
    """The fields a full extract adds to a feed entry, or None when it adds none."""
    try:
        preview = ytdlp_extract.extract_preview(
            entry_url, priority=EXTRACT_PRIORITY_BACKGROUND
        )
    except Exception:
        logger.debug("feed enrichment failed for %s", entry_url, exc_info=True)
        return None
    if preview.get("is_playlist"):
        return None
    row: dict = {}
    if preview.get("view_count") is not None:
        row["view_count"] = preview["view_count"]
    if preview.get("thumbnail_url"):
        row["thumbnail_url"] = preview["thumbnail_url"]
    if preview.get("published_at") or preview.get("published_label"):
        row["published_at"] = preview.get("published_at")
        row["published_label"] = preview.get("published_label")
    return row or None


def _run(
    state: FeedEnrichState,
    meta_rows: list[tuple[str, str]],
    vote_ids: list[str],
    catalog_url: str | None,
) -> None:
    total = len(meta_rows) + len(vote_ids)
    pending = {f"meta:{yt_id}" for yt_id, _url in meta_rows}
    pending.update(f"votes:{yt_id}" for yt_id in vote_ids)
    try:
        with activity.track(
            "feed_enrich",
            "Enriching channel feed metadata",
            reason="Channel feed opened with missing view counts, dates, or votes",
            engine="yt-dlp",
            detail=f"0/{total}",
            total=total,
            done=0,
        ) as handle:
            updates: list[dict] = []
            catalog_field_updates: list[dict] = []
            done = 0
            for yt_id, entry_url in meta_rows:
                found = _lookup_meta(entry_url)
                if found:
                    row = {"id": yt_id, **found}
                    updates.append(row)
                    catalog_field_updates.append(row)
                _finish(state, f"meta:{yt_id}", empty=not found)
                pending.discard(f"meta:{yt_id}")
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
                _finish(state, f"votes:{yt_id}", empty=not votes)
                pending.discard(f"votes:{yt_id}")
                done += 1
                handle.update(done=done, detail=f"{done}/{total}")
            if updates:
                feed_meta_cache.upsert_many(updates)
            if catalog_url and catalog_field_updates:
                try:
                    channel_catalog.update_catalog_video_fields(
                        catalog_url, catalog_field_updates
                    )
                except Exception:
                    logger.warning(
                        "could not store enriched feed metadata in the catalog for %s",
                        catalog_url,
                        exc_info=True,
                    )
    finally:
        # Anything left after an unexpected error may be asked for again.
        with state.lock:
            state.inflight.difference_update(pending)

"""Background fill of a channel feed's missing views, dates and votes.

Opening or scrolling a channel feed asks for the entries it shows that lack those
fields. Each video is looked up once at a time and then left alone for
``RETRY_AFTER_SEC``, whatever came back: a lookup that fills nothing, or only some
of the fields (a thumbnail, a relative date), leaves the entry looking incomplete,
and every feed load used to re-queue those videos and keep YouTube busy. The lookups run at background priority
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

#: How long a video is skipped after its last lookup finished.
RETRY_AFTER_SEC = 3600.0


@dataclass
class FeedEnrichState:
    """Lookups in flight and recently finished, keyed ``meta:<id>`` / ``votes:<id>``.

    One fill runs per channel (``running``, keyed by the catalog URL); a feed
    load for a channel already being filled adds to its ``waiting`` work instead
    of starting a second thread (and a second row on the System page).
    """

    lock: threading.Lock = field(default_factory=threading.Lock)
    inflight: set[str] = field(default_factory=set)
    attempted_at: dict[str, float] = field(default_factory=dict)
    running: set[str] = field(default_factory=set)
    waiting: dict[str, tuple[list[tuple[str, str]], list[str]]] = field(
        default_factory=dict
    )


def _state() -> FeedEnrichState:
    found: FeedEnrichState = app_context.current().caches.setdefault(
        "feed_enrich", FeedEnrichState()
    )
    return found


def _claim(state: FeedEnrichState, keys: list[str]) -> list[str]:
    """Mark and return the keys nobody is looking up or looked up recently."""
    now = time.monotonic()
    claimed: list[str] = []
    with state.lock:
        expired = [
            key for key, at in state.attempted_at.items() if now - at >= RETRY_AFTER_SEC
        ]
        for key in expired:
            del state.attempted_at[key]
        for key in keys:
            if key in state.inflight or key in state.attempted_at:
                continue
            state.inflight.add(key)
            claimed.append(key)
    return claimed


def schedule(
    meta_rows: list[tuple[str, str]],
    vote_ids: list[str],
    catalog_url: str | None,
    channel_name: str | None = None,
) -> threading.Thread | None:
    """Fill the videos not already covered, in this channel's one background fill.

    ``meta_rows`` are ``(yt_id, url)`` pairs missing views or a date; ``vote_ids``
    are missing like/dislike counts. Returns the thread when this call started
    the channel's fill, or None when the videos joined a running fill or every
    video is already being looked up or was looked up recently.
    """
    state = _state()
    urls = dict(meta_rows)
    meta_keys = _claim(state, [f"meta:{yt_id}" for yt_id, _url in meta_rows])
    vote_keys = _claim(state, [f"votes:{yt_id}" for yt_id in vote_ids])
    if not meta_keys and not vote_keys:
        return None
    rows = [(key[len("meta:") :], urls[key[len("meta:") :]]) for key in meta_keys]
    votes = [key[len("votes:") :] for key in vote_keys]
    channel_key = catalog_url or ""
    with state.lock:
        queued_rows, queued_votes = state.waiting.setdefault(channel_key, ([], []))
        queued_rows.extend(rows)
        queued_votes.extend(votes)
        if channel_key in state.running:
            return None
        state.running.add(channel_key)
    thread = threading.Thread(
        target=_run,
        args=(state, channel_key, catalog_url, channel_name or catalog_url),
        daemon=True,
        name="feed-enrich",
    )
    thread.start()
    return thread


def _finish(state: FeedEnrichState, key: str) -> None:
    with state.lock:
        state.inflight.discard(key)
        state.attempted_at[key] = time.monotonic()


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


def _take(
    state: FeedEnrichState, channel_key: str
) -> tuple[list[tuple[str, str]], list[str]] | None:
    """The channel's waiting work, or None (and the fill ends) when there is none."""
    with state.lock:
        batch = state.waiting.pop(channel_key, None)
        if batch is None or not (batch[0] or batch[1]):
            state.running.discard(channel_key)
            return None
        return batch


def _run(
    state: FeedEnrichState,
    channel_key: str,
    catalog_url: str | None,
    channel_label: str | None,
) -> None:
    pending: set[str] = set()
    try:
        with activity.track(
            "feed_enrich",
            f"Filling in views and dates for {channel_label or 'a channel'}",
            reason="Channel feed opened with missing view counts, dates, or votes",
            engine="yt-dlp",
            detail="0/0",
            total=0,
            done=0,
        ) as handle:
            total = done = 0
            # Loads of the same channel meanwhile add to this fill, not a new one.
            while (batch := _take(state, channel_key)) is not None:
                meta_rows, vote_ids = batch
                pending = {f"meta:{yt_id}" for yt_id, _url in meta_rows}
                pending.update(f"votes:{yt_id}" for yt_id in vote_ids)
                total += len(meta_rows) + len(vote_ids)
                handle.update(total=total, detail=f"{done}/{total}")
                updates: list[dict] = []
                catalog_field_updates: list[dict] = []
                for yt_id, entry_url in meta_rows:
                    found = _lookup_meta(entry_url)
                    if found:
                        row = {"id": yt_id, **found}
                        updates.append(row)
                        catalog_field_updates.append(row)
                    _finish(state, f"meta:{yt_id}")
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
                    _finish(state, f"votes:{yt_id}")
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
        # After an unexpected error: what was claimed but not looked up may be
        # asked for again, and the channel's next feed load starts a new fill.
        with state.lock:
            state.inflight.difference_update(pending)
            if channel_key in state.running:
                state.running.discard(channel_key)
                left_rows, left_votes = state.waiting.pop(channel_key, ([], []))
                state.inflight.difference_update(f"meta:{y}" for y, _url in left_rows)
                state.inflight.difference_update(f"votes:{y}" for y in left_votes)

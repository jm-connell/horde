"""Which followed channels are live: polled in the background, read by ``/api/live``.

One worker checks every channel somebody follows, one ``/live`` page at a time
with a pause between requests, and starts over every ``LIVE_POLL_SEC``. A
channel is only re-checked once its last check is older than the interval, so
waking the worker (a new follow) checks just the new channel. A 429 from YouTube
pauses polling for a while instead of pressing on.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

from sqlmodel import Session

from ...config import LIVE_POLL_SEC, LIVE_POLL_SPACING_SEC
from ...context import current, get_engine
from ..url_safety import UnsafeUrlError, UrlFetchError
from ..workers import BackgroundWorker
from .page import LiveBroadcast, LivePageUnreadable, fetch_live_page, parse_live_page

logger = logging.getLogger(__name__)

STARTUP_DELAY_SEC = 20
RATE_LIMIT_BACKOFF_SEC = 30 * 60
#: A live entry not confirmed for this long (failed checks) is dropped.
STALE_LIVE_SEC = 20 * 60


@dataclass(frozen=True)
class ChannelLiveState:
    channel_url: str
    channel_name: str | None
    broadcast: LiveBroadcast | None
    checked_at: float
    #: When the broadcast was last confirmed live (0 when never).
    confirmed_at: float = 0.0


class LiveDirectory:
    """Thread-safe map of followed channel -> its last live check."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._states: dict[str, ChannelLiveState] = {}
        self.paused_until = 0.0
        self.last_pass_at: float | None = None
        #: How long the last full pass took (a long follow list makes it longer
        #: than the interval; live entries must outlive one pass).
        self.pass_duration = 0.0

    def get(self, channel_url: str) -> ChannelLiveState | None:
        with self._lock:
            return self._states.get(channel_url)

    def live(self, channel_urls: set[str] | None = None) -> list[ChannelLiveState]:
        now = time.time()
        stale_after = max(STALE_LIVE_SEC, 2.5 * self.pass_duration)
        with self._lock:
            states = list(self._states.values())
        out = [
            s
            for s in states
            if s.broadcast is not None
            and now - s.confirmed_at < stale_after
            and (channel_urls is None or s.channel_url in channel_urls)
        ]
        out.sort(key=lambda s: (s.channel_name or s.channel_url).casefold())
        return out

    def record(
        self,
        channel_url: str,
        channel_name: str | None,
        broadcast: LiveBroadcast | None,
    ) -> None:
        now = time.time()
        with self._lock:
            self._states[channel_url] = ChannelLiveState(
                channel_url=channel_url,
                channel_name=(broadcast.channel_name if broadcast else None)
                or channel_name,
                broadcast=broadcast,
                checked_at=now,
                confirmed_at=now if broadcast is not None else 0.0,
            )

    def record_failure(self, channel_url: str, channel_name: str | None) -> None:
        """A failed check keeps the last answer (until it goes stale)."""
        now = time.time()
        with self._lock:
            prev = self._states.get(channel_url)
            if prev is None:
                self._states[channel_url] = ChannelLiveState(
                    channel_url, channel_name, None, now
                )
            else:
                self._states[channel_url] = replace(prev, checked_at=now)

    def retain(self, channel_urls: set[str]) -> None:
        with self._lock:
            for url in [u for u in self._states if u not in channel_urls]:
                del self._states[url]

    def due(self, targets: dict[str, str | None], interval: float) -> list[str]:
        """Channels whose last check is older than ``interval``.

        Channels live at their last check come first (so the list notices a
        broadcast ending, and keeps confirming the live ones, however long the
        follow list is), then never-checked ones, then the oldest checks.
        """
        now = time.time()
        with self._lock:
            checked = {u: s.checked_at for u, s in self._states.items()}
            live = {u for u, s in self._states.items() if s.broadcast is not None}
        due = [u for u in targets if now - checked.get(u, 0.0) >= interval]
        due.sort(key=lambda u: (u not in live, checked.get(u, 0.0)))
        return due

    def seed(self, states: list[ChannelLiveState]) -> None:
        """Put entries in directly (the browser suite has no network)."""
        with self._lock:
            for state in states:
                self._states[state.channel_url] = state


def _confirm_with_ytdlp(video_id: str) -> LiveBroadcast | None:
    """The page could not be read: ask yt-dlp whether this video is live."""
    from ..ytdlp_common import (
        QuietYtdlpLogger,
        extract_info_gated,
        youtube_extractor_args,
    )

    url = f"https://www.youtube.com/watch?v={video_id}"
    info: Any = extract_info_gated(
        url,
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "logger": QuietYtdlpLogger(),
            "extractor_args": youtube_extractor_args(),
        },
        cache_key=url,
        cookie_retry=False,
    )
    if not isinstance(info, dict):
        return None
    if not (info.get("is_live") is True or info.get("live_status") == "is_live"):
        return None
    started = info.get("release_timestamp") or info.get("timestamp")
    return LiveBroadcast(
        video_id=video_id,
        title=info.get("title"),
        channel_name=info.get("channel") or info.get("uploader"),
        game=None,
        viewers=int(info["concurrent_view_count"])
        if info.get("concurrent_view_count")
        else None,
        started_at=datetime.fromtimestamp(float(started), tz=UTC) if started else None,
    )


def check_channel(channel_url: str) -> LiveBroadcast | None:
    """The channel's current broadcast, or None. Raises UrlFetchError on failure."""
    html = fetch_live_page(channel_url)
    try:
        return parse_live_page(html)
    except LivePageUnreadable as exc:
        logger.info(
            "live page of %s was unreadable; confirming with yt-dlp", channel_url
        )
        return _confirm_with_ytdlp(exc.video_id)


def poll_due_channels(
    directory: LiveDirectory,
    sleep: Callable[[float], bool],
    *,
    interval: float,
    spacing: float,
) -> None:
    """Check every due channel. ``sleep(seconds)`` pauses and returns True to stop."""
    from .. import follows

    with Session(get_engine()) as session:
        targets = follows.all_followed_urls(session)
    directory.retain(set(targets))
    started = time.time()
    due = directory.due(targets, interval)
    for channel_url in due:
        if time.time() < directory.paused_until:
            return
        name = targets.get(channel_url)
        try:
            directory.record(channel_url, name, check_channel(channel_url))
        except UrlFetchError as exc:
            directory.record_failure(channel_url, name)
            if "429" in str(exc):
                directory.paused_until = time.time() + RATE_LIMIT_BACKOFF_SEC
                logger.warning(
                    "YouTube rate-limited live checks; pausing them for %s minutes",
                    RATE_LIMIT_BACKOFF_SEC // 60,
                )
                return
            logger.debug("live check failed for %s", channel_url, exc_info=True)
        except UnsafeUrlError:
            directory.record_failure(channel_url, name)
            logger.debug("live check refused for %s", channel_url, exc_info=True)
        except Exception:
            directory.record_failure(channel_url, name)
            logger.warning("live check failed for %s", channel_url, exc_info=True)
        if sleep(spacing):
            return
    directory.last_pass_at = time.time()
    if len(due) == len(targets):  # a full pass, not a wake for one new follow
        directory.pass_duration = directory.last_pass_at - started


def _worker_loop(worker: BackgroundWorker) -> None:
    if worker.sleep(STARTUP_DELAY_SEC):
        return
    while not worker.stopping:
        directory = current().live.directory
        try:
            poll_due_channels(
                directory,
                worker.sleep,
                interval=LIVE_POLL_SEC,
                spacing=LIVE_POLL_SPACING_SEC,
            )
        except Exception:
            logger.warning("live poller pass failed", exc_info=True)
        # Wake early for a new follow; otherwise re-check what is due shortly.
        if worker.wait_for_wake(min(60.0, LIVE_POLL_SEC)):
            return


def create_worker() -> BackgroundWorker:
    return BackgroundWorker("live-poller", _worker_loop)

"""Followed channels' live broadcasts, for the Recommended and Recommended+ feeds.

Read from the background live checks (``directory``). A broadcast from a channel
the user watched lately leads the first page; the others join it a few cards in.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

from sqlmodel import Session

from ...models import utcnow
from ...schemas import ChannelFeedEntry
from ..discovery import feedback, history
from ..follows import followed_urls, normalize_channel_url
from .directory import LiveDirectory
from .page import LiveBroadcast

#: A channel counts as watched lately when the user watched it this recently.
RECENT_WATCH_DAYS = 14
#: Where the other broadcasts go on the first page (after the recent ones).
LATER_POSITION = 4
#: At most this many of each kind, so channels that are always live do not
#: take over the feed.
MAX_RECENT = 3
MAX_OTHER = 3


@dataclass(frozen=True)
class LivePick:
    channel_url: str
    channel_name: str | None
    broadcast: LiveBroadcast
    #: The user watched this channel in the last ``RECENT_WATCH_DAYS``.
    recent: bool


def live_picks(
    session: Session, directory: LiveDirectory, user_id: int
) -> list[LivePick]:
    """The user's followed channels that are live now, lately watched ones first."""
    states = directory.live(followed_urls(session, user_id))
    if not states:
        return []
    cutoff = utcnow() - timedelta(days=RECENT_WATCH_DAYS)
    urls: set[str] = set()
    names: set[str] = set()
    for watch in history.watches(session, user_id):
        if watch.watched_at < cutoff:
            break  # Newest first.
        if watch.channel_url:
            # Stream and YouTube-history watches keep the URL as recorded.
            urls.add(normalize_channel_url(watch.channel_url))
        if watch.channel:
            names.add(watch.channel.casefold())
    blocked = feedback.exclusions(session, user_id)
    picks: list[LivePick] = []
    seen: set[str] = set()
    for state in states:
        b = state.broadcast
        if b is None:  # directory.live() returns live states only
            continue
        if b.video_id in seen or blocked.blocks(
            b.video_id, state.channel_url, state.channel_name
        ):
            continue
        seen.add(b.video_id)
        recent = normalize_channel_url(state.channel_url) in urls or (
            (state.channel_name or "").casefold() in names
        )
        picks.append(LivePick(state.channel_url, state.channel_name, b, recent))
    picks.sort(key=lambda p: not p.recent)  # Stable: by name within each group.
    return picks


def feed_entry(pick: LivePick) -> ChannelFeedEntry:
    """A pick as a card of a video that is not downloaded."""
    b = pick.broadcast
    return ChannelFeedEntry(
        id=b.video_id,
        url=f"https://www.youtube.com/watch?v={b.video_id}",
        title=b.title,
        thumbnail_url=b.thumbnail_url,
        channel=pick.channel_name,
        channel_url=pick.channel_url,
        live_status="is_live",
    )


def merge[T](
    items: list[T],
    picks: list[LivePick],
    make: Callable[[LivePick], T],
    key_of: Callable[[T], str | None],
) -> list[T]:
    """``items`` with the picks placed in them (and any copy of a broadcast dropped)."""
    if not picks:
        return items
    recent = [p for p in picks if p.recent][:MAX_RECENT]
    later = [p for p in picks if not p.recent][:MAX_OTHER]
    live_ids = {p.broadcast.video_id for p in recent + later}
    rest = [i for i in items if key_of(i) not in live_ids]
    at = min(len(rest), LATER_POSITION)
    return [make(p) for p in recent] + rest[:at] + [make(p) for p in later] + rest[at:]

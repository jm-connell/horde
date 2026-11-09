"""Parental controls: a member who may watch only some channels.

An administrator gives a member a list of allowed channels (``users.allowed_channels``,
NULL for no restriction; an administrator is never restricted). For a restricted
member everything outside the list is gone, not just hidden:

* lists (library, channels, Recommended, live, related videos, playlists'
  entries, channel pages) leave out other channels' videos;
* a library video of another channel answers 404 on every ``/api/videos/{id}``
  route and its thumbnail; a stream (a YouTube id) only plays, shows comments,
  AI results and related videos when it belongs to an allowed channel: a library
  or indexed-catalog video of one, or one whose metadata was read and named an
  allowed channel (remembered on the context, ``VerifiedStreams``);
* YouTube search answers 403, and the permissions that reach outside the list
  (downloads, imports, subscriptions, AI and Ask indexing, editing, deleting)
  are withheld whatever was granted (``KEPT_PERMISSIONS`` stay); Ask's keyword
  search and channel list show only the allowed channels.

A channel matches by its normalized URL or, for videos without one, its name
(case-insensitive): the library's channels are known by name.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from sqlalchemy import or_
from sqlmodel import Session, col, func, select

from ..models import ChannelCatalog, ChannelCatalogVideo, Video

logger = logging.getLogger(__name__)

#: What a restricted member keeps of their granted permissions. Not ``use_ai``:
#: Ask answers from every indexed channel's captions.
KEPT_PERMISSIONS = frozenset({"offline_download"})
#: Most channels one member may be given.
MAX_CHANNELS = 500
#: Streams checked against their metadata, remembered per (user, YouTube id).
VERIFIED_LIMIT = 4096
VERIFIED_TTL_SEC = 6 * 3600


def normalize_channel_url(url: str) -> str | None:
    # Imported here: follows imports the accounts module, which imports this.
    from .follows import normalize_channel_url as normalize

    return normalize(url) or None


class Restricted(Exception):
    """The member may not see this: answered as not found or forbidden."""


@dataclass(frozen=True)
class AllowedChannel:
    url: str | None
    name: str | None


@dataclass(frozen=True)
class AllowList:
    channels: tuple[AllowedChannel, ...]

    @property
    def urls(self) -> frozenset[str]:
        return frozenset(
            u for c in self.channels if c.url and (u := normalize_channel_url(c.url))
        )

    @property
    def raw_urls(self) -> frozenset[str]:
        """The URLs as stored and normalized, for SQL (which cannot normalize)."""
        return frozenset(c.url for c in self.channels if c.url) | self.urls

    @property
    def names(self) -> frozenset[str]:
        return frozenset(
            c.name.strip().lower() for c in self.channels if c.name and c.name.strip()
        )

    def allows(self, url: str | None, name: str | None) -> bool:
        """Whether a video of the channel ``url`` / ``name`` may be shown."""
        normalized = normalize_channel_url(url) if url else None
        if normalized and normalized in self.urls:
            return True
        key = (name or "").strip().lower()
        return bool(key) and key in self.names


def parse(raw: str | None) -> AllowList | None:
    """The stored list, or None (unrestricted). Unreadable data restricts to
    nothing: a broken list must not open everything."""
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        logger.warning("unreadable allowed_channels; allowing no channel")
        return AllowList(())
    if not isinstance(data, list):
        return AllowList(())
    out: list[AllowedChannel] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        name = item.get("name")
        url = str(url).strip() if url else None
        name = str(name).strip() if name else None
        if url or name:
            out.append(AllowedChannel(url=url, name=name))
    return AllowList(tuple(out))


def dump(channels: list[AllowedChannel] | None) -> str | None:
    if channels is None:
        return None
    return json.dumps([{"url": c.url, "name": c.name} for c in channels[:MAX_CHANNELS]])


def video_clause(allowed: AllowList) -> Any:
    """SQL: the videos of allowed channels (an empty list matches none)."""
    names = sorted(allowed.names)
    urls = sorted(allowed.raw_urls)
    clauses = []
    if names:
        clauses.append(func.lower(col(Video.channel)).in_(names))
    if urls:
        clauses.append(col(Video.channel_url).in_(urls))
    if not clauses:
        return col(Video.id).is_(None)  # nothing
    return or_(*clauses)


def video_allowed(allowed: AllowList | None, video: Video) -> bool:
    return allowed is None or allowed.allows(video.channel_url, video.channel)


def entry_allowed(allowed: AllowList | None, entry: Any) -> bool:
    """A feed entry (``ChannelFeedEntry`` or a dict with ``channel_url`` /
    ``channel``) of an allowed channel."""
    if allowed is None:
        return True
    if isinstance(entry, dict):
        return allowed.allows(entry.get("channel_url"), entry.get("channel"))
    return allowed.allows(
        getattr(entry, "channel_url", None), getattr(entry, "channel", None)
    )


class VerifiedStreams:
    """(user, YouTube id) pairs whose metadata named an allowed channel."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._seen: OrderedDict[tuple[int, str], float] = OrderedDict()

    def add(self, user_id: int, yt_id: str) -> None:
        with self._lock:
            self._seen[(user_id, yt_id)] = time.monotonic()
            self._seen.move_to_end((user_id, yt_id))
            while len(self._seen) > VERIFIED_LIMIT:
                self._seen.popitem(last=False)

    def has(self, user_id: int, yt_id: str) -> bool:
        with self._lock:
            at = self._seen.get((user_id, yt_id))
        return at is not None and time.monotonic() - at < VERIFIED_TTL_SEC


def verified_streams() -> VerifiedStreams:
    from ..context import current

    found: VerifiedStreams = current().caches.setdefault(
        "parental_streams", VerifiedStreams()
    )
    return found


def stream_allowed(
    session: Session, allowed: AllowList | None, user_id: int, yt_id: str | None
) -> bool:
    """Whether the stream ``yt_id`` belongs to an allowed channel, as far as
    Horde knows without asking YouTube (library, indexed catalogs, or a
    metadata read that named one)."""
    if allowed is None:
        return True
    if not yt_id:
        return False
    if verified_streams().has(user_id, yt_id):
        return True
    video = session.exec(select(Video).where(Video.youtube_id == yt_id)).first()
    if video is not None and video_allowed(allowed, video):
        return True
    for catalog in session.exec(
        select(ChannelCatalog)
        .join(
            ChannelCatalogVideo,
            col(ChannelCatalogVideo.catalog_id) == col(ChannelCatalog.id),
        )
        .where(ChannelCatalogVideo.yt_id == yt_id)
    ).all():
        if allowed.allows(catalog.channel_url, catalog.channel_name):
            return True
    return False


def check_stream_meta(
    allowed: AllowList | None, user_id: int, yt_id: str | None, meta: dict[str, Any]
) -> None:
    """After reading a stream's metadata: remember it when its channel is
    allowed, else raise ``Restricted``."""
    if allowed is None:
        return
    if allowed.allows(meta.get("channel_url"), meta.get("channel")):
        if yt_id:
            verified_streams().add(user_id, yt_id)
        return
    raise Restricted(yt_id or "")

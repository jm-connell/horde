"""Remember a search's ranking for the length of one walk through its pages.

``GET /api/videos?q=`` ranks the whole library (keyword hits merged with embedding
neighbours) and pages through that ranking by position. Without a cache every page
repeated the ranking and, with a paid provider, re-embedded the query. This holds:

* the ranked video ids (and the matching caption chunk per video) per search, and
* the query vector per query text and embedding model,

so page 2 is a slice of what page 1 computed.

Invalidation. An entry is dropped when (a) a video, tag or embedding row is
committed through the ORM (``invalidate`` is called from the listeners at the
bottom of this module), (b) the cheap library fingerprint (row counts and newest
ids) differs from the one it was built under, or (c) it is older than the TTL,
which bounds staleness for writes that bypass the ORM. Memory is bounded by the
entry count and by an estimate of the stored ids; the least recently used entry
goes first.

One cache lives on ``app.state.search_cache`` (built in ``lifespan``) and is
attached to its engine so the commit listeners can find it.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable
from dataclasses import dataclass

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.orm import object_session
from sqlmodel import Session, func, select

from ..models import Video, VideoEmbedding, VideoTag

TTL_SECONDS = 120.0
MAX_ENTRIES = 32
#: Rough cost of one ranked id (a Python int in a list plus its chunk entry).
BYTES_PER_HIT = 100
MAX_BYTES = 16 * 1024 * 1024
MAX_VECTORS = 64

_ENGINE_ATTR = "_horde_search_cache"
_SESSION_KEY = "horde_search_cache_dirty"

Ranking = tuple[list[int], dict[int, int]]


@dataclass
class _Entry:
    expires: float
    fingerprint: tuple
    ids: list[int]
    chunks: dict[int, int]
    size: int


class SearchCache:
    def __init__(
        self,
        *,
        ttl: float = TTL_SECONDS,
        max_entries: int = MAX_ENTRIES,
        max_bytes: int = MAX_BYTES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = ttl
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._clock = clock
        self._lock = threading.RLock()  # ranking() computes via query_vector()
        self._rankings: OrderedDict[Hashable, _Entry] = OrderedDict()
        self._vectors: OrderedDict[Hashable, tuple[float, list[float] | None]] = (
            OrderedDict()
        )
        self._bytes = 0
        #: Rankings computed (cache misses), for tests and diagnostics.
        self.computes = 0

    def attach(self, engine: Engine) -> None:
        """Let the commit listeners find this cache."""
        setattr(engine, _ENGINE_ATTR, self)

    def invalidate(self) -> None:
        """Drop every ranking. Query vectors stay: they depend on the text only."""
        with self._lock:
            self._rankings.clear()
            self._bytes = 0

    def ranking(
        self,
        key: Hashable,
        fingerprint: tuple,
        compute: Callable[[], Ranking],
    ) -> Ranking:
        now = self._clock()
        # Held across the compute so two simultaneous first pages rank once (the
        # lock is reentrant: ranking computes through query_vector).
        with self._lock:
            entry = self._rankings.get(key)
            if entry is not None:
                if entry.expires > now and entry.fingerprint == fingerprint:
                    self._rankings.move_to_end(key)
                    return entry.ids, entry.chunks
                self._drop(key)
            ids, chunks = compute()
            self.computes += 1
            size = (len(ids) + len(chunks)) * BYTES_PER_HIT
            if size <= self._max_bytes:
                self._rankings[key] = _Entry(
                    now + self._ttl, fingerprint, ids, chunks, size
                )
                self._bytes += size
                self._evict()
            return ids, chunks

    def query_vector(
        self, key: Hashable, compute: Callable[[], list[float] | None]
    ) -> list[float] | None:
        """The query's embedding, reused by every ranking of the same query text."""
        now = self._clock()
        with self._lock:
            hit = self._vectors.get(key)
            if hit is not None and hit[0] > now:
                self._vectors.move_to_end(key)
                return hit[1]
            vector = compute()
            self._vectors[key] = (now + self._ttl, vector)
            while len(self._vectors) > MAX_VECTORS:
                self._vectors.popitem(last=False)
            return vector

    def _drop(self, key: Hashable) -> None:
        entry = self._rankings.pop(key, None)
        if entry is not None:
            self._bytes -= entry.size

    def _evict(self) -> None:
        while self._rankings and (
            len(self._rankings) > self._max_entries or self._bytes > self._max_bytes
        ):
            self._drop(next(iter(self._rankings)))


def library_fingerprint(session: Session) -> tuple:
    """Cheap stamp of everything a ranking reads: three aggregate queries."""
    videos = session.exec(
        select(func.count(), func.max(Video.id), func.sum(Video.needs_review))  # type: ignore[arg-type]
    ).one()
    tags = session.exec(select(func.count(), func.max(VideoTag.video_id))).one()  # type: ignore[arg-type]
    embeddings = session.exec(
        select(func.count(), func.max(VideoEmbedding.id))  # type: ignore[arg-type]
    ).one()
    return (tuple(videos), tuple(tags), tuple(embeddings))


# --- invalidate on commit ------------------------------------------------------


@event.listens_for(Video, "after_insert")
@event.listens_for(Video, "after_update")
@event.listens_for(Video, "after_delete")
@event.listens_for(VideoTag, "after_insert")
@event.listens_for(VideoTag, "after_update")
@event.listens_for(VideoTag, "after_delete")
@event.listens_for(VideoEmbedding, "after_insert")
@event.listens_for(VideoEmbedding, "after_update")
@event.listens_for(VideoEmbedding, "after_delete")
def _mark_changed(_mapper, connection, target) -> None:
    session = object_session(target)
    if session is not None:
        session.info[_SESSION_KEY] = connection.engine


@event.listens_for(OrmSession, "after_commit")
def _invalidate_after_commit(session: OrmSession) -> None:
    engine = session.info.pop(_SESSION_KEY, None)
    cache = getattr(engine, _ENGINE_ATTR, None) if engine is not None else None
    if cache is not None:
        cache.invalidate()


@event.listens_for(OrmSession, "after_rollback")
def _forget_after_rollback(session: OrmSession) -> None:
    session.info.pop(_SESSION_KEY, None)

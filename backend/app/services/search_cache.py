"""Remember a search's ranking for the length of one walk through its pages.

``GET /api/videos?q=`` ranks the whole library (keyword hits merged with embedding
neighbours) and pages through that ranking by position. Without a cache every page
repeated the ranking and, with a paid provider, re-embedded the query. This holds:

* the ranked video ids (and the matching caption chunk per video) per search, and
* the query vector per query text and embedding model,

so page 2 is a slice of what page 1 computed.

Invalidation. An entry is dropped when (a) a video, tag or embedding row is
committed through the ORM (``invalidate`` is called from the listeners at the
bottom of this module; ``video_tags`` is written by database triggers, so the
listener sits on the ``videos`` and ``video_ai_meta`` rows that feed it), (b) every
30 s a hit re-checks an aggregate fingerprint (row counts, newest ids, newest AI
meta update), which catches writes that bypass the ORM, or (c) it is older than the TTL,
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
from dataclasses import dataclass, field
from typing import Any, cast

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.orm import object_session
from sqlmodel import Session, col, func, select

from ..models import Video, VideoAiMeta, VideoEmbedding, VideoTag

TTL_SECONDS = 120.0
#: A query vector that failed to compute is remembered only this long.
FAILED_VECTOR_TTL_SECONDS = 5.0
#: How often a hit re-checks the aggregate fingerprint (a backstop for writes that
#: bypass the ORM listeners).
FINGERPRINT_INTERVAL_SECONDS = 30.0
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
    value: Any
    size: int = 0
    fingerprint: tuple = ()
    checked: float = 0.0


@dataclass
class _Flight:
    done: threading.Event = field(default_factory=threading.Event)


class SearchCache:
    """Ranked search results and query vectors; see the module docstring.

    The lock only guards dictionary operations. Computing (database work, and the
    provider call that embeds a query) happens outside it, so a commit that has to
    call ``invalidate`` never waits for a search. Concurrent requests for the same
    key share one computation through an in-flight map.
    """

    def __init__(
        self,
        *,
        ttl: float = TTL_SECONDS,
        max_entries: int = MAX_ENTRIES,
        max_bytes: int = MAX_BYTES,
        fingerprint_interval: float = FINGERPRINT_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = ttl
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._fp_interval = fingerprint_interval
        self._clock = clock
        self._lock = threading.Lock()
        self._rankings: OrderedDict[Hashable, _Entry] = OrderedDict()
        self._vectors: OrderedDict[Hashable, _Entry] = OrderedDict()
        self._flights: dict[tuple[str, Hashable], _Flight] = {}
        self._generation = 0
        self._bytes = 0
        #: Rankings computed (cache misses), for tests and diagnostics.
        self.computes = 0

    def attach(self, engine: Engine) -> None:
        """Let the commit listeners find this cache."""
        setattr(engine, _ENGINE_ATTR, self)

    def invalidate(self) -> None:
        """Drop every ranking. Query vectors stay: they depend on the text only."""
        with self._lock:
            self._generation += 1
            self._rankings.clear()
            self._bytes = 0

    # -- rankings -----------------------------------------------------------

    def ranking(
        self,
        key: Hashable,
        fingerprint: Callable[[], tuple],
        compute: Callable[[], Ranking],
    ) -> Ranking:
        while True:
            now = self._clock()
            with self._lock:
                entry = self._rankings.get(key)
                if entry is not None and entry.expires <= now:
                    self._drop(key)
                    entry = None
                recheck = entry is not None and now - entry.checked >= self._fp_interval
                if entry is not None and not recheck:
                    self._rankings.move_to_end(key)
                    return cast("tuple[list[int], dict[int, int]]", entry.value)
            if entry is not None:
                # Outside the lock: three aggregate queries.
                current = fingerprint()
                with self._lock:
                    if self._rankings.get(key) is entry:
                        if entry.fingerprint == current:
                            entry.checked = now
                            self._rankings.move_to_end(key)
                            return cast("tuple[list[int], dict[int, int]]", entry.value)
                        self._drop(key)
                continue
            flight, owner = self._join(("ranking", key))
            if not owner:
                flight.done.wait()
                continue
            try:
                with self._lock:
                    generation = self._generation
                stamp = fingerprint()
                value = compute()
                size = (len(value[0]) + len(value[1])) * BYTES_PER_HIT
                with self._lock:
                    self.computes += 1
                    # A write committed while we ranked: answer, but do not keep it.
                    if generation == self._generation and size <= self._max_bytes:
                        self._rankings[key] = _Entry(
                            now + self._ttl, value, size, stamp, now
                        )
                        self._bytes += size
                        self._evict()
                return value
            finally:
                self._leave(("ranking", key), flight)

    # -- query vectors ------------------------------------------------------

    def query_vector(
        self, key: Hashable, compute: Callable[[], list[float] | None]
    ) -> list[float] | None:
        """The query's embedding, reused by every ranking of the same query text."""
        while True:
            now = self._clock()
            with self._lock:
                hit = self._vectors.get(key)
                if hit is not None and hit.expires > now:
                    self._vectors.move_to_end(key)
                    return cast("list[float] | None", hit.value)
            flight, owner = self._join(("vector", key))
            if not owner:
                flight.done.wait()
                continue
            try:
                vector = compute()
                ttl = self._ttl if vector else FAILED_VECTOR_TTL_SECONDS
                with self._lock:
                    self._vectors[key] = _Entry(now + ttl, vector)
                    while len(self._vectors) > MAX_VECTORS:
                        self._vectors.popitem(last=False)
                return vector
            finally:
                self._leave(("vector", key), flight)

    # -- helpers ------------------------------------------------------------

    def _join(self, flight_key: tuple[str, Hashable]) -> tuple[_Flight, bool]:
        """The in-flight computation for the key, and whether the caller owns it."""
        with self._lock:
            flight = self._flights.get(flight_key)
            if flight is not None:
                return flight, False
            flight = self._flights[flight_key] = _Flight()
            return flight, True

    def _leave(self, flight_key: tuple[str, Hashable], flight: _Flight) -> None:
        with self._lock:
            self._flights.pop(flight_key, None)
        flight.done.set()

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
    """Cheap stamp of everything a ranking reads: a few aggregate queries."""
    videos = session.exec(
        select(func.count(), func.max(col(Video.id)), func.sum(col(Video.needs_review)))
    ).one()
    tags = session.exec(select(func.count(), func.max(col(VideoTag.video_id)))).one()
    embeddings = session.exec(
        select(func.count(), func.max(col(VideoEmbedding.id)))
    ).one()
    meta = session.exec(
        select(func.count(), func.max(col(VideoAiMeta.updated_at)))
    ).one()
    return (tuple(videos), tuple(tags), tuple(embeddings), tuple(meta))


# --- invalidate on commit ------------------------------------------------------


@event.listens_for(Video, "after_insert")
@event.listens_for(Video, "after_update")
@event.listens_for(Video, "after_delete")
@event.listens_for(VideoAiMeta, "after_insert")
@event.listens_for(VideoAiMeta, "after_update")
@event.listens_for(VideoAiMeta, "after_delete")
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

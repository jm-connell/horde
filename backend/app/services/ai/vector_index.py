"""In-memory cosine search over every stored embedding chunk.

``video_embeddings`` keeps one float32 blob per chunk. Scoring a query used to
unpack and multiply every blob in Python on each call. This module holds the
vectors as one L2-normalised ``float32`` matrix per dimension and scores a query
with a single matrix-vector product.

The matrix lives on the engine object (nothing is module-level state), is built
once on first use and then **updated incrementally**: each search first asks the
database, on a fresh connection so it always sees the latest commits, for
``(video_id, count, max(id))`` per video (an index-only scan, a few ms for tens
of thousands of chunks). Videos whose fingerprint differs from the cached one,
plus the videos the ORM reported as written (an in-place vector update keeps its
fingerprint), are masked out and their rows re-read and appended. This covers
every writer, including bulk Core deletes and ``ON DELETE CASCADE``. The matrix
is compacted when more than a fifth of its rows are masked, and rebuilt from
scratch only when most of the library changed at once.

Refreshes and searches are serialised by one lock, so concurrent searchers wait
for a single refresh instead of each building a copy.

Memory is about ``rows x dim x 4`` bytes (60 000 chunks of 768 dims is about
184 MB, plus up to 25% preallocated headroom).
"""

from __future__ import annotations

import logging
import threading

import numpy as np
from sqlalchemy import event, func
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.orm import object_session
from sqlmodel import Session, select

from ...models import VideoEmbedding

logger = logging.getLogger(__name__)

_ENGINE_ATTR = "_horde_embedding_matrix_cache"
_SESSION_DIRTY_KEY = "horde_embeddings_dirty"
_IN_BATCH = 500
_COMPACT_FRACTION = 0.2
_REBUILD_FRACTION = 0.2
_REBUILD_MIN_VIDEOS = 50


class _Block:
    """Growable normalised vectors of one dimension, with an alive mask."""

    def __init__(self, dim: int, capacity: int) -> None:
        self.dim = dim
        self.n = 0
        self.dead = 0
        capacity = max(capacity, 16)
        self.matrix = np.empty((capacity, dim), dtype=np.float32)
        self.video_ids = np.empty(capacity, dtype=np.int64)
        self.chunk_indexes = np.empty(capacity, dtype=np.int64)
        self.alive = np.zeros(capacity, dtype=bool)

    def _grow(self) -> None:
        capacity = self.matrix.shape[0] * 2
        for name in ("matrix", "video_ids", "chunk_indexes", "alive"):
            old = getattr(self, name)
            new = np.zeros((capacity, *old.shape[1:]), dtype=old.dtype)
            new[: self.n] = old[: self.n]
            setattr(self, name, new)

    def append(self, video_id: int, chunk_index: int, blob: bytes) -> None:
        if self.n >= self.matrix.shape[0]:
            self._grow()
        row = self.matrix[self.n]
        row[:] = np.frombuffer(blob, dtype=np.float32, count=self.dim)
        norm = float(np.sqrt(np.dot(row, row)))
        if norm > 0:
            row /= norm
        self.video_ids[self.n] = video_id
        self.chunk_indexes[self.n] = chunk_index
        self.alive[self.n] = True
        self.n += 1

    def mask(self, video_ids: np.ndarray) -> None:
        hit = self.alive[: self.n] & np.isin(self.video_ids[: self.n], video_ids)
        self.alive[: self.n][hit] = False
        self.dead += int(hit.sum())

    def compact(self) -> _Block:
        keep = np.flatnonzero(self.alive[: self.n])
        fresh = _Block(self.dim, int(len(keep) * 1.25))
        fresh.n = len(keep)
        fresh.matrix[: fresh.n] = self.matrix[keep]
        fresh.video_ids[: fresh.n] = self.video_ids[keep]
        fresh.chunk_indexes[: fresh.n] = self.chunk_indexes[keep]
        fresh.alive[: fresh.n] = True
        return fresh


class EmbeddingMatrixCache:
    """The normalised embedding matrices for one database."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._dirty_lock = threading.Lock()
        self._dirty: set[int] = set()
        self._blocks: dict[int, _Block] | None = None
        self._fingerprints: dict[int, tuple[int, int]] = {}
        # Number of full builds, for tests and diagnostics.
        self.full_builds = 0

    def mark_dirty(self, video_ids: set[int]) -> None:
        with self._dirty_lock:
            self._dirty |= video_ids

    def _take_dirty(self) -> set[int]:
        with self._dirty_lock:
            taken, self._dirty = self._dirty, set()
        return taken

    @staticmethod
    def _fingerprints_now(engine: Engine) -> dict[int, tuple[int, int]]:
        with Session(engine) as fresh:
            rows = fresh.exec(
                select(
                    VideoEmbedding.video_id,
                    func.count(VideoEmbedding.id),  # type: ignore[arg-type]
                    func.max(VideoEmbedding.id),  # type: ignore[arg-type]
                ).group_by(VideoEmbedding.video_id)
            ).all()
        return {int(v): (int(c), int(m)) for v, c, m in rows}

    @staticmethod
    def _load_rows(engine: Engine, video_ids: list[int] | None):
        """Yield (video_id, chunk_index, dim, blob), oldest row first."""
        with Session(engine) as fresh:
            batches = (
                [None]
                if video_ids is None
                else [
                    video_ids[i : i + _IN_BATCH]
                    for i in range(0, len(video_ids), _IN_BATCH)
                ]
            )
            for batch in batches:
                statement = select(
                    VideoEmbedding.video_id,
                    VideoEmbedding.chunk_index,
                    VideoEmbedding.dim,
                    VideoEmbedding.vector,
                ).order_by(VideoEmbedding.id)  # type: ignore[arg-type]
                if batch is not None:
                    statement = statement.where(
                        VideoEmbedding.video_id.in_(batch)  # type: ignore[attr-defined]
                    )
                yield from fresh.exec(statement.execution_options(yield_per=2000))

    @staticmethod
    def _add_rows(blocks: dict[int, _Block], rows, expected: int) -> None:
        for video_id, chunk_index, dim, blob in rows:
            blob = blob or b""
            n = dim or len(blob) // 4
            if n <= 0 or len(blob) < n * 4:
                n = len(blob) // 4
            if n <= 0:
                continue
            block = blocks.get(n)
            if block is None:
                block = blocks[n] = _Block(n, int(expected * 1.25))
            block.append(int(video_id), int(chunk_index), blob)

    def _full_build(self, engine: Engine, fingerprints) -> None:
        total = sum(count for count, _ in fingerprints.values())
        blocks: dict[int, _Block] = {}
        self._add_rows(blocks, self._load_rows(engine, None), total)
        self._blocks = blocks
        self._fingerprints = fingerprints
        self.full_builds += 1

    def _refresh(self, engine: Engine) -> dict[int, _Block]:
        dirty = self._take_dirty()
        try:
            fingerprints = self._fingerprints_now(engine)
            if self._blocks is None:
                self._full_build(engine, fingerprints)
                return self._blocks  # type: ignore[return-value]
            old = self._fingerprints
            changed = set(dirty)
            changed |= {v for v, fp in fingerprints.items() if old.get(v) != fp}
            changed |= {v for v in old if v not in fingerprints}
            if not changed:
                return self._blocks
            if len(changed) > max(
                _REBUILD_MIN_VIDEOS, _REBUILD_FRACTION * len(fingerprints)
            ):
                self._full_build(engine, fingerprints)
                return self._blocks  # type: ignore[return-value]
            ids = np.fromiter(changed, np.int64, len(changed))
            for block in self._blocks.values():
                block.mask(ids)
            present = sorted(v for v in changed if v in fingerprints)
            self._add_rows(self._blocks, self._load_rows(engine, present), 0)
            for dim, block in list(self._blocks.items()):
                if block.n and block.dead > _COMPACT_FRACTION * block.n:
                    self._blocks[dim] = block.compact()
            self._fingerprints = {
                **{v: fp for v, fp in old.items() if v not in changed},
                **{v: fingerprints[v] for v in present},
            }
            return self._blocks
        except BaseException:
            self.mark_dirty(dirty)
            raise

    def top_chunks(
        self,
        engine: Engine,
        query_vec: list[float],
        *,
        limit: int,
        exclude_ids: set[int],
        min_score: float,
    ) -> list[tuple[int, float, int]]:
        query = np.asarray(query_vec, dtype=np.float32)
        norm = float(np.linalg.norm(query))
        if query.size == 0 or norm <= 0:
            return []
        with self._lock:
            block = self._refresh(engine).get(int(query.size))
            if block is None or block.n == 0:
                return []
            n = block.n
            scores = block.matrix[:n] @ (query / norm)
            keep = block.alive[:n] & (scores >= min_score)
            if exclude_ids:
                keep &= ~np.isin(
                    block.video_ids[:n], np.fromiter(exclude_ids, np.int64)
                )
            candidates = np.flatnonzero(keep)
            if candidates.size == 0:
                return []
            order = candidates[np.argsort(-scores[candidates], kind="stable")]
            seen: set[int] = set()
            out: list[tuple[int, float, int]] = []
            for idx in order:
                video_id = int(block.video_ids[idx])
                if video_id in seen:
                    continue
                seen.add(video_id)
                out.append(
                    (video_id, float(scores[idx]), int(block.chunk_indexes[idx]))
                )
                if len(out) >= limit:
                    break
            return out


_CREATE_LOCK = threading.Lock()


def _existing_cache(engine: Engine) -> EmbeddingMatrixCache | None:
    return getattr(engine, _ENGINE_ATTR, None)


def cache_for(session: Session) -> EmbeddingMatrixCache:
    engine = session.get_bind()
    with _CREATE_LOCK:
        cache = _existing_cache(engine)  # type: ignore[arg-type]
        if cache is None:
            cache = EmbeddingMatrixCache()
            setattr(engine, _ENGINE_ATTR, cache)
    return cache


def top_chunks(
    session: Session,
    query_vec: list[float],
    *,
    limit: int,
    exclude_ids: set[int],
    min_score: float,
) -> list[tuple[int, float, int]]:
    """(video_id, score, chunk_index) for each video's best chunk, best first."""
    return cache_for(session).top_chunks(
        session.get_bind(),  # type: ignore[arg-type]
        query_vec,
        limit=limit,
        exclude_ids=exclude_ids,
        min_score=min_score,
    )


@event.listens_for(VideoEmbedding, "after_insert")
@event.listens_for(VideoEmbedding, "after_update")
@event.listens_for(VideoEmbedding, "after_delete")
def _mark_dirty(_mapper, connection, target) -> None:
    session = object_session(target)
    if session is not None:
        pending = session.info.setdefault(
            _SESSION_DIRTY_KEY, (connection.engine, set())
        )
        pending[1].add(int(target.video_id))


@event.listens_for(OrmSession, "after_commit")
def _publish_after_commit(session: OrmSession) -> None:
    pending = session.info.pop(_SESSION_DIRTY_KEY, None)
    if pending is None:
        return
    engine, video_ids = pending
    cache = _existing_cache(engine)
    if cache is not None:
        cache.mark_dirty(video_ids)


@event.listens_for(OrmSession, "after_rollback")
def _forget_after_rollback(session: OrmSession) -> None:
    session.info.pop(_SESSION_DIRTY_KEY, None)

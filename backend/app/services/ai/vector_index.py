"""In-memory cosine search over every stored embedding chunk.

``video_embeddings`` keeps one float32 blob per chunk. Scoring a query used to
unpack and multiply every blob in Python on each call. This module holds the
vectors as one L2-normalised ``float32`` matrix per dimension and scores a query
with a single matrix-vector product.

The matrix is built lazily on first use and kept on the engine
object, so each engine (a test's, the app's) has its own and nothing
is module-level. It is rebuilt when

* an ORM write touches ``VideoEmbedding`` (marked in the session, applied after
  the transaction commits so a concurrent reader cannot cache a half-written
  state), or
* the table's ``(count, max(id))`` signature differs from the one the matrix
  was built from. That catches deletes that bypass the ORM, such as the
  ``ON DELETE CASCADE`` of a deleted video.

Memory is ``rows x dim x 4`` bytes (60 000 chunks of 768 dims is about 184 MB).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

import numpy as np
from sqlalchemy import event, func
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session as OrmSession
from sqlmodel import Session, select

from ...models import VideoEmbedding

logger = logging.getLogger(__name__)

_ENGINE_ATTR = "_horde_embedding_matrix_cache"
_SESSION_DIRTY_KEY = "horde_embeddings_dirty"


@dataclass(frozen=True)
class _Block:
    """All chunks of one dimension."""

    matrix: np.ndarray  # (rows, dim) float32, rows L2-normalised (zero rows stay zero)
    video_ids: np.ndarray  # (rows,) int64
    chunk_indexes: np.ndarray  # (rows,) int64


class EmbeddingMatrixCache:
    """The normalised embedding matrices for one database."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._blocks: dict[int, _Block] = {}
        self._signature: tuple[int, int] | None = None
        self._generation = 0

    def invalidate(self) -> None:
        with self._lock:
            self._generation += 1
            self._signature = None
            self._blocks = {}

    def _table_signature(self, session: Session) -> tuple[int, int]:
        count, top = session.exec(
            select(func.count(VideoEmbedding.id), func.max(VideoEmbedding.id))  # type: ignore[arg-type]
        ).one()
        return int(count or 0), int(top or 0)

    def blocks(self, session: Session) -> dict[int, _Block]:
        signature = self._table_signature(session)
        with self._lock:
            if self._signature == signature:
                return self._blocks
            generation = self._generation
        built = self._build(session)
        with self._lock:
            # An invalidation while we were reading means the data we hold may
            # already be stale: hand it to this caller but do not keep it.
            if generation == self._generation:
                self._blocks = built
                self._signature = signature
        return built

    @staticmethod
    def _build(session: Session) -> dict[int, _Block]:
        rows = session.exec(
            select(
                VideoEmbedding.video_id,
                VideoEmbedding.chunk_index,
                VideoEmbedding.dim,
                VideoEmbedding.vector,
            ).order_by(VideoEmbedding.id)  # type: ignore[arg-type]
        ).all()
        by_dim: dict[int, list[tuple[int, int, bytes]]] = {}
        for video_id, chunk_index, dim, blob in rows:
            n = dim or len(blob or b"") // 4
            if n <= 0 or len(blob or b"") < n * 4:
                n = len(blob or b"") // 4
            if n <= 0:
                continue
            by_dim.setdefault(n, []).append((video_id, int(chunk_index), blob))
        blocks: dict[int, _Block] = {}
        for n, items in by_dim.items():
            joined = b"".join(blob[: n * 4] for _v, _c, blob in items)
            matrix = np.frombuffer(joined, dtype=np.float32).reshape(len(items), n)
            matrix = matrix.copy()  # frombuffer is read-only; we normalise in place
            norms = np.sqrt(np.einsum("ij,ij->i", matrix, matrix))[:, None]
            np.divide(matrix, norms, out=matrix, where=norms > 0)
            blocks[n] = _Block(
                matrix=matrix,
                video_ids=np.fromiter((v for v, _c, _b in items), np.int64, len(items)),
                chunk_indexes=np.fromiter(
                    (c for _v, c, _b in items), np.int64, len(items)
                ),
            )
        return blocks


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
    query = np.asarray(query_vec, dtype=np.float32)
    norm = float(np.linalg.norm(query))
    if query.size == 0 or norm <= 0:
        return []
    block = cache_for(session).blocks(session).get(int(query.size))
    if block is None:
        return []
    scores = block.matrix @ (query / norm)
    keep = scores >= min_score
    if exclude_ids:
        keep &= ~np.isin(block.video_ids, np.fromiter(exclude_ids, np.int64))
    candidates = np.flatnonzero(keep)
    if candidates.size == 0:
        return []
    # Stable sort: equal scores keep table order, so the first chunk wins a tie.
    order = candidates[np.argsort(-scores[candidates], kind="stable")]
    seen: set[int] = set()
    out: list[tuple[int, float, int]] = []
    for idx in order:
        video_id = int(block.video_ids[idx])
        if video_id in seen:
            continue
        seen.add(video_id)
        out.append((video_id, float(scores[idx]), int(block.chunk_indexes[idx])))
        if len(out) >= limit:
            break
    return out


@event.listens_for(VideoEmbedding, "after_insert")
@event.listens_for(VideoEmbedding, "after_update")
@event.listens_for(VideoEmbedding, "after_delete")
def _mark_dirty(_mapper, connection, target) -> None:
    from sqlalchemy.orm import object_session

    session = object_session(target)
    if session is not None:
        session.info[_SESSION_DIRTY_KEY] = connection.engine


@event.listens_for(OrmSession, "after_commit")
def _invalidate_after_commit(session: OrmSession) -> None:
    engine: Engine | None = session.info.pop(_SESSION_DIRTY_KEY, None)
    if engine is None:
        return
    cache = _existing_cache(engine)
    if cache is not None:
        cache.invalidate()


@event.listens_for(OrmSession, "after_rollback")
def _forget_after_rollback(session: OrmSession) -> None:
    session.info.pop(_SESSION_DIRTY_KEY, None)

"""Per-channel matrices of Ask passage vectors, for exact cosine search.

Held on ``AppContext.knowledge.vectors`` (least recently used channels dropped
past ``MAX_CHANNELS``). A channel's matrix is rebuilt when its fingerprint, the
count and highest chunk id of its current-model vectors, changes; that covers
every writer, including cascades and factory reset, which bypass the ORM.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np
from sqlalchemy import text
from sqlmodel import Session

from ...models import KbChannel

MAX_CHANNELS = 8


@dataclass
class _Matrix:
    fingerprint: tuple[int, int, str]
    chunk_ids: np.ndarray
    matrix: np.ndarray


@dataclass
class VectorCache:
    lock: threading.Lock = field(default_factory=threading.Lock)
    channels: OrderedDict[int, _Matrix] = field(default_factory=OrderedDict)


_CURRENT = (
    "FROM kb_chunk_vectors v JOIN kb_chunks c ON c.id = v.chunk_id "
    "JOIN kb_videos vid ON vid.id = c.kb_video_id "
    "WHERE c.kb_channel_id = :c AND vid.embedded_model = :m"
)


def _fingerprint(session: Session, channel: KbChannel) -> tuple[int, int, str]:
    model = channel.embed_model or ""
    count, top = session.execute(
        text(f"SELECT count(*), coalesce(max(v.chunk_id), 0) {_CURRENT}"),
        {"c": channel.id, "m": model},
    ).one()
    return int(count), int(top), model


def _load(session: Session, channel: KbChannel, fp: tuple[int, int, str]) -> _Matrix:
    rows = session.execute(
        text(f"SELECT v.chunk_id, v.vector {_CURRENT} ORDER BY v.chunk_id"),
        {"c": channel.id, "m": fp[2]},
    ).all()
    dim = channel.embed_dim
    rows = [r for r in rows if len(r[1]) == dim * 2]
    matrix = np.empty((len(rows), dim), dtype=np.float32)
    for i, (_, blob) in enumerate(rows):
        matrix[i] = np.frombuffer(blob, dtype=np.float16, count=dim)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    np.divide(matrix, norms, out=matrix, where=norms > 0)
    ids = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
    return _Matrix(fp, ids, matrix)


def top_chunks(
    session: Session,
    cache: VectorCache,
    channel: KbChannel,
    query: list[float],
    k: int,
    *,
    model: str,
) -> list[tuple[int, float]]:
    """``(chunk_id, cosine)`` of the channel's ``k`` passages closest to ``query``.

    ``model`` embedded the query; a channel not yet re-embedded with it has none.
    """
    if (
        channel.embed_model != model
        or channel.embed_dim != len(query)
        or channel.id is None
    ):
        return []
    fp = _fingerprint(session, channel)
    with cache.lock:
        held = cache.channels.get(channel.id)
        if held is None or held.fingerprint != fp:
            held = _load(session, channel, fp)
            cache.channels[channel.id] = held
        cache.channels.move_to_end(channel.id)
        while len(cache.channels) > MAX_CHANNELS:
            cache.channels.popitem(last=False)
    if not len(held.chunk_ids):
        return []
    q = np.asarray(query, dtype=np.float32)
    norm = float(np.linalg.norm(q))
    if norm == 0:
        return []
    scores = held.matrix @ (q / norm)
    k = min(k, len(scores))
    best = np.argpartition(-scores, k - 1)[:k]
    best = best[np.argsort(-scores[best])]
    return [(int(held.chunk_ids[i]), float(scores[i])) for i in best]

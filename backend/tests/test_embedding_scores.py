"""Vectorized embedding scoring matches the per-row cosine it replaced."""

from __future__ import annotations

import random
import struct

import pytest

from app.models import VideoEmbedding
from app.services.ai import embeddings


def _reference_cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a)
    nb = sum(y * y for y in b)
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))


def _rand(dim: int, rng: random.Random) -> list[float]:
    return [rng.uniform(-1, 1) for _ in range(dim)]


def test_cosine_scores_match_reference_including_edge_rows():
    rng = random.Random(7)
    q = _rand(16, rng)
    rows: list[tuple[bytes, int | None]] = [
        (embeddings.pack_vector(_rand(16, rng)), 16) for _ in range(40)
    ]
    rows += [
        (b"", 0),  # empty
        (embeddings.pack_vector([0.0] * 16), 16),  # zero norm
        (embeddings.pack_vector(_rand(8, rng)), 8),  # wrong dim
        (embeddings.pack_vector(_rand(16, rng)), None),  # dim from blob size
        (embeddings.pack_vector(_rand(16, rng)), 0),
        (embeddings.pack_vector(_rand(20, rng)), 16),  # oversize blob, trimmed
        (embeddings.pack_vector(_rand(12, rng)), 16),  # short blob → 12 dims
    ]
    blobs = [b for b, _ in rows]
    dims = [d for _, d in rows]

    got = embeddings.cosine_scores(q, blobs, dims)

    # Reference uses the float32 round-trip the store applies.
    q32 = list(struct.unpack("16f", embeddings.pack_vector(q)))
    for i, (blob, dim) in enumerate(rows):
        want = _reference_cosine(q32, embeddings.unpack_vector(blob, dim))
        assert got[i] == pytest.approx(want, abs=1e-5), i


def test_cosine_scores_batches(monkeypatch):
    monkeypatch.setattr(embeddings, "_SCORE_BATCH_ROWS", 3)
    rng = random.Random(3)
    q = _rand(4, rng)
    vecs = [_rand(4, rng) for _ in range(10)]
    got = embeddings.cosine_scores(
        q, [embeddings.pack_vector(v) for v in vecs], [4] * 10
    )
    for i, v in enumerate(vecs):
        assert got[i] == pytest.approx(_reference_cosine(q, v), abs=1e-5)


def test_cosine_scores_empty_query_or_rows():
    assert list(embeddings.cosine_scores([], [b"x" * 8], [2])) == [0.0]
    assert len(embeddings.cosine_scores([1.0, 0.0], [], [])) == 0
    assert list(embeddings.cosine_scores([0.0, 0.0], [embeddings.pack_vector([1.0, 0.0])], [2])) == [0.0]


def test_cosine_single_pair():
    assert embeddings.cosine([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert embeddings.cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert embeddings.cosine([1.0], [1.0, 2.0]) == 0.0
    assert embeddings.cosine([0.0, 0.0], [1.0, 1.0]) == 0.0


def test_similar_video_hits_best_chunk_per_video(session, add_video):
    v1 = add_video(title="one")
    v2 = add_video(title="two")
    v3 = add_video(title="three")

    def emb(video_id: int, chunk: int, vec: list[float]) -> None:
        session.add(
            VideoEmbedding(
                video_id=video_id,
                chunk_index=chunk,
                dim=len(vec),
                vector=embeddings.pack_vector(vec),
            )
        )

    emb(v1.id, -1, [1.0, 0.0, 0.0])
    emb(v1.id, 0, [0.6, 0.8, 0.0])
    emb(v2.id, -1, [0.0, 1.0, 0.0])
    emb(v2.id, 3, [0.8, 0.6, 0.0])
    emb(v3.id, -1, [0.0, 0.0, 1.0])  # orthogonal → below min_score
    session.commit()

    hits = embeddings.similar_video_hits(session, [1.0, 0.0, 0.0])
    assert [(vid, chunk) for vid, _s, chunk in hits] == [(v1.id, -1), (v2.id, 3)]
    assert hits[0][1] == pytest.approx(1.0)
    assert hits[1][1] == pytest.approx(0.8)

    excluded = embeddings.similar_video_hits(
        session, [1.0, 0.0, 0.0], exclude_ids={v1.id}
    )
    assert [vid for vid, _s, _c in excluded] == [v2.id]

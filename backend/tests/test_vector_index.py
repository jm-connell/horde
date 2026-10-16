"""Cached numpy cosine search must match the plain-Python definition."""

from __future__ import annotations

import random

import pytest
from sqlmodel import Session, select

from app.models import VideoEmbedding
from app.services.ai import embeddings
from app.services.ai.embeddings import cosine, pack_vector, unpack_vector


def _store(session, video_id, chunk, vec, *, model="m"):
    session.add(
        VideoEmbedding(
            video_id=video_id,
            chunk_index=chunk,
            model=model,
            dim=len(vec),
            vector=pack_vector(vec),
            content_hash="h",
        )
    )


def _reference(session, query, *, limit, exclude, min_score):
    best: dict[int, tuple[float, int]] = {}
    for row in session.exec(select(VideoEmbedding)).all():
        if row.video_id in exclude:
            continue
        score = cosine(query, unpack_vector(row.vector, row.dim))
        if score < min_score:
            continue
        prev = best.get(row.video_id)
        if prev is None or score > prev[0]:
            best[row.video_id] = (score, row.chunk_index)
    ranked = sorted(best.items(), key=lambda kv: kv[1][0], reverse=True)
    return [(vid, sc, ch) for vid, (sc, ch) in ranked[:limit]]


@pytest.fixture
def library_of_vectors(session, add_video):
    rng = random.Random(7)  # noqa: S311 - deterministic test data
    videos = [add_video(title=f"V{i}") for i in range(12)]
    for video in videos:
        for chunk in (-1, 0, 1):
            _store(session, video.id, chunk, [rng.uniform(-1, 1) for _ in range(8)])
    session.commit()
    return videos


def test_matches_the_reference_implementation(session, library_of_vectors):
    rng = random.Random(3)  # noqa: S311 - deterministic test data
    for _ in range(5):
        query = [rng.uniform(-1, 1) for _ in range(8)]
        for min_score in (-1.0, 0.0, 0.3):
            exclude = {library_of_vectors[2].id}
            got = embeddings.similar_video_hits(
                session, query, limit=7, exclude_ids=exclude, min_score=min_score
            )
            want = _reference(
                session, query, limit=7, exclude=exclude, min_score=min_score
            )
            assert [(v, c) for v, _s, c in got] == [(v, c) for v, _s, c in want]
            for (_, a, _), (_, b, _) in zip(got, want, strict=True):
                assert a == pytest.approx(b, abs=1e-5)


def test_ignores_other_dimensions_zero_vectors_and_bad_queries(session, add_video):
    video = add_video(title="A")
    other = add_video(title="B")
    _store(session, video.id, -1, [1.0, 0.0, 0.0])
    _store(session, other.id, -1, [1.0, 0.0])  # another model's dimension
    zero = add_video(title="Z")
    _store(session, zero.id, -1, [0.0, 0.0, 0.0])
    session.commit()
    hits = embeddings.similar_video_hits(session, [1.0, 0.0, 0.0], min_score=0.1)
    assert [h[0] for h in hits] == [video.id]
    assert embeddings.similar_video_hits(session, [0.0, 0.0, 0.0]) == []
    assert embeddings.similar_video_hits(session, []) == []
    assert embeddings.similar_video_hits(session, [1.0] * 5) == []


def test_new_and_replaced_embeddings_are_seen(session, add_video):
    first = add_video(title="First")
    _store(session, first.id, -1, [1.0, 0.0])
    session.commit()
    assert [h[0] for h in embeddings.similar_video_hits(session, [1.0, 0.0])] == [
        first.id
    ]

    second = add_video(title="Second")
    _store(session, second.id, -1, [0.9, 0.1])
    session.commit()
    assert [h[0] for h in embeddings.similar_video_hits(session, [1.0, 0.0])] == [
        first.id,
        second.id,
    ]

    # Replace in place, keeping count and max id unchanged.
    row = session.exec(
        select(VideoEmbedding).where(VideoEmbedding.video_id == first.id)
    ).one()
    row.vector = pack_vector([0.0, 1.0])
    session.add(row)
    session.commit()
    assert [h[0] for h in embeddings.similar_video_hits(session, [1.0, 0.0])] == [
        second.id
    ]

    embeddings.delete_embeddings(session, second.id)
    assert embeddings.similar_video_hits(session, [1.0, 0.0]) == []


def test_cascade_delete_of_a_video_drops_its_vectors(session, add_video):
    from app.services.video_delete import delete_video_cascade

    keep = add_video(title="Keep")
    gone = add_video(title="Gone")
    _store(session, keep.id, -1, [0.5, 0.5])
    _store(session, gone.id, -1, [1.0, 0.0])
    session.commit()
    assert len(embeddings.similar_video_hits(session, [1.0, 0.0])) == 2
    delete_video_cascade(session, gone, delete_files=False)
    assert [h[0] for h in embeddings.similar_video_hits(session, [1.0, 0.0])] == [
        keep.id
    ]


def test_a_rollback_does_not_keep_stale_state(session, add_video):
    from app.context import get_engine

    video = add_video(title="V")
    _store(session, video.id, -1, [1.0, 0.0])
    session.commit()
    assert len(embeddings.similar_video_hits(session, [1.0, 0.0])) == 1
    with Session(get_engine()) as other:
        _store(other, video.id, 0, [0.0, 1.0])
        other.flush()
        other.rollback()
    assert [
        h[2] for h in embeddings.similar_video_hits(session, [0.0, 1.0], min_score=0.5)
    ] == []


def _cache(session):
    from app.services.ai import vector_index

    return vector_index.cache_for(session)


def test_writing_one_video_updates_the_matrix_without_a_full_build(
    session, library_of_vectors
):
    query = [0.3, -0.2, 0.5, 0.1, -0.4, 0.2, 0.0, 0.6]
    before = embeddings.similar_video_hits(session, query, limit=50, min_score=-1.0)
    cache = _cache(session)
    assert cache.full_builds == 1

    target = library_of_vectors[4]
    other = [h for h in before if h[0] != target.id]
    embeddings.delete_embeddings(session, target.id)
    _store(session, target.id, -1, [0.3, -0.2, 0.5, 0.1, -0.4, 0.2, 0.0, 0.6])
    session.commit()

    after = embeddings.similar_video_hits(session, query, limit=50, min_score=-1.0)
    assert cache.full_builds == 1
    assert [h for h in after if h[0] != target.id] == other
    assert after[0][0] == target.id
    assert after[0][1] == pytest.approx(1.0, abs=1e-5)
    assert [h[0] for h in after].count(target.id) == 1


def test_many_writes_compact_without_changing_results(session, library_of_vectors):
    query = [1.0, 0.5, -0.5, 0.2, 0.1, -0.3, 0.4, 0.0]
    embeddings.similar_video_hits(session, query)
    cache = _cache(session)
    rng = random.Random(11)  # noqa: S311 - deterministic test data
    for video in library_of_vectors[:5]:
        embeddings.delete_embeddings(session, video.id)
        for chunk in (-1, 0):
            _store(session, video.id, chunk, [rng.uniform(-1, 1) for _ in range(8)])
        session.commit()
        got = embeddings.similar_video_hits(session, query, limit=50, min_score=-1.0)
        want = _reference(session, query, limit=50, exclude=set(), min_score=-1.0)
        assert [(v, c) for v, _s, c in got] == [(v, c) for v, _s, c in want]
    assert cache.full_builds == 1


def test_core_deletes_are_noticed_without_a_full_build(session, library_of_vectors):
    from sqlalchemy import delete

    query = [1.0] * 8
    embeddings.similar_video_hits(session, query, limit=50, min_score=-1.0)
    cache = _cache(session)
    gone = library_of_vectors[1].id
    session.execute(delete(VideoEmbedding).where(VideoEmbedding.video_id == gone))
    session.commit()
    hits = embeddings.similar_video_hits(session, query, limit=50, min_score=-1.0)
    assert gone not in {h[0] for h in hits}
    assert len(hits) == len(library_of_vectors) - 1
    assert cache.full_builds == 1

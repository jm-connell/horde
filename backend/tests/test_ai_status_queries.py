"""The polled AI endpoints cost the same number of queries whatever the library size."""

from __future__ import annotations

from query_counter import count_queries

from app.models import (
    AiJob,
    AiJobKind,
    AiJobStatus,
    VideoAiMeta,
    VideoEmbedding,
)
from app.services.ai.provider import resolve_embed_model


def _seed(add_video, session, n: int, first: int = 0) -> None:
    model = resolve_embed_model()
    for i in range(first, first + n):
        video = add_video(title=f"A{i}")
        session.add(VideoAiMeta(video_id=video.id, embed_status="ready"))
        session.add(VideoEmbedding(video_id=video.id, model=model))
        session.add(
            AiJob(
                kind=AiJobKind.chapters,
                video_id=video.id,
                status=AiJobStatus.error,
                error="boom",
            )
        )
    session.commit()


def test_ai_status_has_constant_query_count(client, session, add_video, init_db):
    engine = init_db["engine"]
    _seed(add_video, session, 2)
    client.get("/api/ai/status")  # warm caches (settings, auth)
    with count_queries(engine) as small:
        body = client.get("/api/ai/status").json()
    assert body["indexed_videos"] == 2
    assert len(body["recent_failures"]) == 2

    _seed(add_video, session, 20, first=2)
    with count_queries(engine) as big:
        body = client.get("/api/ai/status").json()
    assert body["indexed_videos"] == 22
    assert body["total_videos"] == 22
    assert len(body["recent_failures"]) == 10
    assert body["recent_failures"][0]["title"]
    assert len(big) == len(small), "\n".join(big)


def test_ai_status_ignores_stale_embedding_models(client, session, add_video):
    video = add_video(title="Stale")
    session.add(VideoAiMeta(video_id=video.id, embed_status="ready"))
    session.add(VideoEmbedding(video_id=video.id, model="some-other-model"))
    session.commit()
    body = client.get("/api/ai/status").json()
    assert (body["indexed_videos"], body["total_videos"]) == (0, 1)


def test_ai_jobs_has_constant_query_count(client, session, add_video, init_db):
    engine = init_db["engine"]
    _seed(add_video, session, 2)
    client.get("/api/ai/jobs")
    with count_queries(engine) as small:
        assert len(client.get("/api/ai/jobs").json()) == 2
    _seed(add_video, session, 20, first=2)
    with count_queries(engine) as big:
        rows = client.get("/api/ai/jobs").json()
    assert len(rows) == 22
    assert rows[0]["title"]
    assert len(big) == len(small), "\n".join(big)

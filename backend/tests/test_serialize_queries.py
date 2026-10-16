"""A page of videos costs the same number of queries whatever its size."""

from __future__ import annotations

from contextlib import contextmanager

from sqlalchemy import event

from app.models import VideoAiMeta


@contextmanager
def count_queries(engine):
    statements: list[str] = []

    def before(_conn, _cursor, statement, *_rest):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", before)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", before)


def _seed(add_video, session, n: int, first: int = 0, review: bool = True):
    for i in range(first, first + n):
        video = add_video(
            title=f"Q{i}", needs_review=review, thumbnail_path=f"/t/{i}.jpg"
        )
        session.add(VideoAiMeta(video_id=video.id, summary=f"s{i}", ai_tags='["a"]'))
    session.commit()


def test_full_payload_page_has_constant_query_count(
    client, session, add_video, init_db
):
    engine = init_db["engine"]
    _seed(add_video, session, 3)
    client.get("/api/review")  # warm caches (settings, auth)
    with count_queries(engine) as small:
        resp = client.get("/api/review", params={"limit": 500})
    assert len(resp.json()["items"]) == 3

    _seed(add_video, session, 47, first=3)
    with count_queries(engine) as big:
        resp = client.get("/api/review", params={"limit": 500})
    body = resp.json()
    assert len(body["items"]) == 50
    assert body["items"][0]["ai_summary"] is not None
    assert body["items"][0]["has_thumbnail"] is True
    assert len(big) == len(small), "\n".join(big)


def test_compact_library_page_has_constant_query_count(
    client, session, add_video, init_db
):
    engine = init_db["engine"]
    _seed(add_video, session, 3, review=False)
    client.get("/api/videos")
    with count_queries(engine) as small:
        client.get("/api/videos")
    _seed(add_video, session, 47, first=3, review=False)
    with count_queries(engine) as big:
        assert len(client.get("/api/videos").json()["items"]) == 50
    assert len(big) == len(small), "\n".join(big)

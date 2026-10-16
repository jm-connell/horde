"""A search is ranked once per walk through its pages, and only AI users pay for it."""

from __future__ import annotations

import threading
import time

import pytest
from sqlmodel import Session

from app.models import User, Video
from app.services.auth import permissions
from app.services.search_cache import SearchCache

QUERY = "how to repair bicycle brakes"


class _Embedder:
    """Stands in for the embedding provider and counts the paid calls."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.hits: list[tuple[int, float, int]] = []

    def embed_query(self, text: str):
        self.calls.append(text)
        return [0.1, 0.2, 0.3]

    def similar(self, _session, _vec, **_kw):
        return list(self.hits)


@pytest.fixture
def embedder(monkeypatch):
    e = _Embedder()
    monkeypatch.setattr("app.services.ai.search.get_embed_provider", lambda: object())
    monkeypatch.setattr("app.services.ai.embeddings.embed_query", e.embed_query)
    monkeypatch.setattr("app.services.ai.embeddings.similar_video_hits", e.similar)
    return e


def _seed(add_video, embedder, keyword: int = 7, semantic: int = 6) -> list[int]:
    ids = [add_video(title=f"{QUERY} part {i}").id for i in range(keyword)]
    related = [add_video(title=f"Wheel truing {i}").id for i in range(semantic)]
    embedder.hits = [(vid, 0.9 - i * 0.01, -1) for i, vid in enumerate(related)]
    return ids + related


def _walk(client, limit: int = 4, **params) -> list[int]:
    seen: list[int] = []
    cursor = None
    while True:
        page = client.get(
            "/api/videos",
            params={
                "q": QUERY,
                "limit": limit,
                **params,
                **({"cursor": cursor} if cursor else {}),
            },
        ).json()
        seen += [v["id"] for v in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            return seen


def test_pages_embed_the_query_once_and_neither_skip_nor_repeat(
    client, add_video, embedder
):
    expected = set(_seed(add_video, embedder))
    seen = _walk(client)
    assert len(seen) == len(set(seen)) == len(expected)
    assert set(seen) == expected
    assert len(embedder.calls) == 1
    cache = client.app.state.search_cache
    assert cache.computes == 1


def test_another_sort_of_the_same_query_reuses_the_vector(client, add_video, embedder):
    _seed(add_video, embedder)
    _walk(client)
    _walk(client, sort="title", order="asc")
    assert len(embedder.calls) == 1
    assert client.app.state.search_cache.computes == 2


def test_a_library_change_invalidates_the_ranking(client, add_video, session, embedder):
    _seed(add_video, embedder)
    first = _walk(client)
    cache = client.app.state.search_cache
    assert cache.computes == 1

    added = add_video(title=f"{QUERY} brand new").id
    again = _walk(client)
    assert cache.computes == 2
    assert added in again and added not in first

    video = session.get(Video, added)
    video.title = "Totally different now"
    session.add(video)
    session.commit()
    assert added not in _walk(client)
    assert cache.computes == 3


def test_ranking_expires_after_the_ttl(client, add_video, embedder, init_db):
    _seed(add_video, embedder)
    clock = [1000.0]
    cache = SearchCache(ttl=60, clock=lambda: clock[0])
    cache.attach(init_db["engine"])
    client.app.state.search_cache = cache
    client.get("/api/videos", params={"q": QUERY})
    client.get("/api/videos", params={"q": QUERY})
    assert cache.computes == 1
    clock[0] += 61
    client.get("/api/videos", params={"q": QUERY})
    assert cache.computes == 2
    assert len(embedder.calls) == 2  # the vector expired with it


def test_cache_is_bounded():
    cache = SearchCache(max_entries=3, max_bytes=10_000)
    for i in range(10):
        cache.ranking(("q", i), lambda: (), lambda: (list(range(5)), {}))
    assert len(cache._rankings) == 3
    cache.ranking(("big",), lambda: (), lambda: (list(range(500)), {}))
    assert cache._bytes <= 10_000
    # Too large to keep at all: still answered, just not stored.
    cache.ranking(("huge",), lambda: (), lambda: (list(range(5000)), {}))
    assert ("huge",) not in cache._rankings


def test_member_without_use_ai_gets_keyword_results_and_no_embedding_call(
    app, init_db, member_user, add_video, embedder
):
    from tests.conftest import _client, _session_cookie

    with Session(init_db["engine"]) as s:
        user = s.get(User, member_user.id)
        user.permissions = permissions.dump(frozenset({"download"}))
        s.add(user)
        s.commit()
    keyword_ids = {add_video(title=f"{QUERY} part {i}").id for i in range(3)}
    other = add_video(title="Wheel truing").id
    embedder.hits = [(other, 0.95, -1)]

    with _client(app, cookies=_session_cookie(init_db, member_user)) as member:
        found = {
            v["id"]
            for v in member.get("/api/videos", params={"q": QUERY}).json()["items"]
        }
    assert found == keyword_ids
    assert embedder.calls == []


def test_catalog_search_embeds_only_for_use_ai(
    app, client, init_db, member_user, embedder
):
    from tests.conftest import _client, _session_cookie

    client.get("/api/channels/catalog/search", params={"q": QUERY})
    assert embedder.calls, "control: an administrator's catalog search embeds"
    embedder.calls.clear()

    with Session(init_db["engine"]) as s:
        user = s.get(User, member_user.id)
        user.permissions = permissions.dump(frozenset({"download"}))
        s.add(user)
        s.commit()
    with _client(app, cookies=_session_cookie(init_db, member_user)) as member:
        resp = member.get("/api/channels/catalog/search", params={"q": QUERY})
        assert resp.status_code == 200
    assert embedder.calls == []


def _slow_embedder(monkeypatch, embedder, seconds: float):
    def slow(text):
        embedder.calls.append(text)
        time.sleep(seconds)
        return [0.1, 0.2, 0.3]

    monkeypatch.setattr("app.services.ai.embeddings.embed_query", slow)


def test_a_commit_never_waits_for_an_in_flight_search(
    client, add_video, session, embedder, monkeypatch
):
    _seed(add_video, embedder)
    _slow_embedder(monkeypatch, embedder, 2.0)
    searching = threading.Thread(
        target=lambda: client.get("/api/videos", params={"q": QUERY + " slow"})
    )
    searching.start()
    time.sleep(0.4)  # the search is now inside the provider call
    started = time.monotonic()
    video = session.get(Video, 1)
    video.notes = "edited during a search"
    session.add(video)
    session.commit()
    elapsed = time.monotonic() - started
    searching.join()
    assert elapsed < 1.0, f"commit waited {elapsed:.2f}s behind a search"


def test_concurrent_first_pages_rank_and_embed_once(
    client, add_video, embedder, monkeypatch
):
    _seed(add_video, embedder)
    _slow_embedder(monkeypatch, embedder, 0.6)
    results: list[list[int]] = []

    def first_page():
        body = client.get("/api/videos", params={"q": QUERY, "limit": 4}).json()
        results.append([v["id"] for v in body["items"]])

    threads = [threading.Thread(target=first_page) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(results) == 4 and all(r == results[0] for r in results)
    assert len(embedder.calls) == 1
    assert client.app.state.search_cache.computes == 1


def test_a_write_during_a_search_is_not_cached_as_current(
    client, add_video, session, embedder, monkeypatch
):
    _seed(add_video, embedder)
    _slow_embedder(monkeypatch, embedder, 1.0)
    searching = threading.Thread(
        target=lambda: client.get("/api/videos", params={"q": QUERY, "limit": 4})
    )
    searching.start()
    time.sleep(0.3)
    added = add_video(title=f"{QUERY} added mid search").id
    searching.join()
    assert added in _walk(client)  # the stale ranking was not kept


def test_a_failed_query_embedding_is_retried_soon(
    client, add_video, embedder, monkeypatch
):
    _seed(add_video, embedder)
    clock = [1000.0]
    cache = SearchCache(ttl=60, clock=lambda: clock[0])
    client.app.state.search_cache = cache
    monkeypatch.setattr("app.services.ai.embeddings.embed_query", lambda _t: None)
    client.get("/api/videos", params={"q": QUERY})
    monkeypatch.setattr("app.services.ai.embeddings.embed_query", embedder.embed_query)
    cache.invalidate()
    client.get("/api/videos", params={"q": QUERY})
    assert embedder.calls == [], "within the short window the failure is remembered"
    clock[0] += 6
    cache.invalidate()
    client.get("/api/videos", params={"q": QUERY})
    assert len(embedder.calls) == 1


def test_tag_enrichment_invalidates(client, add_video, session, embedder):
    from app.models import VideoAiMeta

    ids = _seed(add_video, embedder)
    _walk(client)
    cache = client.app.state.search_cache
    session.add(VideoAiMeta(video_id=ids[0], ai_tags='["bicycle"]'))
    session.commit()
    _walk(client)
    assert cache.computes == 2


def test_watch_history_sort_is_ranked_per_user(
    app, client, init_db, member_user, add_video, embedder
):
    from app.services import user_state
    from tests.conftest import _client, _session_cookie

    ids = _seed(add_video, embedder, keyword=3, semantic=0)
    with Session(init_db["engine"]) as s:
        user_state.record_progress(s, member_user.id, ids[2], 10.0)
    params = {"q": QUERY, "sort": "last_watched_at", "order": "desc"}
    admin_first = [
        v["id"] for v in client.get("/api/videos", params=params).json()["items"]
    ]
    with _client(app, cookies=_session_cookie(init_db, member_user)) as member:
        member_first = [
            v["id"] for v in member.get("/api/videos", params=params).json()["items"]
        ]
    assert sorted(admin_first) == sorted(member_first)
    assert member_first[0] == ids[2] != admin_first[0]
    assert client.app.state.search_cache.computes == 2, "one ranking per user"


def test_delete_during_a_walk_drops_only_that_video(
    client, add_video, embedder, init_db
):
    from sqlalchemy import delete

    _seed(add_video, embedder)
    first = client.get("/api/videos", params={"q": QUERY, "limit": 4}).json()
    cache = client.app.state.search_cache
    ranked = next(iter(cache._rankings.values())).value[0]
    victim = ranked[5]
    # A delete that bypasses the ORM listeners: the ranking is still served.
    with Session(init_db["engine"]) as s:
        s.execute(delete(Video).where(Video.id == victim))
        s.commit()
    second = client.get(
        "/api/videos", params={"q": QUERY, "limit": 4, "cursor": first["next_cursor"]}
    )
    assert second.status_code == 200
    assert victim not in [v["id"] for v in second.json()["items"]]

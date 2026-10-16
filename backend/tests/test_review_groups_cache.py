"""/api/review/groups clusters the library once, not once per page."""

from __future__ import annotations

from app.models import Video


def _pairs(add_video, n: int, first: int = 0) -> None:
    for k in range(first, first + n):
        for _ in range(2):
            add_video(title=f"Unique clip number {k} alpha", duration_sec=100.0)


def _walk(client) -> list[list[int]]:
    groups: list[list[int]] = []
    cursor = None
    while True:
        params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        body = client.get("/api/review/groups", params=params).json()
        groups += [[v["id"] for v in g["videos"]] for g in body["items"]]
        cursor = body["next_cursor"]
        if not cursor:
            return groups


def test_pages_share_one_clustering(client, add_video):
    _pairs(add_video, 5)
    groups = _walk(client)
    cache = client.app.state.duplicate_groups
    assert len(groups) == 5
    assert len({i for g in groups for i in g}) == 10, "no video repeated across pages"
    assert cache.computes == 1
    _walk(client)
    assert cache.computes == 1


def test_library_change_recomputes(client, add_video, session):
    _pairs(add_video, 3)
    assert len(_walk(client)) == 3
    cache = client.app.state.duplicate_groups
    assert cache.computes == 1

    _pairs(add_video, 1, first=3)  # a new pair
    assert len(_walk(client)) == 4
    assert cache.computes == 2

    video = session.get(Video, 1)  # an edit the heuristics read
    video.title = "Something else entirely"
    session.add(video)
    session.commit()
    assert len(_walk(client)) == 3
    assert cache.computes == 3

    session.delete(session.get(Video, 3))
    session.commit()
    assert len(_walk(client)) == 2
    assert cache.computes == 4


def test_cache_is_bounded(client, add_video, session):
    from app.services.duplicate_groups import MAX_ENTRIES

    for k in range(MAX_ENTRIES + 3):
        _pairs(add_video, 1, first=k)
        client.get("/api/review/groups")
    cache = client.app.state.duplicate_groups
    assert len(cache._entries) == MAX_ENTRIES

"""Cursor paging of the library and the review queue."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest


def walk(client, url: str, limit: int, **params) -> tuple[list[dict], int]:
    """Follow next_cursor to the end; returns (all items, number of pages)."""
    items: list[dict] = []
    pages = 0
    cursor = None
    while True:
        query = {**params, "limit": limit}
        if cursor:
            query["cursor"] = cursor
        resp = client.get(url, params=query)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        pages += 1
        assert len(body["items"]) <= limit
        items.extend(body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            return items, pages
        assert pages < 100, "cursor never ended"


def ids(items):
    return [row["id"] for row in items]


def test_default_page_holds_the_whole_small_library(client, add_video):
    for _ in range(3):
        add_video()
    body = client.get("/api/videos").json()
    assert len(body["items"]) == 3
    assert body["next_cursor"] is None
    assert body["total"] is None


def test_pages_cover_the_library_once_in_the_active_order(client, add_video):
    for n in range(7):
        add_video(title=f"V{n}")
    everything = client.get("/api/videos", params={"limit": 500}).json()["items"]
    paged, pages = walk(client, "/api/videos", 3)
    assert pages == 3
    assert ids(paged) == ids(everything)
    assert len(set(ids(paged))) == 7


@pytest.mark.parametrize("order", ["asc", "desc"])
@pytest.mark.parametrize(
    "sort",
    ["added_at", "title", "duration", "published_at", "file_size", "view_count"],
)
def test_every_sort_pages_like_one_big_page(client, add_video, sort, order):
    base = datetime(2024, 1, 1, tzinfo=UTC)
    for n in range(9):
        add_video(
            title=f"T{n % 3}",  # ties on the title
            duration_sec=float(100 + (n % 4) * 10),  # ties on the duration
            file_size=None if n % 4 == 0 else 1000 * (n % 3),
            view_count=None if n % 3 == 0 else n * 5,
            published_at=None if n % 5 == 0 else base + timedelta(days=n % 4),
        )
    params = {"sort": sort, "order": order}
    everything = client.get("/api/videos", params={**params, "limit": 500}).json()
    paged, _ = walk(client, "/api/videos", 2, **params)
    assert ids(paged) == ids(everything["items"])
    assert len(set(ids(paged))) == 9


def test_a_row_added_between_pages_is_not_repeated(client, add_video):
    for n in range(5):
        add_video(title=f"V{n}")
    first = client.get("/api/videos", params={"limit": 2}).json()
    add_video(title="Newest")
    rest = client.get(
        "/api/videos", params={"limit": 10, "cursor": first["next_cursor"]}
    ).json()
    assert not set(ids(first["items"])) & set(ids(rest["items"]))
    assert len(rest["items"]) == 3


def test_random_order_is_one_stable_shuffle_across_pages(client, add_video):
    for _ in range(8):
        add_video()
    one_page = client.get(
        "/api/videos", params={"sort": "random", "seed": 7, "limit": 500}
    ).json()["items"]
    paged, _ = walk(client, "/api/videos", 3, sort="random", seed=7)
    assert ids(paged) == ids(one_page)
    # Without a seed the first page picks one and the cursor keeps it.
    unseeded, _ = walk(client, "/api/videos", 3, sort="random")
    assert sorted(ids(unseeded)) == sorted(ids(one_page))


def test_watch_history_pages_by_last_watched(client, add_video, set_watch, admin_user):
    now = datetime.now(UTC)
    videos = [add_video() for _ in range(5)]
    for n, video in enumerate(videos):
        set_watch(admin_user, video, 10.0, watched_at=now - timedelta(minutes=n))
    params = {"watched_only": True, "sort": "last_watched_at", "order": "desc"}
    paged, _ = walk(client, "/api/videos", 2, **params)
    assert ids(paged) == [v.id for v in videos]


def test_search_pages_through_its_ranking(client, add_video):
    for n in range(5):
        add_video(title=f"needle {n}")
    add_video(title="other")
    everything = client.get("/api/videos", params={"q": "needle", "limit": 500})
    paged, pages = walk(client, "/api/videos", 2, q="needle")
    assert pages == 3
    assert ids(paged) == ids(everything.json()["items"])
    assert all(row["match_reason"] is not None for row in paged)


def test_total_only_on_request(client, add_video):
    for _ in range(4):
        add_video()
    assert (
        client.get("/api/videos", params={"include_total": True}).json()["total"] == 4
    )
    page = client.get("/api/videos", params={"limit": 2, "include_total": True}).json()
    assert page["total"] == 4
    assert len(page["items"]) == 2
    searched = client.get("/api/videos", params={"q": "Video", "include_total": True})
    assert searched.json()["total"] == 4


def test_continue_watching_is_never_cut_short(client, add_video, set_watch, admin_user):
    for _ in range(3):
        set_watch(admin_user, add_video(duration_sec=1000.0), 100.0)
    body = client.get("/api/videos", params={"continue_watching": True, "limit": 1})
    assert len(body.json()["items"]) == 3
    assert body.json()["next_cursor"] is None


def test_review_queue_pages(client, add_video):
    for n in range(5):
        add_video(needs_review=True, title=f"R{n}")
    add_video()
    paged, pages = walk(client, "/api/review", 2)
    assert pages == 3
    assert len(set(ids(paged))) == 5
    assert (
        client.get("/api/review", params={"include_total": True}).json()["total"] == 5
    )


def test_bad_cursors_and_limits_are_rejected(client, add_video):
    add_video()
    add_video()
    bad = client.get("/api/videos", params={"cursor": "not-a-cursor"})
    assert bad.status_code == 400
    assert bad.json()["code"] == "bad_request"
    first = client.get("/api/videos", params={"limit": 1}).json()
    other_sort = client.get(
        "/api/videos",
        params={"cursor": first["next_cursor"], "sort": "title", "limit": 1},
    )
    assert other_sort.status_code == 400
    assert client.get("/api/videos", params={"limit": 0}).status_code == 422
    assert client.get("/api/videos", params={"limit": 501}).status_code == 422

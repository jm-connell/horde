"""Cursor paging of the library and the review queue."""

from __future__ import annotations

import base64
import json
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


def _forged(**payload) -> str:
    from app.services.pagination import _pack

    return _pack(payload)


FORGED_KEYSET = [
    # value of the wrong type for the sort column
    ("added_at", {"v": [1, 2]}),
    ("added_at", {"v": {"x": 1}}),
    ("added_at", {"v": "yesterday"}),
    ("added_at", {"v": True}),
    ("added_at", {"v": 1.5}),
    ("added_at", {"v": {"dt": "not a date"}}),
    ("added_at", {"v": {"dt": 5}}),
    ("published_at", {"v": "2024-01-01"}),
    # a timestamp without a timezone
    ("added_at", {"v": {"dt": "2024-01-01T00:00:00"}}),
    ("published_at", {"v": {"dt": "2024-01-01T00:00:00"}}),
    ("last_watched_at", {"v": {"dt": "2024-01-01T00:00:00"}}),
    ("duration", {"v": "long"}),
    ("duration", {"v": True}),
    ("duration", {"v": [1]}),
    ("duration", {"v": 1e30}),
    ("duration", {"v": 10**30}),
    ("file_size", {"v": float("nan")}),
    ("view_count", {"v": {"dt": "2024-01-01T00:00:00"}}),
    ("title", {"v": 5}),
    ("title", {"v": ["a"]}),
    ("random", {"v": None}),
    ("random", {"v": "x"}),
    # bad id or seed
    ("added_at", {"v": None, "i": "7"}),
    ("added_at", {"v": None, "i": True}),
    ("added_at", {"v": None, "i": 2**70}),
    ("added_at", {"v": None, "i": None}),
    ("random", {"v": 5, "r": -1}),
    ("random", {"v": 5, "r": 2**40}),
    ("random", {"v": 5, "r": "x"}),
]


# The review queue only sorts by added_at, so only those forgeries reach it.
FORGED_FOR_ENDPOINT = [("/api/videos", sort, p) for sort, p in FORGED_KEYSET] + [
    ("/api/review", sort, p) for sort, p in FORGED_KEYSET if sort == "added_at"
]


@pytest.mark.parametrize(("url", "sort", "payload"), FORGED_FOR_ENDPOINT)
def test_forged_keyset_cursors_are_a_400(client, add_video, url, sort, payload):
    add_video()
    body = {"t": "k", "s": sort, "o": "desc", "i": 1, **payload}
    token = (
        base64.urlsafe_b64encode(json.dumps(body, allow_nan=True).encode())
        .decode()
        .rstrip("=")
    )
    params = {"cursor": token}
    if url == "/api/videos":
        params["sort"] = sort
    resp = client.get(url, params=params)
    assert resp.status_code == 400, resp.text
    assert resp.json()["code"] == "bad_request"


@pytest.mark.parametrize(
    "payload",
    [
        {"n": -1},
        {"n": "3"},
        {"n": True},
        {"n": 10**12},
        {"n": 1e30},
        {"n": 2, "r": -5},
        {"n": 2, "r": 2**50},
    ],
)
def test_forged_offset_cursors_are_a_400(client, add_video, payload):
    add_video()
    token = _forged(t="o", s="added_at", o="desc", **payload)
    # Offset cursors belong to search; the plain listing refuses them anyway.
    assert client.get("/api/videos", params={"cursor": token}).status_code == 400
    assert (
        client.get("/api/videos", params={"cursor": token, "q": "Video"}).status_code
        == 400
    )


def test_a_cursor_of_the_wrong_kind_is_a_400(client, add_video):
    for n in range(3):
        add_video(title=f"needle {n}")
    plain = client.get("/api/videos", params={"limit": 1}).json()["next_cursor"]
    searched = client.get("/api/videos", params={"limit": 1, "q": "needle"}).json()[
        "next_cursor"
    ]
    # keyset cursor into search
    assert (
        client.get("/api/videos", params={"cursor": plain, "q": "needle"}).status_code
        == 400
    )
    # offset cursor into a keyset listing
    assert client.get("/api/videos", params={"cursor": searched}).status_code == 400
    # and into the review queue
    assert client.get("/api/review", params={"cursor": searched}).status_code == 400
    assert client.get("/api/review/groups", params={"cursor": plain}).status_code == 400


def test_random_order_survives_inserts_and_deletes_between_pages(
    client, add_video, session
):
    from app.models import Video

    originals = [add_video().id for _ in range(30)]
    first = client.get(
        "/api/videos", params={"sort": "random", "seed": 11, "limit": 10}
    ).json()
    seen = ids(first["items"])
    # Change the library mid-walk: new videos and a deleted one.
    added = [add_video().id for _ in range(5)]
    doomed = next(i for i in originals if i not in seen)
    session.delete(session.get(Video, doomed))
    session.commit()
    cursor = first["next_cursor"]
    while cursor:
        page = client.get(
            "/api/videos",
            params={"sort": "random", "limit": 10, "cursor": cursor},
        ).json()
        seen += ids(page["items"])
        cursor = page["next_cursor"]
    assert len(seen) == len(set(seen)), "a video was served twice"
    survivors = {i for i in originals if i != doomed}
    assert survivors <= set(seen), "an untouched video was skipped"
    assert doomed not in seen[10:]
    # Videos added mid-walk may or may not land after the cursor, never twice.
    assert set(seen) <= survivors | set(added)

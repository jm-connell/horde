"""index_catalog: the flat listing pass, its totals and completeness."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from typing import Any

import pytest

from app.models import ChannelCatalog, ChannelCatalogStatus
from app.services.channel_catalog import index as idx

URL = "https://www.youtube.com/@alpha"


def _entries(n: int) -> list[dict[str, Any]]:
    return [
        {
            "id": f"v{i:010d}",
            "url": f"https://www.youtube.com/watch?v=v{i:010d}",
            "title": f"Video {i}",
        }
        for i in range(n)
    ]


def _catalog(session, **kwargs: Any) -> ChannelCatalog:
    catalog = ChannelCatalog(
        channel_url=URL,
        channel_name="Alpha",
        status=ChannelCatalogStatus.queued,
        **kwargs,
    )
    session.add(catalog)
    session.commit()
    session.refresh(catalog)
    return catalog


@pytest.fixture
def channel(monkeypatch):
    """A channel with ``uploads`` videos, served a page at a time."""
    state: dict[str, Any] = {"uploads": []}

    def fake_page(_url: str, offset: int = 0, limit: int = 50) -> dict[str, Any]:
        page = state["uploads"][offset : offset + limit]
        return {
            "channel": "Alpha",
            "entries": page,
            "fetched": len(page),
            "has_more": len(page) == limit,
            "playlist_count": None,  # yt-dlp reports none for a paged listing
        }

    monkeypatch.setattr(
        idx,
        "_flat_pages",
        lambda url: nullcontext(lambda offset, limit: fake_page(url, offset, limit)),
    )
    monkeypatch.setattr(idx, "_run_description_pass", lambda *_a, **_k: None)
    monkeypatch.setattr(idx, "_enqueue_catalog_embeds", lambda *_a, **_k: None)
    monkeypatch.setattr(idx, "after_catalog_update", lambda *_a, **_k: None)
    monkeypatch.setattr(idx, "_max_videos", lambda: 100)
    monkeypatch.setattr(idx.time, "sleep", lambda _s: None)
    return state


def test_listing_end_replaces_a_stale_total(session, channel):
    # An earlier run stopped after 33 videos; the channel has 60.
    catalog = _catalog(session, channel_total=33, indexed_count=33, complete=True)
    channel["uploads"] = _entries(60)

    idx.index_catalog(catalog.id)
    session.refresh(catalog)

    assert catalog.indexed_count == 60
    assert catalog.channel_total == 60
    assert catalog.complete is True


def test_cap_reached_is_not_complete_even_with_a_stale_total(session, channel):
    # Prod: Linus Tech Tips had channel_total 33 and 1000 indexed, so the cap
    # looked like the whole channel.
    catalog = _catalog(session, channel_total=33, indexed_count=33, complete=True)
    channel["uploads"] = _entries(250)

    idx.index_catalog(catalog.id)
    session.refresh(catalog)

    assert catalog.indexed_count == 100
    assert catalog.channel_total is None
    assert catalog.complete is False
    assert catalog.status == ChannelCatalogStatus.ready


@pytest.fixture
def listing(monkeypatch):
    """A fake streamed listing that counts how often it is opened."""
    state: dict[str, Any] = {"uploads": [], "opens": 0, "fail_at": None}

    @contextmanager
    def fake_open(_url: str, *, tab: str = "videos") -> Iterator[dict[str, Any]]:
        state["opens"] += 1

        def entries() -> Iterator[dict[str, Any]]:
            for i, entry in enumerate(state["uploads"]):
                if i == state["fail_at"]:
                    state["fail_at"] = None
                    raise RuntimeError("Login required / age-restricted")
                yield entry

        yield {"channel": "Alpha", "playlist_count": None, "entries": entries()}

    monkeypatch.setattr("app.services.ytdlp_extract.open_channel_listing", fake_open)
    return state


def test_pages_in_order_come_from_one_listing(listing):
    listing["uploads"] = _entries(120)
    with idx._flat_pages(URL) as fetch:
        pages = [fetch(0, 50), fetch(50, 50), fetch(100, 50)]
    assert listing["opens"] == 1
    assert [p["fetched"] for p in pages] == [50, 50, 20]
    assert [p["has_more"] for p in pages] == [True, True, False]
    assert pages[2]["entries"][0]["id"] == "v0000000100"


def test_a_page_after_a_failed_one_reopens_at_its_offset(listing):
    listing["uploads"] = _entries(120)
    listing["fail_at"] = 10
    with idx._flat_pages(URL) as fetch:
        with pytest.raises(RuntimeError):
            fetch(0, 50)
        page = fetch(50, 50)
    assert listing["opens"] == 2
    assert page["entries"][0]["id"] == "v0000000050"


def test_listing_skips_entries_the_feed_drops(listing):
    # open_channel_listing yields None for shorts and the like: they count
    # towards the page size but are not indexed.
    listing["uploads"] = [None, *_entries(2)]
    with idx._flat_pages(URL) as fetch:
        page = fetch(0, 50)
    assert page["fetched"] == 3
    assert [e["id"] for e in page["entries"]] == ["v0000000000", "v0000000001"]


def test_an_empty_description_is_fetched_once(session, monkeypatch):
    from app.models import ChannelCatalogVideo

    catalog = _catalog(session)
    row = ChannelCatalogVideo(
        catalog_id=catalog.id,
        yt_id="v0000000000",
        url="https://www.youtube.com/watch?v=v0000000000",
        title="No words",
        position=0,
    )
    session.add(row)
    session.commit()
    calls: list[str] = []

    def fake_extract(url: str, opts: dict, **_kwargs: Any) -> dict[str, Any]:
        calls.append(url)
        return {"id": "v0000000000", "description": ""}

    monkeypatch.setattr(idx, "extract_info_gated", fake_extract)

    idx._run_description_pass(session, catalog)
    idx._run_description_pass(session, catalog)

    session.refresh(row)
    assert row.description == ""
    assert len(calls) == 1


def test_giving_up_on_failing_pages_leaves_the_total_unknown(session, monkeypatch):
    catalog = _catalog(session)

    def fake_page(_url: str, offset: int = 0, limit: int = 50) -> dict[str, Any]:
        if offset == 0:
            return {
                "channel": "Alpha",
                "entries": _entries(50),
                "fetched": 50,
                "has_more": True,
                "playlist_count": None,
            }
        raise RuntimeError("Login required / age-restricted")

    monkeypatch.setattr(
        idx,
        "_flat_pages",
        lambda url: nullcontext(lambda offset, limit: fake_page(url, offset, limit)),
    )
    monkeypatch.setattr(idx, "_run_description_pass", lambda *_a, **_k: None)
    monkeypatch.setattr(idx, "_enqueue_catalog_embeds", lambda *_a, **_k: None)
    monkeypatch.setattr(idx, "after_catalog_update", lambda *_a, **_k: None)
    monkeypatch.setattr(idx.time, "sleep", lambda _s: None)

    idx.index_catalog(catalog.id)
    session.refresh(catalog)

    assert catalog.status == ChannelCatalogStatus.ready
    assert catalog.indexed_count == 50
    assert catalog.channel_total is None
    assert catalog.complete is False


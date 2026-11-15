"""index_catalog: the flat listing pass, its totals and completeness."""

from __future__ import annotations

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
    """A channel with ``uploads`` videos; pages come from ``_fetch_flat_page``."""
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

    monkeypatch.setattr(idx, "_fetch_flat_page", fake_page)
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

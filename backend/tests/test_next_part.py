"""GET /api/videos/{id}/next-part: the channel's next upload when it is a series."""

from __future__ import annotations

from datetime import UTC, datetime

from app.models import ChannelCatalog, ChannelCatalogVideo
from app.services import stream_related


def _catalog(session, name, titles):
    """Index a channel; ``titles`` oldest first (position 0 is the newest)."""
    catalog = ChannelCatalog(
        channel_url=f"https://www.youtube.com/@{name}", channel_name=name
    )
    session.add(catalog)
    session.commit()
    session.refresh(catalog)
    ids = []
    for i, title in enumerate(titles):
        yt_id = f"{name[:4].lower()}{i:07d}"
        session.add(
            ChannelCatalogVideo(
                catalog_id=catalog.id,
                yt_id=yt_id,
                url=f"https://www.youtube.com/watch?v={yt_id}",
                title=title,
                duration=3600,
                position=len(titles) - 1 - i,
            )
        )
        ids.append(yt_id)
    session.commit()
    return ids


def test_the_next_uploaded_part_is_returned_even_when_not_downloaded(
    client, session, add_video
):
    ids = _catalog(
        session,
        "Streamer",
        ["Cooking Stream", "GTA RP Day 12", "Q&A with chat", "GTA RP Day 13"],
    )
    watched = add_video(title="GTA RP Day 12", channel="Streamer", yt_id=ids[1])

    res = client.get(f"/api/videos/{watched.id}/next-part")
    assert res.status_code == 200
    body = res.json()
    # "Q&A with chat" sits between them; the numbered next part is found past it.
    assert body["entry"]["title"] == "GTA RP Day 13"
    assert body["entry"]["url"].endswith(ids[3])
    assert body["entry"]["in_library"] is False
    assert "13" in body["reason"]


def test_only_a_numbered_part_is_found_past_other_uploads(client, session, add_video):
    ids = _catalog(
        session,
        "Tagger",
        ["Road Trip | Utah", "Studio Tour", "Road Trip | Nevada"],
    )
    watched = add_video(title="Road Trip | Utah", channel="Tagger", yt_id=ids[0])
    # A shared tag only counts for the very next upload.
    assert client.get(f"/api/videos/{watched.id}/next-part").json()["entry"] is None


CITIES = [
    "I Created A City Full Of Intersections | Cities: Skylines #2",
    "Reacting to Your Builds",
    "Q&A Livestream Highlights",
    "The Biggest Roundabout of All Time | Cities Skylines #3",
    "Cities Skylines #4 - Metro",
]


def test_a_stream_gets_its_next_part_from_the_index(client, session):
    ids = _catalog(session, "Planner", CITIES)
    res = client.get(
        "/api/preview/next-part",
        params={"url": f"https://www.youtube.com/watch?v={ids[0]}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["entry"]["title"] == CITIES[3]
    assert body["entry"]["id"] == ids[3]
    assert body["entry"]["channel"] == "Planner"
    assert "3" in body["reason"]


def test_a_stream_off_the_index_has_no_next_part(client):
    res = client.get(
        "/api/preview/next-part",
        params={"url": "https://www.youtube.com/watch?v=zzzzzzzzzzz"},
    )
    assert res.json() == {"entry": None, "reason": None}
    res = client.get("/api/preview/next-part", params={"url": "https://example.com/x"})
    assert res.json()["entry"] is None


def test_the_next_part_leads_a_streams_related_videos(session):
    ids = _catalog(session, "Planner", CITIES)
    items = stream_related.related_for_stream(
        session,
        ids[0],
        {"channel_url": "https://www.youtube.com/@Planner"},
        may_embed=False,
    )
    assert items[0].title == CITIES[3]
    assert {i.title for i in items[1:]} >= {CITIES[1], CITIES[4]}


def test_a_downloaded_next_part_leads_a_videos_related_videos(client, add_video):
    first = add_video(
        title=CITIES[0],
        channel="Planner",
        published_at=datetime(2022, 1, 1, tzinfo=UTC),
    )
    third = add_video(
        title=CITIES[3],
        channel="Planner",
        published_at=datetime(2022, 1, 9, tzinfo=UTC),
    )
    # Downloaded last, so the channel fill alone would list it first.
    add_video(
        title=CITIES[1],
        channel="Planner",
        published_at=datetime(2022, 1, 5, tzinfo=UTC),
    )
    related = client.get(f"/api/videos/{first.id}/related").json()
    assert related[0]["id"] == third.id


def test_a_downloaded_next_part_points_at_the_library(client, session, add_video):
    ids = _catalog(session, "Builder", ["Cabin Build Part 3", "Cabin Build Part 4"])
    watched = add_video(title="Cabin Build Part 3", channel="Builder", yt_id=ids[0])
    nxt = add_video(title="Cabin Build Part 4", channel="Builder", yt_id=ids[1])
    body = client.get(f"/api/videos/{watched.id}/next-part").json()
    assert body["entry"]["video_id"] == nxt.id
    assert body["entry"]["in_library"] is True


def test_a_channel_format_tag_is_not_a_series(client, session, add_video):
    titles = [
        "Karen Flees Traffic Stop | Reacts Weekly",
        "Drunk Driver in a Parking Lot | Reacts Weekly",
        "Alpha Male Has a Rough Time | Reacts Weekly",
        "Dead Body Found at a Stop | Reacts Weekly",
    ]
    ids = _catalog(session, "Reactor", titles)
    watched = add_video(title=titles[1], channel="Reactor", yt_id=ids[1])
    assert client.get(f"/api/videos/{watched.id}/next-part").json()["entry"] is None


def test_without_an_index_the_library_order_is_used(client, add_video):
    first = add_video(
        title="Road Trip Day 1",
        channel="Traveller",
        published_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    second = add_video(
        title="Road Trip Day 2",
        channel="Traveller",
        published_at=datetime(2026, 1, 2, tzinfo=UTC),
    )
    body = client.get(f"/api/videos/{first.id}/next-part").json()
    assert body["entry"]["video_id"] == second.id
    assert client.get(f"/api/videos/{second.id}/next-part").json()["entry"] is None


def test_unknown_video_is_404(client):
    assert client.get("/api/videos/999999/next-part").status_code == 404

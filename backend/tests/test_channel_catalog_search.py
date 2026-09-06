"""Channel catalog keyword search: multi-term AND and semantic scoping."""

from sqlmodel import Session, select

from app.models import (
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
)
from app.services.ai.embeddings import pack_vector
from app.services.channel_catalog.query import (
    search_all_catalogs,
    search_catalog,
    update_catalog_video_fields,
)


LTT = "https://youtube.com/@linustechtips"
OTHER = "https://youtube.com/@otherchannel"
LINUS_TITLE = "I painted his House to Fix his WiFi"


def _add_catalog(session: Session, *, url: str, name: str) -> ChannelCatalog:
    catalog = ChannelCatalog(
        channel_url=url,
        channel_name=name,
        status=ChannelCatalogStatus.ready,
        indexed_count=0,
        complete=True,
    )
    session.add(catalog)
    session.commit()
    session.refresh(catalog)
    return catalog


def _add_video(
    session: Session,
    catalog: ChannelCatalog,
    *,
    yt_id: str,
    title: str,
    position: int,
    description: str | None = None,
) -> ChannelCatalogVideo:
    row = ChannelCatalogVideo(
        catalog_id=catalog.id,
        yt_id=yt_id,
        url=f"https://www.youtube.com/watch?v={yt_id}",
        title=title,
        description=description,
        position=position,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    catalog.indexed_count = (catalog.indexed_count or 0) + 1
    session.add(catalog)
    session.commit()
    return row


def _titles(rows: list[dict]) -> set[str]:
    return {str(r.get("title") or "") for r in rows}


def test_paint_and_paint_fix_match_linus_title(session):
    catalog = _add_catalog(session, url=LTT, name="Linus Tech Tips")
    _add_video(session, catalog, yt_id="paintfix11", title=LINUS_TITLE, position=0)
    _add_video(
        session,
        catalog,
        yt_id="paintonly11",
        title="I painted a giant mural",
        position=1,
    )
    _add_video(
        session,
        catalog,
        yt_id="fixonly111",
        title="How to fix a broken router",
        position=2,
    )

    paint = search_catalog(session, LTT, "paint", semantic=False)
    assert LINUS_TITLE in _titles(paint)
    assert "I painted a giant mural" in _titles(paint)

    paint_fix = search_catalog(session, LTT, "paint fix", semantic=False)
    assert _titles(paint_fix) == {LINUS_TITLE}

    painted_house = search_catalog(
        session, LTT, "painted house wifi", semantic=False
    )
    assert _titles(painted_house) == {LINUS_TITLE}

    one_term_only = search_catalog(session, LTT, "paint router", semantic=False)
    assert LINUS_TITLE not in _titles(one_term_only)
    assert _titles(one_term_only) == set()


def test_car_does_not_match_card_or_carriers(session):
    catalog = _add_catalog(session, url=LTT, name="Linus Tech Tips")
    _add_video(
        session, catalog, yt_id="usedcar1111", title="I bought a cheap used car", position=0
    )
    _add_video(
        session,
        catalog,
        yt_id="gpucard1111",
        title="The RTX 4090 graphics card",
        position=1,
    )
    _add_video(
        session,
        catalog,
        yt_id="carrier1111",
        title="Upgrade your home WiFi",
        position=2,
        description="Switch carriers and save on your phone plan.",
    )
    hits = search_catalog(session, LTT, "car", semantic=False)
    assert _titles(hits) == {"I bought a cheap used car"}


def test_match_reason_title_and_description(session):
    catalog = _add_catalog(session, url=LTT, name="Linus Tech Tips")
    _add_video(session, catalog, yt_id="paintfix11", title=LINUS_TITLE, position=0)
    _add_video(
        session,
        catalog,
        yt_id="firetruck11",
        title="We built the ultimate gaming fire truck",
        position=1,
        description="We installed a wifi hotspot in the cab.",
    )
    paint = search_catalog(session, LTT, "paint", semantic=False)
    linus = next(r for r in paint if r["title"] == LINUS_TITLE)
    assert linus["match_reason"]["source"] == "title"

    wifi = search_catalog(session, LTT, "wifi", semantic=False)
    truck = next(r for r in wifi if "fire truck" in (r["title"] or "").lower())
    assert truck["match_reason"]["source"] == "description"
    assert "wifi" in (truck["match_reason"].get("snippet") or "").lower()


def test_search_all_catalogs_uses_token_and(session):
    catalog = _add_catalog(session, url=LTT, name="Linus Tech Tips")
    _add_video(session, catalog, yt_id="paintfix11", title=LINUS_TITLE, position=0)
    _add_video(
        session, catalog, yt_id="paintonly11", title="Just paint", position=1
    )
    hits = search_all_catalogs(session, "paint fix", semantic=False)
    assert _titles(hits) == {LINUS_TITLE}


def test_semantic_false_does_not_embed(session, monkeypatch):
    catalog = _add_catalog(session, url=LTT, name="Linus Tech Tips")
    _add_video(session, catalog, yt_id="paintfix11", title=LINUS_TITLE, position=0)
    calls = {"n": 0}

    def fake_embed(query: str):
        calls["n"] += 1
        return [1.0, 0.0]

    monkeypatch.setattr(
        "app.services.ai.embeddings.embed_query", fake_embed
    )
    search_catalog(session, LTT, "wifi", semantic=False)
    assert calls["n"] == 0


def test_short_query_skips_semantic_even_when_enabled(session, monkeypatch):
    catalog = _add_catalog(session, url=LTT, name="Linus Tech Tips")
    _add_video(session, catalog, yt_id="usedcar1111", title="I bought a cheap used car", position=0)
    calls = {"n": 0}

    def fake_embed(query: str):
        calls["n"] += 1
        return [1.0, 0.0]

    monkeypatch.setattr(
        "app.services.ai.embeddings.embed_query", fake_embed
    )
    search_catalog(session, LTT, "car", semantic=True)
    assert calls["n"] == 0
    search_catalog(session, LTT, "hyprland", semantic=True)
    assert calls["n"] == 0
    search_catalog(session, LTT, "hyprland install guide", semantic=True)
    assert calls["n"] == 0


def test_semantic_hits_are_scoped_to_catalog(session, monkeypatch):
    ltt = _add_catalog(session, url=LTT, name="Linus Tech Tips")
    other = _add_catalog(session, url=OTHER, name="Other")
    target = _add_video(
        session,
        ltt,
        yt_id="semltt11111",
        title="Unrelated LTT title",
        position=0,
    )
    outsider = _add_video(
        session,
        other,
        yt_id="semother111",
        title="Unrelated other title",
        position=0,
    )
    session.add(
        ChannelCatalogEmbedding(
            catalog_video_id=target.id,
            model="test",
            dim=2,
            vector=pack_vector([1.0, 0.0]),
            content_hash="a",
        )
    )
    session.add(
        ChannelCatalogEmbedding(
            catalog_video_id=outsider.id,
            model="test",
            dim=2,
            vector=pack_vector([1.0, 0.0]),
            content_hash="b",
        )
    )
    session.commit()

    monkeypatch.setattr(
        "app.services.ai.embeddings.embed_query",
        lambda query: [1.0, 0.0],
    )
    hits = search_catalog(
        session, LTT, "that episode about house wifi", semantic=True
    )
    ids = {r["id"] for r in hits}
    assert "semltt11111" in ids
    assert "semother111" not in ids
    reason = next(r["match_reason"] for r in hits if r["id"] == "semltt11111")
    assert reason["source"] == "related"


def test_update_catalog_video_fields_fills_dates_without_insert(session):
    catalog = _add_catalog(session, url=LTT, name="Linus Tech Tips")
    row = _add_video(session, catalog, yt_id="paintfix11", title=LINUS_TITLE, position=0)
    assert row.published_at is None

    update_catalog_video_fields(
        LTT,
        [
            {
                "id": "paintfix11",
                "published_at": "20240901",
                "view_count": 123,
            },
            {
                "id": "notindexed1",
                "published_at": "20140101",
                "view_count": 9,
            },
        ],
    )
    session.refresh(row)
    assert row.published_at.startswith("2024-09-01")
    assert row.view_count == 123
    leftover = session.exec(
        select(ChannelCatalogVideo).where(ChannelCatalogVideo.yt_id == "notindexed1")
    ).all()
    assert leftover == []

    update_catalog_video_fields(
        LTT,
        [{"id": "paintfix11", "published_at": "20140101", "view_count": 50}],
    )
    session.refresh(row)
    assert row.published_at.startswith("2024-09-01")
    assert row.view_count == 50


def test_update_catalog_video_fields_skips_approximate_dates(session):
    catalog = _add_catalog(session, url=LTT, name="Linus Tech Tips")
    row = _add_video(session, catalog, yt_id="oldpaint111", title=LINUS_TITLE, position=0)
    assert row.published_at is None

    update_catalog_video_fields(
        LTT,
        [
            {
                "id": "oldpaint111",
                "published_at": "2014-01-01T00:00:00+00:00",
                "published_label": "12 years ago",
                "view_count": 100,
            }
        ],
    )
    session.refresh(row)
    assert row.published_at is None
    assert row.view_count == 100

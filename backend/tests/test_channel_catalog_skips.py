"""Age-restricted / gated catalog videos are skipped without aborting the index."""

from sqlmodel import select

from app.models import (
    ChannelCatalog,
    ChannelCatalogSkip,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
)
from app.services.channel_catalog.index import (
    _run_description_pass,
    _upsert_flat_entries,
    index_catalog,
)
from app.services.channel_catalog.skips import skipped_yt_ids


def _catalog(session, *, name: str = "karrigan") -> ChannelCatalog:
    catalog = ChannelCatalog(
        channel_url=f"https://www.youtube.com/@{name}",
        channel_name=name,
        status=ChannelCatalogStatus.indexing,
        max_videos=1000,
        indexed_count=0,
    )
    session.add(catalog)
    session.commit()
    session.refresh(catalog)
    return catalog


def _video(
    session,
    catalog: ChannelCatalog,
    *,
    yt_id: str,
    title: str,
    position: int,
) -> ChannelCatalogVideo:
    row = ChannelCatalogVideo(
        catalog_id=catalog.id,
        yt_id=yt_id,
        url=f"https://www.youtube.com/watch?v={yt_id}",
        title=title,
        position=position,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def test_upsert_skips_age_restricted_and_keeps_public(session):
    catalog = _catalog(session)
    pos, inserted = _upsert_flat_entries(
        session,
        catalog,
        [
            {
                "id": "pub11111111",
                "url": "https://www.youtube.com/watch?v=pub11111111",
                "title": "Public match",
            },
            {
                "id": "age11111111",
                "url": "https://www.youtube.com/watch?v=age11111111",
                "title": "Gated clip",
                "availability": "age_restricted",
            },
        ],
        0,
    )
    assert inserted == ["pub11111111"]
    assert pos == 1
    session.refresh(catalog)
    assert skipped_yt_ids(session, catalog.id) == {"age11111111"}
    assert catalog.last_error
    assert "Age-restricted / private" in catalog.last_error
    assert "continued indexing" in catalog.last_error
    titles = session.exec(
        select(ChannelCatalogVideo.title).where(
            ChannelCatalogVideo.catalog_id == catalog.id
        )
    ).all()
    assert titles == ["Public match"]


def test_upsert_keeps_age_restricted_when_allow_gated(session):
    catalog = _catalog(session)
    pos, inserted = _upsert_flat_entries(
        session,
        catalog,
        [
            {
                "id": "pub11111111",
                "url": "https://www.youtube.com/watch?v=pub11111111",
                "title": "Public match",
            },
            {
                "id": "age11111111",
                "url": "https://www.youtube.com/watch?v=age11111111",
                "title": "Gated clip",
                "availability": "age_restricted",
            },
        ],
        0,
        allow_gated=True,
    )
    assert inserted == ["pub11111111", "age11111111"]
    assert pos == 2
    assert skipped_yt_ids(session, catalog.id) == set()


def test_description_pass_keeps_unlocked_age_restricted(session, monkeypatch):
    catalog = _catalog(session)
    gated = _video(
        session, catalog, yt_id="age11111111", title="Gated clip", position=0
    )

    def fake_extract(url, opts, **_kwargs):
        assert "cookiefile" not in opts
        assert "cookiesfrombrowser" not in opts
        return {
            "id": gated.yt_id,
            "description": "unlocked with cookies at extract layer",
            "availability": "age_restricted",
        }

    monkeypatch.setattr(
        "app.services.channel_catalog.index.extract_info_gated", fake_extract
    )

    _run_description_pass(session, catalog)
    row = session.exec(
        select(ChannelCatalogVideo).where(ChannelCatalogVideo.yt_id == gated.yt_id)
    ).first()
    assert row is not None
    assert row.description == "unlocked with cookies at extract layer"
    assert session.exec(select(ChannelCatalogSkip)).first() is None


def test_description_pass_skips_cookies_error_and_continues(session, monkeypatch):
    catalog = _catalog(session)
    gated = _video(
        session, catalog, yt_id="age11111111", title="Gated clip", position=0
    )
    _video(
        session, catalog, yt_id="ok111111111", title="Public match", position=1
    )

    def fake_extract(url, opts, **_kwargs):
        if gated.yt_id in url:
            raise RuntimeError("Login required / age-restricted")
        return {"description": "hello from the public video", "id": "ok111111111"}

    monkeypatch.setattr(
        "app.services.channel_catalog.index.extract_info_gated", fake_extract
    )

    _run_description_pass(session, catalog)
    session.refresh(catalog)

    remaining = {
        row.yt_id
        for row in session.exec(
            select(ChannelCatalogVideo).where(
                ChannelCatalogVideo.catalog_id == catalog.id
            )
        ).all()
    }
    assert remaining == {"ok111111111"}
    skip = session.exec(select(ChannelCatalogSkip)).first()
    assert skip is not None
    assert skip.yt_id == "age11111111"
    assert skip.reason == "cookies"
    assert catalog.last_error
    assert "continued indexing" in catalog.last_error
    public = session.exec(
        select(ChannelCatalogVideo).where(ChannelCatalogVideo.yt_id == "ok111111111")
    ).first()
    assert public is not None
    assert public.description == "hello from the public video"


def test_index_catalog_continues_after_age_restricted_page(session, monkeypatch):
    from app.services.channel_catalog import index as idx

    catalog = _catalog(session)

    def fake_page(_url, offset=0, limit=50):
        if offset == 0:
            raise RuntimeError("Login required / age-restricted")
        return {
            "entries": [
                {
                    "id": "ok111111111",
                    "url": "https://www.youtube.com/watch?v=ok111111111",
                    "title": "Public match",
                }
            ],
            "has_more": False,
            "channel": "karrigan",
            "playlist_count": 12,
        }

    monkeypatch.setattr(idx, "_fetch_flat_page", fake_page)
    monkeypatch.setattr(idx, "_run_description_pass", lambda *_a, **_k: None)
    monkeypatch.setattr(idx, "_enqueue_catalog_embeds", lambda *_a, **_k: None)
    monkeypatch.setattr(idx, "after_catalog_update", lambda *_a, **_k: None)

    index_catalog(catalog.id)
    session.refresh(catalog)

    assert catalog.status == ChannelCatalogStatus.ready
    assert catalog.last_error
    assert "continued indexing" in catalog.last_error
    videos = session.exec(
        select(ChannelCatalogVideo).where(
            ChannelCatalogVideo.catalog_id == catalog.id
        )
    ).all()
    assert [row.yt_id for row in videos] == ["ok111111111"]


def test_index_catalog_still_fails_on_bot_check(session, monkeypatch):
    from app.services.channel_catalog import index as idx

    catalog = _catalog(session)
    monkeypatch.setattr(
        idx,
        "_fetch_flat_page",
        lambda *_a, **_k: (_ for _ in ()).throw(
            RuntimeError("Sign in to confirm you’re not a bot")
        ),
    )
    monkeypatch.setattr(idx, "_run_description_pass", lambda *_a, **_k: None)
    monkeypatch.setattr(idx, "_enqueue_catalog_embeds", lambda *_a, **_k: None)

    index_catalog(catalog.id)
    session.refresh(catalog)
    assert catalog.status == ChannelCatalogStatus.error
    assert catalog.last_error
    assert "bot" in catalog.last_error.lower()


def test_fetch_channel_feed_ignores_per_video_errors(monkeypatch):
    import sys
    import types

    captured: dict = {}

    class DummyYDL:
        def __init__(self, opts):
            captured.update(opts)

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def extract_info(self, _url, download=False):
            return {
                "entries": [
                    None,
                    {
                        "id": "ok111111111",
                        "url": "https://www.youtube.com/watch?v=ok111111111",
                        "title": "Public match",
                    },
                ],
                "uploader": "karrigan",
            }

    monkeypatch.setitem(
        sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=DummyYDL)
    )
    from app.services.ytdlp_extract import fetch_channel_feed
    import app.services.ytdlp_extract as extract

    extract._feed_cache.clear()
    result = fetch_channel_feed(
        "https://www.youtube.com/@karrigan", offset=0, limit=2
    )
    assert captured.get("ignoreerrors") is True
    assert "cookiefile" not in captured
    assert "cookiesfrombrowser" not in captured
    assert result["fetched"] == 2
    assert result["has_more"] is True
    assert [e["id"] for e in result["entries"]] == ["ok111111111"]

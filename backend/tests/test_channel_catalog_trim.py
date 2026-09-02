"""Reindex trim must drop overflow catalog rows without a NameError."""

from sqlmodel import select

from app.models import (
    AiJob,
    AiJobKind,
    AiJobStatus,
    ChannelCatalog,
    ChannelCatalogEmbedding,
    ChannelCatalogSkip,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
)
from app.services.channel_catalog.index import _trim_beyond_cap


def _catalog(session, *, max_videos: int = 2) -> ChannelCatalog:
    catalog = ChannelCatalog(
        channel_url="https://www.youtube.com/@level1techs",
        channel_name="Level1Techs",
        status=ChannelCatalogStatus.ready,
        max_videos=max_videos,
        indexed_count=4,
    )
    session.add(catalog)
    session.commit()
    session.refresh(catalog)
    return catalog


def _video(session, catalog_id: int, *, yt_id: str, position: int) -> ChannelCatalogVideo:
    row = ChannelCatalogVideo(
        catalog_id=catalog_id,
        yt_id=yt_id,
        url=f"https://www.youtube.com/watch?v={yt_id}",
        title=f"Video {yt_id}",
        position=position,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def test_trim_beyond_cap_drops_overflow_and_dependents(session):
    catalog = _catalog(session, max_videos=2)
    keep_a = _video(session, catalog.id, yt_id="keepA", position=0)
    keep_b = _video(session, catalog.id, yt_id="keepB", position=1)
    drop_c = _video(session, catalog.id, yt_id="dropC", position=2)
    drop_d = _video(session, catalog.id, yt_id="dropD", position=3)

    session.add(
        ChannelCatalogEmbedding(
            catalog_video_id=drop_c.id,
            model="nomic-embed-text",
            dim=2,
            vector=b"\x00\x01",
            content_hash="abc",
        )
    )
    session.add(
        AiJob(
            kind=AiJobKind.embed_catalog_video,
            catalog_video_id=drop_d.id,
            status=AiJobStatus.queued,
        )
    )
    session.commit()

    _trim_beyond_cap(session, catalog)

    remaining = session.exec(
        select(ChannelCatalogVideo)
        .where(ChannelCatalogVideo.catalog_id == catalog.id)
        .order_by(ChannelCatalogVideo.position.asc())
    ).all()
    assert [r.yt_id for r in remaining] == ["keepA", "keepB"]
    assert {keep_a.id, keep_b.id} == {r.id for r in remaining}

    assert session.exec(select(ChannelCatalogEmbedding)).all() == []
    assert session.exec(select(AiJob)).all() == []
    assert session.exec(select(ChannelCatalogSkip)).all() == []


def test_trim_is_noop_when_at_or_under_cap(session):
    catalog = _catalog(session, max_videos=3)
    _video(session, catalog.id, yt_id="a", position=0)
    _video(session, catalog.id, yt_id="b", position=1)

    _trim_beyond_cap(session, catalog)

    rows = session.exec(
        select(ChannelCatalogVideo).where(ChannelCatalogVideo.catalog_id == catalog.id)
    ).all()
    assert {r.yt_id for r in rows} == {"a", "b"}


def test_description_pass_does_not_raise_stop_nameerror(session):
    from app.services.channel_catalog.index import _run_description_pass, should_stop

    assert should_stop() is False
    catalog = _catalog(session, max_videos=100)
    row = _video(session, catalog.id, yt_id="abc", position=0)
    row.description = "already indexed"
    session.add(row)
    session.commit()
    _run_description_pass(session, catalog)


def test_refresh_ready_catalog_calls_sync_feed_head(session, monkeypatch):
    from app.services.channel_catalog import runtime as rt

    catalog = ChannelCatalog(
        channel_url="https://www.youtube.com/@omnidroid",
        channel_name="Omnidroid v10",
        status=ChannelCatalogStatus.ready,
        indexed_count=3,
        max_videos=1000,
    )
    session.add(catalog)
    session.commit()

    called: list[str] = []

    monkeypatch.setattr(
        rt,
        "_library_channel_targets",
        lambda: [("Omnidroid v10", "https://www.youtube.com/@omnidroid")],
    )
    monkeypatch.setattr(
        "app.services.channel_catalog.index.sync_feed_head",
        lambda url, **_k: called.append(url) or {"entries": []},
    )

    result = rt.refresh_all_library_channels()
    assert called == ["https://www.youtube.com/@omnidroid"]
    assert result["refreshed"] == 1
    assert result["queued"] == 0

"""Handle vs /channel/UC aliases must not leave a stale error catalog."""

from sqlmodel import select

from app.models import ChannelCatalog, ChannelCatalogStatus, ChannelCatalogVideo
from app.services.channel_catalog.runtime import (
    _normalize_channel_url,
    get_catalog_by_url,
    get_runtime_status,
    reconcile_duplicate_catalogs,
)


HANDLE = "https://www.youtube.com/@omnidroid_v10"
CHANNEL_ID = "https://www.youtube.com/channel/UCNNZkE3vPc0Wlbp3iqi5vQw"


def _add_catalog(session, *, url: str, status: ChannelCatalogStatus, **kwargs) -> ChannelCatalog:
    catalog = ChannelCatalog(
        channel_url=url,
        channel_name="Omnidroid v10",
        status=status,
        **kwargs,
    )
    session.add(catalog)
    session.commit()
    session.refresh(catalog)
    return catalog


def test_normalize_strips_www_and_videos_tab():
    assert _normalize_channel_url(
        "https://www.youtube.com/@Omnidroid_v10/videos"
    ) == "https://youtube.com/@omnidroid_v10"


def test_get_catalog_by_url_matches_handle_variants(session):
    _add_catalog(session, url=HANDLE, status=ChannelCatalogStatus.ready, indexed_count=60)
    hit = get_catalog_by_url(session, "https://youtube.com/@omnidroid_v10/videos")
    assert hit is not None
    assert hit.channel_url == HANDLE


def test_get_catalog_by_url_matches_channel_id_by_name(session):
    ready = _add_catalog(
        session, url=HANDLE, status=ChannelCatalogStatus.ready, indexed_count=60
    )
    hit = get_catalog_by_url(
        session, CHANNEL_ID, channel_name="Omnidroid v10"
    )
    assert hit is not None
    assert hit.id == ready.id


def test_reconcile_drops_stale_channel_id_error(session):
    error = _add_catalog(
        session,
        url=CHANNEL_ID,
        status=ChannelCatalogStatus.error,
        indexed_count=60,
        complete=True,
        last_error="name '_stop' is not defined",
    )
    ready = _add_catalog(
        session, url=HANDLE, status=ChannelCatalogStatus.ready, indexed_count=60, complete=True
    )
    session.add(
        ChannelCatalogVideo(
            catalog_id=error.id,
            yt_id="oldvid",
            url="https://www.youtube.com/watch?v=oldvid",
            position=0,
        )
    )
    session.commit()

    removed = reconcile_duplicate_catalogs(session)
    assert removed == 1

    rows = session.exec(select(ChannelCatalog)).all()
    assert len(rows) == 1
    keeper = rows[0]
    assert keeper.id == ready.id
    assert keeper.status == ChannelCatalogStatus.ready
    assert keeper.last_error is None
    assert "@omnidroid_v10" in keeper.channel_url.lower()
    assert session.exec(select(ChannelCatalogVideo)).all() == []


def test_runtime_status_hides_merged_error(session):
    _add_catalog(
        session,
        url=CHANNEL_ID,
        status=ChannelCatalogStatus.error,
        indexed_count=60,
        last_error="name '_stop' is not defined",
    )
    _add_catalog(
        session, url=HANDLE, status=ChannelCatalogStatus.ready, indexed_count=60
    )

    status = get_runtime_status()
    catalogs = status["catalogs"]
    assert len(catalogs) == 1
    assert catalogs[0]["status"] == "ready"
    assert catalogs[0]["last_error"] is None


def test_reconcile_does_not_merge_different_handles_with_same_name(session):
    _add_catalog(
        session,
        url="https://www.youtube.com/@alpha",
        status=ChannelCatalogStatus.ready,
        indexed_count=1,
    )
    other = ChannelCatalog(
        channel_url="https://www.youtube.com/@beta",
        channel_name="Omnidroid v10",
        status=ChannelCatalogStatus.ready,
        indexed_count=1,
    )
    session.add(other)
    session.commit()

    assert reconcile_duplicate_catalogs(session) == 0
    assert len(session.exec(select(ChannelCatalog)).all()) == 2

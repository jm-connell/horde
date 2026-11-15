"""The channel page reads its own catalog row from /api/channels/catalog/status."""

from datetime import timedelta

from app.models import ChannelCatalog, ChannelCatalogStatus, utcnow

# Library channels carry the uploader URL as yt-dlp reports it; catalogs store the
# normalized form. The page must still find its row (prod: every channel page
# showed "Not indexed" because the client compared the two strings).
LIBRARY_URL = "https://www.youtube.com/@LinusTechTips"
CATALOG_URL = "https://youtube.com/@linustechtips"


def _add_catalog(session, url: str, name: str, **kwargs) -> ChannelCatalog:
    catalog = ChannelCatalog(
        channel_url=url,
        channel_name=name,
        status=ChannelCatalogStatus.ready,
        indexed_count=1000,
        complete=True,
        **kwargs,
    )
    session.add(catalog)
    session.commit()
    session.refresh(catalog)
    return catalog


def test_status_returns_channel_catalog_for_library_url(client, session):
    ltt = _add_catalog(session, CATALOG_URL, "Linus Tech Tips")

    body = client.get(
        "/api/channels/catalog/status",
        params={"channel_url": LIBRARY_URL, "channel": "Linus Tech Tips"},
    ).json()

    assert body["channel_catalog"]["id"] == ltt.id
    assert body["channel_catalog"]["status"] == "ready"
    assert body["channel_catalog"]["indexed_count"] == 1000


def test_status_finds_channel_catalog_beyond_recent_list(client, session):
    old = utcnow() - timedelta(days=30)
    ltt = _add_catalog(session, CATALOG_URL, "Linus Tech Tips", updated_at=old)
    for i in range(45):
        _add_catalog(session, f"https://youtube.com/@other{i}", f"Other {i}")

    body = client.get(
        "/api/channels/catalog/status", params={"channel_url": LIBRARY_URL}
    ).json()

    assert ltt.id not in {c["id"] for c in body["catalogs"]}
    assert body["channel_catalog"]["id"] == ltt.id


def test_status_without_channel_has_no_channel_catalog(client, session):
    _add_catalog(session, CATALOG_URL, "Linus Tech Tips")
    body = client.get("/api/channels/catalog/status").json()
    assert body["channel_catalog"] is None

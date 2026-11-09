"""GET /api/channels/avatar: a channel's profile picture from its YouTube page."""

from __future__ import annotations

import pytest

from app.services import channel_avatar
from app.services.url_safety import FetchResult, UrlFetchError

CHANNEL = "https://www.youtube.com/@kilnworks"
AVATAR = "https://yt3.googleusercontent.com/abc_DEF-123=s900-c-k-c0x00ffffff-no-rj"


def _page(image: str, about: str = "") -> bytes:
    return (
        '<html><head><meta property="og:title" content="Kiln Works">'
        f'<meta property="og:description" content="{about}">'
        f'<meta property="og:image" content="{image}"></head></html>'
    ).encode()


@pytest.fixture
def pages(monkeypatch):
    """The channel pages fetched (by URL), answered from ``pages.body``."""

    class Pages:
        body = _page(AVATAR)
        fail = False
        fetched: list[str] = []

    def fetch(url, **_kw):
        Pages.fetched.append(url)
        if Pages.fail:
            raise UrlFetchError("HTTP 500")
        return FetchResult(Pages.body, "text/html", url)

    Pages.fetched = []
    monkeypatch.setattr(channel_avatar, "fetch_bytes", fetch)
    return Pages


def test_avatar_is_read_once_and_sized_for_the_header(client, pages):
    first = client.get("/api/channels/avatar", params={"url": CHANNEL})
    assert first.status_code == 200, first.text
    assert first.json() == {
        "url": "https://yt3.googleusercontent.com/abc_DEF-123=s176-c-k-c0x00ffffff-no-rj",
        "about": None,
    }
    again = client.get("/api/channels/avatar", params={"url": CHANNEL + "/"})
    assert again.json() == first.json()
    assert pages.fetched == ["https://youtube.com/@kilnworks"]


def test_a_page_without_a_youtube_avatar_answers_null(client, pages):
    pages.body = _page("https://evil.example/tracker.png")
    body = client.get("/api/channels/avatar", params={"url": CHANNEL}).json()
    assert body == {"url": None, "about": None}


def test_a_failed_read_answers_null(client, pages):
    pages.fail = True
    body = client.get("/api/channels/avatar", params={"url": CHANNEL}).json()
    assert body == {"url": None, "about": None}


def test_only_youtube_channels_are_read(client, pages):
    resp = client.get("/api/channels/avatar", params={"url": "https://vimeo.com/x"})
    assert resp.status_code == 400
    assert resp.json()["code"] == "invalid_url"
    assert pages.fetched == []


def test_a_failed_refresh_keeps_the_known_avatar(client, pages, monkeypatch):
    client.get("/api/channels/avatar", params={"url": CHANNEL})
    # A week later the page cannot be read: the picture stays.
    later = channel_avatar.time.time() + channel_avatar.FOUND_TTL_SEC + 1
    monkeypatch.setattr(channel_avatar.time, "time", lambda: later)
    pages.fail = True
    body = client.get("/api/channels/avatar", params={"url": CHANNEL}).json()
    assert body["url"] and "=s176" in body["url"]
    assert len(pages.fetched) == 2


def test_the_bio_comes_back_on_one_line_and_cut_short(client, pages):
    long_bio = "Pottery &amp; kilns.\n" + "We fire stoneware every week " * 20
    pages.body = _page(AVATAR, long_bio)
    about = client.get("/api/channels/avatar", params={"url": CHANNEL}).json()["about"]
    assert about.startswith("Pottery & kilns. We fire stoneware")
    assert "\n" not in about
    assert len(about) <= channel_avatar.ABOUT_MAX_CHARS
    assert about.endswith("…")

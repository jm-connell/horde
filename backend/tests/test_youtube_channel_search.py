"""Direct YouTube channel search: URL builder, enablement, mocked extract."""

from app.services import app_settings as settings_svc
from app.services.channel_catalog.runtime import (
    set_direct_youtube_search,
    youtube_search_pref,
)
from app.services.ytdlp_extract import (
    channel_search_url,
    is_youtube_playlist_entry,
    is_youtube_short_entry,
    is_youtube_url,
    search_youtube_channel_videos,
)


LTT = "https://www.youtube.com/@LinusTechTips"


def test_channel_search_url_uses_search_tab():
    assert (
        channel_search_url(LTT, "paint")
        == "https://www.youtube.com/@LinusTechTips/search?query=paint"
    )
    assert (
        channel_search_url(f"{LTT}/videos", "wifi fix")
        == "https://www.youtube.com/@LinusTechTips/search?query=wifi%20fix"
    )


def test_is_youtube_url():
    assert is_youtube_url(LTT) is True
    assert is_youtube_url("https://youtube.com/channel/UCabc") is True
    assert is_youtube_url("https://vimeo.com/foo") is False
    assert is_youtube_url("") is False


def test_search_skips_short_query_and_non_youtube(monkeypatch):
    called = {"n": 0}

    def boom(*_a, **_k):
        called["n"] += 1
        raise AssertionError("extract should not run")

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", boom
    )
    assert search_youtube_channel_videos(LTT, "p") == []
    assert search_youtube_channel_videos("https://vimeo.com/foo", "paint") == []
    assert called["n"] == 0


def test_search_maps_flat_entries(monkeypatch):
    def fake_extract(url, opts, *, cache_key=None, force=False):
        assert "/search?query=paint" in url
        assert cache_key and cache_key.startswith("channel-search:v2:")
        assert cache_key.endswith(":80")
        assert opts.get("playlistend", 0) >= 40
        return {
            "uploader": "Linus Tech Tips",
            "entries": [
                {
                    "id": "paintfix111",
                    "url": "https://www.youtube.com/watch?v=paintfix111",
                    "title": "I painted his House to Fix his WiFi",
                    "duration": 1234,
                    "view_count": 9_000_000,
                    "upload_date": "20240901",
                    "thumbnails": [
                        {"url": "https://i.ytimg.com/vi/paintfix111/mqdefault.jpg"}
                    ],
                },
                {"id": None, "title": "skip me"},
            ],
        }

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", fake_extract
    )
    hits = search_youtube_channel_videos(LTT, "paint")
    assert len(hits) == 1
    hit = hits[0]
    assert hit["id"] == "paintfix111"
    assert hit["title"].startswith("I painted")
    assert hit["channel"] == "Linus Tech Tips"
    assert hit["duration"] == 1234
    assert hit["view_count"] == 9_000_000
    assert hit["published_at"].startswith("2024-09-01")
    assert not hit.get("published_label")
    assert hit["thumbnail_url"]
    assert hit["match_reason"]["source"] == "youtube"


def test_search_maps_timestamp_when_upload_date_missing(monkeypatch):
    def fake_extract(url, opts, *, cache_key=None, force=False):
        return {
            "uploader": "Linus Tech Tips",
            "entries": [
                {
                    "id": "oldpaint111",
                    "url": "https://www.youtube.com/watch?v=oldpaint111",
                    "title": "Old paint video",
                    "timestamp": 1388534400,
                    "view_count": 100,
                }
            ],
        }

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", fake_extract
    )
    hits = search_youtube_channel_videos(LTT, "paint")
    assert len(hits) == 1
    assert hits[0]["published_at"].startswith("2014-01-01")
    assert hits[0]["published_label"]
    assert hits[0]["published_label"].endswith("ago")


def test_search_skips_shorts_and_playlists(monkeypatch):
    def fake_extract(url, opts, *, cache_key=None, force=False):
        return {
            "uploader": "Linus Tech Tips",
            "entries": [
                {
                    "id": "paintfix111",
                    "url": "https://www.youtube.com/watch?v=paintfix111",
                    "title": "I painted his House to Fix his WiFi",
                    "duration": 1234,
                    "timestamp": 1725148800,
                    "view_count": 9,
                },
                {
                    "id": "PL5F19DCC0D1295768",
                    "url": "https://www.youtube.com/playlist?list=PL5F19DCC0D1295768",
                    "ie_key": "YoutubeTab",
                    "title": "My Personal Rig Upgrade 2012",
                },
                {
                    "id": "shortwatch1",
                    "url": "https://www.youtube.com/watch?v=shortwatch1",
                    "title": "CLEAN YOUR GPU (in 10 steps) #SHORTS",
                    "duration": 26,
                    "timestamp": 1662163200,
                },
                {
                    "id": "shorturl111",
                    "url": "https://www.youtube.com/shorts/shorturl111",
                    "title": "A reel",
                    "duration": 12,
                    "timestamp": 1756857600,
                },
                {
                    "id": "submin2024a",
                    "url": "https://www.youtube.com/watch?v=submin2024a",
                    "title": "creators give tech hot takes",
                    "duration": 45,
                    "timestamp": 1756857600,
                },
                {
                    "id": "oldshort55s",
                    "url": "https://www.youtube.com/watch?v=oldshort55s",
                    "title": "The New Background for the Tech Tips Room",
                    "duration": 55,
                    "timestamp": 1283472000,
                },
            ],
        }

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", fake_extract
    )
    hits = search_youtube_channel_videos(LTT, "paint")
    assert [h["id"] for h in hits] == ["paintfix111", "oldshort55s"]
    assert hits[0]["published_at"]
    assert hits[1]["published_at"]


def test_short_and_playlist_helpers():
    assert is_youtube_playlist_entry(
        {
            "id": "PL5F19DCC0D1295768",
            "url": "https://www.youtube.com/playlist?list=PL5F19DCC0D1295768",
            "ie_key": "YoutubeTab",
        }
    )
    assert is_youtube_short_entry(
        {
            "id": "abcdefghijk",
            "url": "https://www.youtube.com/shorts/abcdefghijk",
            "duration": 20,
        }
    )
    assert is_youtube_short_entry(
        {
            "id": "abcdefghijk",
            "url": "https://www.youtube.com/watch?v=abcdefghijk",
            "title": "CLEAN YOUR GPU #SHORTS",
            "duration": 26,
            "timestamp": 1662163200,
        }
    )
    assert not is_youtube_short_entry(
        {
            "id": "abcdefghijk",
            "url": "https://www.youtube.com/watch?v=abcdefghijk",
            "title": "The New Background",
            "duration": 55,
            "timestamp": 1283472000,
        }
    )


def test_extract_failure_returns_empty(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("bot check")

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", boom
    )
    assert search_youtube_channel_videos(LTT, "paint") == []


def test_per_channel_override_inherit_on_off(session):
    settings_svc.save({"direct_youtube_search": False})
    pref = youtube_search_pref(session, LTT)
    assert pref["direct_youtube_search"] is None
    assert pref["direct_youtube_search_effective"] is False

    on = set_direct_youtube_search(LTT, True, channel_name="Linus Tech Tips")
    assert on is not None
    assert on["direct_youtube_search"] is True
    assert on["direct_youtube_search_effective"] is True

    off = set_direct_youtube_search(LTT, False)
    assert off["direct_youtube_search"] is False
    assert off["direct_youtube_search_effective"] is False

    inherit = set_direct_youtube_search(LTT, None)
    assert inherit["direct_youtube_search"] is None
    assert inherit["direct_youtube_search_effective"] is False

    settings_svc.save({"direct_youtube_search": True})
    inherit_on = youtube_search_pref(session, LTT)
    assert inherit_on["direct_youtube_search_effective"] is True


def test_set_direct_youtube_search_rejects_non_youtube():
    assert set_direct_youtube_search("https://vimeo.com/foo", True) is None


def test_youtube_search_api_respects_setting(client, monkeypatch):
    called = {"n": 0}

    def fake_search(url, query, *, limit=20):
        called["n"] += 1
        return [
            {
                "id": "paintfix111",
                "url": "https://www.youtube.com/watch?v=paintfix111",
                "title": "I painted his House to Fix his WiFi",
                "duration": 100,
                "thumbnail_url": "https://i.ytimg.com/vi/paintfix111/mqdefault.jpg",
                "view_count": 1,
                "published_at": "2024-09-01",
                "published_label": None,
                "channel": "Linus Tech Tips",
                "match_reason": {"source": "youtube", "snippet": None},
            }
        ]

    monkeypatch.setattr(
        "app.api.channels.search_youtube_channel_videos", fake_search
    )

    client.patch("/api/settings", json={"direct_youtube_search": False})
    skipped = client.get(
        "/api/channels/youtube-search",
        params={"url": LTT, "channel": "Linus Tech Tips", "q": "paint"},
    )
    assert skipped.status_code == 200
    assert skipped.json()["entries"] == []
    assert skipped.json()["direct_youtube_search_effective"] is False
    assert called["n"] == 0

    client.patch("/api/settings", json={"direct_youtube_search": True})
    enabled = client.get(
        "/api/channels/youtube-search",
        params={"url": LTT, "channel": "Linus Tech Tips", "q": "paint"},
    )
    assert enabled.status_code == 200
    body = enabled.json()
    assert len(body["entries"]) == 1
    assert body["entries"][0]["id"] == "paintfix111"
    assert body["entries"][0]["title"].startswith("I painted")
    assert body["entries"][0]["thumbnail_url"]
    assert body["entries"][0]["match_reason"]["source"] == "youtube"
    assert body["entries"][0]["published_at"].startswith("2024-09-01")
    assert not body["entries"][0].get("published_label")
    assert called["n"] == 1


def test_youtube_search_api_passes_relative_published_label(client, monkeypatch):
    def fake_search(url, query, *, limit=20):
        return [
            {
                "id": "oldpaint111",
                "url": "https://www.youtube.com/watch?v=oldpaint111",
                "title": "Old paint video",
                "duration": 100,
                "thumbnail_url": "https://i.ytimg.com/vi/oldpaint111/mqdefault.jpg",
                "view_count": 1,
                "published_at": "2014-01-01T00:00:00+00:00",
                "published_label": "12 years ago",
                "channel": "Linus Tech Tips",
                "match_reason": {"source": "youtube", "snippet": None},
            }
        ]

    monkeypatch.setattr(
        "app.api.channels.search_youtube_channel_videos", fake_search
    )
    client.patch("/api/settings", json={"direct_youtube_search": True})
    body = client.get(
        "/api/channels/youtube-search",
        params={"url": LTT, "channel": "Linus Tech Tips", "q": "paint"},
    ).json()
    assert body["entries"][0]["published_label"] == "12 years ago"
    assert body["entries"][0]["published_at"].startswith("2014-01-01")


def test_youtube_search_pref_patch(client):
    off = client.patch(
        "/api/channels/catalog/youtube-search",
        json={"url": LTT, "channel": "Linus Tech Tips", "direct_youtube_search": False},
    )
    assert off.status_code == 200
    assert off.json()["direct_youtube_search"] is False
    assert off.json()["direct_youtube_search_effective"] is False

    inherit = client.patch(
        "/api/channels/catalog/youtube-search",
        json={"url": LTT, "direct_youtube_search": None},
    )
    assert inherit.status_code == 200
    assert inherit.json()["direct_youtube_search"] is None
    assert inherit.json()["direct_youtube_search_effective"] is True

    status = client.get("/api/channels/catalog/status").json()
    assert status["direct_youtube_search"] is True
    hit = next(c for c in status["catalogs"] if "linustechtips" in c["channel_url"].lower())
    assert hit["direct_youtube_search"] is None
    assert hit["direct_youtube_search_effective"] is True

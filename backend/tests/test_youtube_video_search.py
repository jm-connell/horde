"""Site-wide YouTube video search: URL builder, setting gate, mocked extract."""

from app.services.ytdlp_extract import (
    search_youtube_videos,
    youtube_search_fetch_n,
    youtube_video_search_url,
)


def test_youtube_video_search_url_uses_ytsearch():
    assert youtube_video_search_url("t480 mod") == "ytsearch40:t480 mod"
    assert (
        youtube_video_search_url("hyprland install guide", fetch_n=80)
        == "ytsearch80:hyprland install guide"
    )
    assert youtube_video_search_url("t480", fetch_n=160) == "ytsearch160:t480"
    assert youtube_video_search_url("t480", fetch_n=999) == "ytsearch200:t480"


def test_youtube_search_fetch_n_buckets():
    assert youtube_search_fetch_n(offset=0, limit=20) == 80
    assert youtube_search_fetch_n(offset=20, limit=20) == 80
    assert youtube_search_fetch_n(offset=60, limit=20) == 80
    assert youtube_search_fetch_n(offset=80, limit=20) == 160
    assert youtube_search_fetch_n(offset=180, limit=20) == 200


def test_search_skips_short_query(monkeypatch):
    called = {"n": 0}

    def boom(*_a, **_k):
        called["n"] += 1
        raise AssertionError("extract should not run")

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", boom
    )
    assert search_youtube_videos("t") == {"entries": [], "has_more": False}
    assert search_youtube_videos("  ") == {"entries": [], "has_more": False}
    assert called["n"] == 0


def test_search_maps_per_entry_channel(monkeypatch):
    def fake_extract(url, opts, *, cache_key=None, force=False):
        assert url == "ytsearch80:t480 mod"
        assert cache_key == "yt-video-search:v2:t480 mod:80"
        assert opts.get("playlistend", 0) >= 40
        return {
            "entries": [
                {
                    "id": "t480mod1111",
                    "url": "https://www.youtube.com/watch?v=t480mod1111",
                    "title": "ThinkPad T480 mod guide",
                    "duration": 900,
                    "view_count": 120_000,
                    "upload_date": "20240901",
                    "uploader": "Notebook Repair",
                    "channel": "Notebook Repair",
                    "channel_url": "https://www.youtube.com/@NotebookRepair",
                    "thumbnails": [
                        {"url": "https://i.ytimg.com/vi/t480mod1111/mqdefault.jpg"}
                    ],
                },
                {"id": None, "title": "skip me"},
            ],
        }

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", fake_extract
    )
    hits = search_youtube_videos("t480 mod")
    assert hits["has_more"] is False
    assert len(hits["entries"]) == 1
    hit = hits["entries"][0]
    assert hit["id"] == "t480mod1111"
    assert hit["title"].startswith("ThinkPad")
    assert hit["channel"] == "Notebook Repair"
    assert hit["channel_url"] == "https://www.youtube.com/@NotebookRepair"
    assert hit["duration"] == 900
    assert hit["view_count"] == 120_000
    assert hit["published_at"].startswith("2024-09-01")
    assert not hit.get("published_label")
    assert hit["thumbnail_url"]
    assert hit["match_reason"]["source"] == "youtube"


def test_search_skips_shorts_and_playlists(monkeypatch):
    def fake_extract(url, opts, *, cache_key=None, force=False):
        return {
            "entries": [
                {
                    "id": "t480mod1111",
                    "url": "https://www.youtube.com/watch?v=t480mod1111",
                    "title": "ThinkPad T480 mod guide",
                    "duration": 900,
                    "timestamp": 1725148800,
                    "uploader": "Notebook Repair",
                },
                {
                    "id": "PL5F19DCC0D1295768",
                    "url": "https://www.youtube.com/playlist?list=PL5F19DCC0D1295768",
                    "ie_key": "YoutubeTab",
                    "title": "ThinkPad playlist",
                },
                {
                    "id": "shorturl111",
                    "url": "https://www.youtube.com/shorts/shorturl111",
                    "title": "A reel",
                    "duration": 12,
                    "timestamp": 1756857600,
                },
            ],
        }

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", fake_extract
    )
    page = search_youtube_videos("t480")
    assert [h["id"] for h in page["entries"]] == ["t480mod1111"]
    assert page["has_more"] is False


def test_extract_failure_returns_empty(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("bot check")

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", boom
    )
    assert search_youtube_videos("t480") == {"entries": [], "has_more": False}


def test_youtube_search_api_respects_setting(client, monkeypatch):
    called = {"n": 0}

    def fake_search(query, *, limit=20, offset=0):
        called["n"] += 1
        assert offset == 0
        return {
            "entries": [
                {
                    "id": "t480mod1111",
                    "url": "https://www.youtube.com/watch?v=t480mod1111",
                    "title": "ThinkPad T480 mod guide",
                    "duration": 900,
                    "thumbnail_url": "https://i.ytimg.com/vi/t480mod1111/mqdefault.jpg",
                    "view_count": 120_000,
                    "published_at": "2024-09-01",
                    "published_label": None,
                    "channel": "Notebook Repair",
                    "channel_url": "https://www.youtube.com/@NotebookRepair",
                    "match_reason": {"source": "youtube", "snippet": None},
                }
            ],
            "has_more": False,
        }

    monkeypatch.setattr("app.api.channels.search_youtube_videos", fake_search)

    client.patch("/api/settings", json={"youtube_video_search": False})
    skipped = client.get("/api/youtube/search", params={"q": "t480"})
    assert skipped.status_code == 200
    assert skipped.json()["entries"] == []
    assert skipped.json()["youtube_video_search_effective"] is False
    assert called["n"] == 0

    client.patch("/api/settings", json={"youtube_video_search": True})
    enabled = client.get("/api/youtube/search", params={"q": "t480"})
    assert enabled.status_code == 200
    body = enabled.json()
    assert len(body["entries"]) == 1
    assert body["entries"][0]["id"] == "t480mod1111"
    assert body["entries"][0]["channel"] == "Notebook Repair"
    assert body["entries"][0]["channel_url"] == "https://www.youtube.com/@NotebookRepair"
    assert body["entries"][0]["thumbnail_url"]
    assert body["entries"][0]["view_count"] == 120_000
    assert body["entries"][0]["match_reason"]["source"] == "youtube"
    assert body["youtube_video_search_effective"] is True
    assert body["has_more"] is False
    assert called["n"] == 1


def test_search_pages_offset(monkeypatch):
    def fake_extract(url, opts, *, cache_key=None, force=False):
        assert url.startswith("ytsearch80:")
        return {
            "entries": [
                {
                    "id": f"t480pg{i:05d}",
                    "url": f"https://www.youtube.com/watch?v=t480pg{i:05d}",
                    "title": f"Result {i}",
                    "duration": 90,
                    "uploader": "Notebook Repair",
                }
                for i in range(25)
            ]
        }

    monkeypatch.setattr(
        "app.services.ytdlp_extract.extract_info_gated", fake_extract
    )
    first = search_youtube_videos("t480", limit=20, offset=0)
    assert first["has_more"] is True
    assert [e["title"] for e in first["entries"]] == [f"Result {i}" for i in range(20)]
    second = search_youtube_videos("t480", limit=20, offset=20)
    assert second["has_more"] is False
    assert [e["title"] for e in second["entries"]] == [
        f"Result {i}" for i in range(20, 25)
    ]


def test_youtube_search_api_passes_offset(client, monkeypatch):
    seen = {"offset": None, "limit": None}

    def fake_search(query, *, limit=20, offset=0):
        seen["offset"] = offset
        seen["limit"] = limit
        return {
            "entries": [
                {
                    "id": "page2video1",
                    "url": "https://www.youtube.com/watch?v=page2video1",
                    "title": "Page two",
                    "duration": 60,
                    "thumbnail_url": "https://i.ytimg.com/vi/page2video1/mqdefault.jpg",
                    "view_count": 1,
                    "published_at": "2024-09-01",
                    "published_label": None,
                    "channel": "Notebook Repair",
                    "channel_url": "https://www.youtube.com/@NotebookRepair",
                    "match_reason": {"source": "youtube", "snippet": None},
                }
            ],
            "has_more": True,
        }

    monkeypatch.setattr("app.api.channels.search_youtube_videos", fake_search)
    resp = client.get(
        "/api/youtube/search", params={"q": "t480", "limit": 20, "offset": 20}
    )
    assert resp.status_code == 200
    assert seen == {"offset": 20, "limit": 20}
    body = resp.json()
    assert body["has_more"] is True
    assert body["entries"][0]["id"] == "page2video1"


def test_youtube_search_api_rejects_short_query(client):
    resp = client.get("/api/youtube/search", params={"q": "t"})
    assert resp.status_code == 422

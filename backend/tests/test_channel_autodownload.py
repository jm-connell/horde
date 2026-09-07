"""Channel autodownload policy, candidate selection, and HTTP."""

from sqlmodel import select

from app.models import (
    ChannelAutodownload,
    ChannelCatalog,
    ChannelCatalogStatus,
    ChannelCatalogVideo,
    DownloadJob,
    JobStatus,
)
from app.services import channel_autodownload as ad
from app.services.ytdlp_extract import (
    _map_flat_video_entry,
    is_youtube_short_entry,
    is_youtube_short_url,
)


LTT = "https://www.youtube.com/@LinusTechTips"


def _catalog(session, *, url=LTT, name="Linus Tech Tips") -> ChannelCatalog:
    row = ChannelCatalog(
        channel_url=url,
        channel_name=name,
        status=ChannelCatalogStatus.ready,
        indexed_count=0,
        complete=True,
        max_videos=1000,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def _cvid(
    session,
    catalog_id: int,
    *,
    yt_id: str,
    position: int,
    duration: float = 600,
    live_status: str | None = "not_live",
    title: str | None = None,
    url: str | None = None,
) -> ChannelCatalogVideo:
    row = ChannelCatalogVideo(
        catalog_id=catalog_id,
        yt_id=yt_id,
        url=url or f"https://www.youtube.com/watch?v={yt_id}",
        title=title or f"Talk {yt_id}",
        duration=duration,
        live_status=live_status,
        position=position,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def _policy(session, **fields) -> ChannelAutodownload:
    row = ChannelAutodownload(
        channel_url=fields.pop("channel_url", LTT),
        channel_name=fields.pop("channel_name", "Linus Tech Tips"),
        enabled=fields.pop("enabled", True),
        previous_mode=fields.pop("previous_mode", "none"),
        previous_count=fields.pop("previous_count", 10),
        quality_preset=fields.pop("quality_preset", "1080p"),
        include_completed_streams=fields.pop("include_completed_streams", False),
        anchor_ready=fields.pop("anchor_ready", True),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def test_should_skip_live_rules():
    assert ad.should_skip_live("is_live", 0, include_completed_streams=False) == "live"
    assert ad.should_skip_live("is_upcoming", None, include_completed_streams=True) == "live"
    assert ad.should_skip_live("post_live", None, include_completed_streams=True) == "live"
    assert (
        ad.should_skip_live("was_live", 3600, include_completed_streams=False)
        == "completed_stream"
    )
    assert ad.should_skip_live("was_live", 3600, include_completed_streams=True) is None
    assert ad.should_skip_live("not_live", 600, include_completed_streams=False) is None
    assert ad.should_skip_live(None, None, include_completed_streams=False) == "live"
    assert ad.should_skip_live("not_live", None, include_completed_streams=False) is None


def test_backfill_window_modes():
    rows = [
        ChannelCatalogVideo(
            catalog_id=1, yt_id=f"id{i}aaaaaa", url="https://youtu.be/x", position=i
        )
        for i in range(5)
    ]
    assert ad.backfill_window(rows, "none", 10) == []
    count = ad.backfill_window(rows, "count", 2)
    assert [r.yt_id for r in count] == ["id0aaaaaa", "id1aaaaaa"]
    assert len(ad.backfill_window(rows, "all", None)) == 5


def test_map_flat_drops_duration_shorts_and_keeps_live_status():
    short = _map_flat_video_entry(
        {
            "id": "shorturl111",
            "url": "https://www.youtube.com/watch?v=shorturl111",
            "title": "A reel",
            "duration": 18,
            "timestamp": 1725148800,
        }
    )
    assert short is None
    vod = _map_flat_video_entry(
        {
            "id": "talkurl1111",
            "url": "https://www.youtube.com/watch?v=talkurl1111",
            "title": "Long talk",
            "duration": 900,
            "live_status": "was_live",
        }
    )
    assert vod is not None
    assert vod["live_status"] == "was_live"


def test_is_youtube_short_url_and_pre_shorts_era():
    assert is_youtube_short_url("https://www.youtube.com/shorts/abcdefghijk")
    assert not is_youtube_short_entry(
        {
            "id": "abcdefghijk",
            "url": "https://www.youtube.com/watch?v=abcdefghijk",
            "title": "Old clip",
            "duration": 40,
            "published_at": "2012-05-01",
        }
    )


def test_first_head_sync_seeds_anchor_without_future_enqueue(session, monkeypatch):
    catalog = _catalog(session)
    _cvid(session, catalog.id, yt_id="newvid11111", position=0)
    _policy(session, previous_mode="none", anchor_ready=False)
    monkeypatch.setattr(ad, "enqueue_catalog_row", lambda *a, **k: 1)
    n = ad.after_catalog_update(LTT, new_yt_ids=["newvid11111"], source="head")
    assert n == 0
    row = session.exec(select(ChannelAutodownload)).first()
    session.refresh(row)
    assert row.anchor_ready is True


def test_later_head_sync_enqueues_new_ids(session, monkeypatch):
    catalog = _catalog(session)
    _cvid(session, catalog.id, yt_id="newvid11111", position=0)
    _policy(session, previous_mode="none", anchor_ready=True)
    called: list[str] = []

    def fake_enqueue(_session, row, _policy):
        called.append(row.yt_id)
        return 1

    monkeypatch.setattr(ad, "enqueue_catalog_row", fake_enqueue)
    n = ad.after_catalog_update(LTT, new_yt_ids=["newvid11111"], source="head")
    assert n == 1
    assert called == ["newvid11111"]


def test_count_backfill_skips_library_and_shorts(session, add_video, monkeypatch):
    catalog = _catalog(session)
    _cvid(session, catalog.id, yt_id="keep0000001", position=0, duration=800)
    add_video(yt_id="alreadydown", title="Have it")
    _cvid(session, catalog.id, yt_id="alreadydown", position=1, duration=800)
    _cvid(
        session,
        catalog.id,
        yt_id="short000001",
        position=2,
        duration=20,
        url="https://www.youtube.com/shorts/short000001",
    )
    _cvid(session, catalog.id, yt_id="older000001", position=3, duration=800)
    _policy(session, previous_mode="count", previous_count=3, anchor_ready=True)
    called: list[str] = []

    def fake_enqueue(_session, row, _policy):
        called.append(row.yt_id)
        return 1

    monkeypatch.setattr(ad, "enqueue_catalog_row", fake_enqueue)
    n = ad.after_catalog_update(LTT, new_yt_ids=[], source="index")
    assert n == 1
    assert called == ["keep0000001"]


def test_skip_live_and_include_completed_streams(session, monkeypatch):
    catalog = _catalog(session)
    _cvid(
        session,
        catalog.id,
        yt_id="live0000001",
        position=0,
        duration=None,
        live_status="is_live",
    )
    _cvid(
        session,
        catalog.id,
        yt_id="vod00000001",
        position=1,
        duration=3600,
        live_status="was_live",
    )
    _policy(
        session,
        previous_mode="all",
        include_completed_streams=False,
        anchor_ready=True,
    )
    called: list[str] = []
    monkeypatch.setattr(
        ad,
        "enqueue_catalog_row",
        lambda _s, row, _p: called.append(row.yt_id) or 1,
    )
    ad.after_catalog_update(LTT, new_yt_ids=[], source="index")
    assert called == []

    policy = session.exec(select(ChannelAutodownload)).first()
    policy.include_completed_streams = True
    session.add(policy)
    session.commit()
    called.clear()
    ad.after_catalog_update(LTT, new_yt_ids=[], source="index")
    assert called == ["vod00000001"]


def test_skip_active_download_job(session, monkeypatch):
    catalog = _catalog(session)
    _cvid(session, catalog.id, yt_id="queued00001", position=0)
    session.add(
        DownloadJob(
            url="https://www.youtube.com/watch?v=queued00001",
            quality_preset="720p",
            status=JobStatus.queued,
        )
    )
    session.commit()
    _policy(session, previous_mode="all", anchor_ready=True)
    called: list[str] = []
    monkeypatch.setattr(
        ad,
        "enqueue_catalog_row",
        lambda _s, row, _p: called.append(row.yt_id) or 1,
    )
    ad.after_catalog_update(LTT, new_yt_ids=[], source="index")
    assert called == []


def test_enqueue_catalog_row_creates_job(session, monkeypatch):
    catalog = _catalog(session)
    row = _cvid(session, catalog.id, yt_id="jobvid00001", position=0)
    policy = _policy(session, previous_mode="none")
    enqueued: list[int] = []
    monkeypatch.setattr(
        "app.services.downloader.enqueue_download",
        lambda job_id: enqueued.append(job_id),
    )
    job_id = ad.enqueue_catalog_row(session, row, policy)
    assert job_id is not None
    assert enqueued == [job_id]
    job = session.get(DownloadJob, job_id)
    assert job is not None
    assert job.quality_preset == "1080p"
    assert "jobvid00001" in job.url
    assert job.destination == "library"


def test_autodownload_api_get_default_and_put(client, session, monkeypatch):
    monkeypatch.setattr(ad, "schedule_apply_saved_policy", lambda *a, **k: None)
    _catalog(session)

    missing = client.get("/api/channels/autodownload", params={"url": LTT})
    assert missing.status_code == 200
    body = missing.json()
    assert body["configured"] is False
    assert body["enabled"] is False
    assert body["quality_preset"] == "1080p"
    assert body["previous_mode"] == "none"

    saved = client.put(
        "/api/channels/autodownload",
        json={
            "url": LTT,
            "channel": "Linus Tech Tips",
            "enabled": True,
            "previous_mode": "count",
            "previous_count": 7,
            "quality_preset": "720p",
            "include_completed_streams": True,
        },
    )
    assert saved.status_code == 200
    out = saved.json()
    assert out["configured"] is True
    assert out["enabled"] is True
    assert out["previous_mode"] == "count"
    assert out["previous_count"] == 7
    assert out["quality_preset"] == "720p"
    assert out["include_completed_streams"] is True

    off = client.put(
        "/api/channels/autodownload",
        json={
            "url": LTT,
            "enabled": False,
            "previous_mode": "count",
            "previous_count": 7,
            "quality_preset": "720p",
            "include_completed_streams": True,
        },
    )
    assert off.status_code == 200
    assert off.json()["enabled"] is False
    assert off.json()["previous_count"] == 7


def test_autodownload_api_rejects_non_youtube(client):
    bad = client.get(
        "/api/channels/autodownload",
        params={"url": "https://vimeo.com/channels/staffpicks"},
    )
    assert bad.status_code == 400


def test_create_download_rejects_shorts_url(client, monkeypatch):
    from app.services import downloader

    monkeypatch.setattr(
        downloader,
        "extract_preview",
        lambda url: {"id": "shorturl111", "title": "Reel", "duration": 12},
    )
    resp = client.post(
        "/api/downloads",
        json={"url": "https://www.youtube.com/shorts/shorturl111"},
    )
    assert resp.status_code == 400
    assert "Shorts" in resp.json()["detail"]


def test_create_download_rejects_short_watch_url(client, monkeypatch):
    from app.services import downloader

    monkeypatch.setattr(
        downloader,
        "extract_preview",
        lambda url: {
            "id": "talkshort01",
            "title": "Quick tip",
            "duration": 22,
            "url": url,
            "published_at": "2024-01-01",
        },
    )
    resp = client.post(
        "/api/downloads",
        json={"url": "https://www.youtube.com/watch?v=talkshort01"},
    )
    assert resp.status_code == 400
    assert "Shorts" in resp.json()["detail"]


def test_normalize_helpers():
    assert ad.normalize_previous_count(0) == 1
    assert ad.normalize_previous_count(9999) == 500
    assert ad.normalize_quality_preset("nope") == "1080p"
    assert ad.normalize_quality_preset("2160p") == "2160p"
    assert ad.normalize_previous_mode("ALL") == "all"
    assert ad.normalize_previous_mode("weird") == "none"

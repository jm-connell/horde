"""``videos.live_status``: whether a library video was a livestream (chat replay)."""

from __future__ import annotations

from sqlalchemy import text
from sqlmodel import Session

from app.models import Video

VID = "abcdefghijk"


def test_revision_backfills_live_status_from_the_channel_video_list(tmp_dirs):
    from alembic import command

    from app.database import init_db
    from app.migrations.runner import alembic_config
    from tests.test_database_migrate import _insert_video

    engine = tmp_dirs["engine"]
    command.upgrade(alembic_config(engine), "0035_kb_keep_indexed_videos")
    with engine.begin() as conn:
        _insert_video(
            conn,
            1,
            "Past stream",
            "[]",
            "a/one.mp4",
            f"https://www.youtube.com/watch?v={VID}",
            youtube_id=VID,
        )
        _insert_video(
            conn,
            2,
            "Not listed",
            "[]",
            "a/two.mp4",
            "https://www.youtube.com/watch?v=zzzzzzzzzzz",
            youtube_id="zzzzzzzzzzz",
        )
        conn.execute(
            text(
                "INSERT INTO channel_catalogs (id, channel_url, status, indexed_count, "
                "complete, max_videos, updated_at) VALUES "
                "(1, 'https://www.youtube.com/@a', 'idle', 1, 0, 1000, "
                "'2024-01-01 00:00:00')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO channel_catalog_videos (catalog_id, yt_id, url, live_status, "
                "position, indexed_at) VALUES (1, :id, 'u', 'was_live', 0, "
                "'2024-01-01 00:00:00')"
            ),
            {"id": VID},
        )

    init_db()

    with engine.connect() as conn:
        rows = dict(conn.execute(text("SELECT id, live_status FROM videos")).fetchall())
    assert rows == {1: "was_live", 2: None}


def test_finalize_records_live_status(session, add_video):
    from app.services.downloads.finalize import _apply_remote_metadata

    video = add_video()
    _apply_remote_metadata(session, video, {"live_status": "was_live"}, False)
    assert video.live_status == "was_live"
    _apply_remote_metadata(session, video, {"was_live": True}, False)
    assert video.live_status == "was_live"
    _apply_remote_metadata(session, video, {"live_status": "not_live"}, False)
    assert video.live_status == "not_live"


def test_metadata_refresh_records_live_status(monkeypatch, session, add_video):
    from app.services import metadata_sync

    video = add_video(source_url=f"https://www.youtube.com/watch?v={VID}")
    video_id = video.id
    monkeypatch.setattr(
        metadata_sync,
        "_extract_metadata",
        lambda url: {"title": video.title, "live_status": "was_live"},
    )
    metadata_sync.refresh_video_metadata(video_id, fields=["thumbnails"])
    with Session(session.get_bind()) as fresh:
        assert fresh.get(Video, video_id).live_status == "was_live"


def test_video_read_carries_live_status(client, session, add_video):
    video = add_video(live_status="was_live")
    body = client.get(f"/api/videos/{video.id}").json()
    assert body["live_status"] == "was_live"


def test_preview_meta_tells_past_streams_from_ones_still_processing(monkeypatch):
    from app.services import stream_preview

    monkeypatch.setattr(
        stream_preview,
        "_extract_preview_info",
        lambda url: {"id": VID, "title": "x", "live_status": "post_live"},
    )
    meta = stream_preview.extract_stream_preview_meta(
        f"https://www.youtube.com/watch?v={VID}"
    )
    # was_live stays true for both; live_status tells them apart.
    assert meta["was_live"] is True
    assert meta["live_status"] == "post_live"


def test_preview_meta_api_passes_live_status(client, monkeypatch):
    monkeypatch.setattr(
        "app.services.stream_preview.extract_stream_preview_meta",
        lambda url: {
            "id": VID,
            "title": "x",
            "was_live": True,
            "live_status": "was_live",
        },
    )
    resp = client.get(
        "/api/preview/meta", params={"url": f"https://www.youtube.com/watch?v={VID}"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["live_status"] == "was_live"

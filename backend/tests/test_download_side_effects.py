"""What a finished download sets in motion in the rest of the app.

The callers of these hooks swallow their errors (a failed AI queueing must not
fail the download), so a broken call would otherwise go unnoticed.
"""

from __future__ import annotations

import threading

import pytest
from sqlmodel import Session, select
from ytdlp_fakes import (
    FakeYtdlp,
    make_info,
    record_side_effects,
    run_job_inline,
    stub_media_probes,
)

from app.models import DownloadJob, JobStatus, Video
from app.services import downloader

YT = "sideeffect01"
URL = f"https://www.youtube.com/watch?v={YT}"
CHANNEL_URL = "https://www.youtube.com/@chan"


@pytest.fixture
def fake(init_db, monkeypatch):
    f = FakeYtdlp()
    f.install(monkeypatch, downloader)
    stub_media_probes(monkeypatch, downloader)
    f.add(
        URL,
        make_info(
            YT,
            "Clip",
            uploader="Chan",
            uploader_url=CHANNEL_URL,
            thumbnail="https://i.ytimg.com/vi/x/maxres.jpg",
        ),
    )
    return f


def _only_video(init_db) -> Video:
    with Session(init_db["engine"]) as s:
        return s.exec(select(Video)).one()


def test_a_finished_download_queues_indexing_catalog_and_finalize(
    init_db, fake, monkeypatch
):
    fx = record_side_effects(monkeypatch, downloader)
    monkeypatch.setattr(
        downloader,
        "_finalize_in_background",
        lambda *args, **_kw: fx.finalize.append(args),
    )
    with Session(init_db["engine"]) as s:
        job = DownloadJob(url=URL, quality_preset="best", status=JobStatus.queued)
        s.add(job)
        s.commit()
        job_id = job.id
    run_job_inline(downloader, job_id)

    video = _only_video(init_db)
    assert fx.ai == [(video.id, {"include_tags": True, "force": False})]
    assert fx.catalog == [(CHANNEL_URL, {"channel_name": "Chan", "force": False})]
    ((video_id, path, source_url, thumb, list_thumb),) = fx.finalize
    assert (video_id, source_url) == (video.id, URL)
    assert path == init_db["downloads"] / video.file_path
    assert thumb == "https://i.ytimg.com/vi/x/maxres.jpg"
    assert list_thumb


def test_background_finalize_fetches_subtitles_and_thumbnail_then_queues_work(
    init_db, add_video, monkeypatch
):
    fx = record_side_effects(monkeypatch, downloader)
    video = add_video(write_file=True)
    media = init_db["downloads"] / video.file_path

    downloader._finalize_in_background(
        video.id,
        media,
        URL,
        "https://thumb.example/a.jpg",
        "https://thumb.example/l.jpg",
    )
    for thread in threading.enumerate():
        if thread.name == f"finalize-{video.id}":
            thread.join(10)

    assert fx.subtitles == [(media, URL)]
    assert fx.thumbnails == [
        ("https://thumb.example/a.jpg", video.id, "https://thumb.example/l.jpg")
    ]
    assert fx.ai == [(video.id, {"include_tags": False, "force": False})]
    assert fx.sprites == [video.id]
    with Session(init_db["engine"]) as s:
        assert s.get(Video, video.id).thumbnail_path == f"{video.id}.jpg"


def test_subtitle_fetch_for_a_missing_file_is_retryable(tmp_path):
    outcome = downloader.download_subtitles(tmp_path / "gone.mp4", URL)
    assert outcome.retryable is True
    assert outcome.tracks == []

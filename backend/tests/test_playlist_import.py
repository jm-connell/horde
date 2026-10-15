"""Playlist import enqueues ordinary jobs and attaches them in playlist order."""

from __future__ import annotations

import time

import pytest
from sqlmodel import Session, select
from ytdlp_fakes import FakeYtdlp, make_info, run_job_inline, stub_media_probes

from app.models import DownloadJob, JobStatus, Playlist, PlaylistItem
from app.services import downloader


def _url(n: int) -> str:
    return f"https://www.youtube.com/watch?v=pppppppp{n:03d}"


@pytest.fixture
def queued_only(monkeypatch):
    """Jobs are created but not run: the import itself must not block."""
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    monkeypatch.setattr(
        "app.services.job_metadata.request_job_metadata", lambda *_a: None
    )


@pytest.fixture
def playlist(init_db):
    with Session(init_db["engine"]) as s:
        pl = Playlist(name="Mix")
        s.add(pl)
        s.commit()
        return pl.id


def _order(init_db, playlist_id) -> list[int]:
    with Session(init_db["engine"]) as s:
        rows = s.exec(
            select(PlaylistItem)
            .where(PlaylistItem.playlist_id == playlist_id)
            .order_by(PlaylistItem.position)
        ).all()
        return [r.video_id for r in rows]


def _finish(init_db, job_id: int, video_id: int) -> None:
    downloader._update_job(
        job_id, status=JobStatus.completed, video_id=video_id, progress=100.0
    )
    downloader._attach_download_to_playlist(job_id, video_id)


def test_import_returns_immediately_and_tags_jobs_with_playlist(
    init_db, playlist, add_video, queued_only
):
    lib = add_video(yt_id="pppppppp001", title="Already here")
    started = time.monotonic()
    downloader.run_playlist_entries(playlist, [_url(1), _url(2), _url(3)], "720p")
    assert time.monotonic() - started < 5  # the old code polled forever

    with Session(init_db["engine"]) as s:
        jobs = s.exec(select(DownloadJob).order_by(DownloadJob.id)).all()
    assert [j.url for j in jobs] == [_url(2), _url(3)]
    assert all(j.playlist_id == playlist and j.quality_preset == "720p" for j in jobs)
    assert _order(init_db, playlist) == [lib.id]


def test_jobs_honour_a_paused_queue(init_db, playlist, queued_only):
    downloader.download_queue._global_paused = True
    try:
        downloader.run_playlist_entries(playlist, [_url(1)], "best")
    finally:
        downloader.download_queue._global_paused = False
    with Session(init_db["engine"]) as s:
        assert s.exec(select(DownloadJob)).one().paused is True


def test_out_of_order_completion_keeps_playlist_order(
    init_db, playlist, add_video, queued_only
):
    # Remote order: lib0, job1, lib2, job3, job4
    lib0 = add_video(yt_id="pppppppp000", title="L0")
    lib2 = add_video(yt_id="pppppppp002", title="L2")
    downloader.run_playlist_entries(
        playlist, [_url(0), _url(1), _url(2), _url(3), _url(4)], "best"
    )
    with Session(init_db["engine"]) as s:
        j1, j3, j4 = (
            j.id for j in s.exec(select(DownloadJob).order_by(DownloadJob.id)).all()
        )
    v1 = add_video(yt_id="pppppppp001", title="V1", file_path="a/v1.mp4")
    v3 = add_video(yt_id="pppppppp003", title="V3", file_path="a/v3.mp4")
    v4 = add_video(yt_id="pppppppp004", title="V4", file_path="a/v4.mp4")

    # They finish in the opposite order.
    _finish(init_db, j4, v4.id)
    _finish(init_db, j3, v3.id)
    _finish(init_db, j1, v1.id)

    assert _order(init_db, playlist) == [lib0.id, v1.id, lib2.id, v3.id, v4.id]


def test_failed_entry_does_not_block_later_ones(
    init_db, playlist, add_video, queued_only
):
    downloader.run_playlist_entries(playlist, [_url(1), _url(2)], "best")
    with Session(init_db["engine"]) as s:
        j1, j2 = (
            j.id for j in s.exec(select(DownloadJob).order_by(DownloadJob.id)).all()
        )
    downloader._update_job(j1, status=JobStatus.error)
    v2 = add_video(yt_id="pppppppp002", title="V2", file_path="a/v2.mp4")
    _finish(init_db, j2, v2.id)
    assert _order(init_db, playlist) == [v2.id]


def test_active_job_for_the_same_video_is_reused(init_db, playlist, queued_only):
    with Session(init_db["engine"]) as s:
        s.add(DownloadJob(url=_url(1), status=JobStatus.queued))
        s.commit()
    downloader.run_playlist_entries(playlist, [_url(1)], "best")
    with Session(init_db["engine"]) as s:
        job = s.exec(select(DownloadJob)).one()
    assert job.playlist_id == playlist


def test_items_not_on_the_remote_list_stay_after_it(
    init_db, playlist, add_video, queued_only
):
    mine = add_video(title="Mine")
    lib = add_video(yt_id="pppppppp001", title="Remote")
    with Session(init_db["engine"]) as s:
        s.add(PlaylistItem(playlist_id=playlist, video_id=mine.id, position=0))
        s.commit()
    downloader.run_playlist_entries(playlist, [_url(1), _url(2)], "best")
    assert _order(init_db, playlist) == [lib.id, mine.id]


def test_download_completion_attaches_to_playlist_end_to_end(
    init_db, playlist, monkeypatch
):
    """Persisted playlist_id is all a restarted server needs to attach on completion."""
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    monkeypatch.setattr(
        "app.services.job_metadata.request_job_metadata", lambda *_a: None
    )
    fake = FakeYtdlp()
    fake.install(monkeypatch, downloader)
    stub_media_probes(monkeypatch, downloader)
    fake.add(_url(7), make_info("pppppppp007", "Seven"))
    downloader.run_playlist_entries(playlist, [_url(7)], "best")
    with Session(init_db["engine"]) as s:
        job_id = s.exec(select(DownloadJob)).one().id

    run_job_inline(downloader, job_id)

    with Session(init_db["engine"]) as s:
        video_id = s.get(DownloadJob, job_id).video_id
    assert video_id is not None
    assert _order(init_db, playlist) == [video_id]

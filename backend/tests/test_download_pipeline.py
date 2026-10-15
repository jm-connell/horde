"""Whole-job behaviour of the download pipeline, driven with a fake yt-dlp.

These tests pin what a download does from the queue to the library row, so the
code behind ``downloader`` can be reorganised without changing it. They go
through the public queue (``download_queue``/``ffmpeg_queue``) wherever the
scenario is about scheduling (cancel, pause/resume) and through
``run_job_inline`` where it is about the outcome of one run.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest
from sqlmodel import Session, select
from ytdlp_fakes import FakeYtdlp, make_info, run_job_inline, stub_media_probes

from app.models import DownloadDestination, DownloadJob, JobStatus, Video
from app.services import downloader, ytdlp_common
from app.services.downloads import errors, progress
from app.services.paths import STAGING_DIR_NAME
from app.services.ytdlp_common import (
    ERROR_KIND_CANCELLED,
    ERROR_KIND_MEMBERS,
    ERROR_KIND_UNKNOWN,
)

YT = "pipeline001"
URL = f"https://www.youtube.com/watch?v={YT}"


@pytest.fixture
def fake(init_db, monkeypatch):
    f = FakeYtdlp()
    f.install(monkeypatch, downloader)
    stub_media_probes(monkeypatch, downloader)
    f.add(URL, make_info(YT, "Clip", uploader="Chan"))
    return f


def _add_job(init_db, url: str = URL, **fields) -> int:
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url=url, quality_preset="best", status=JobStatus.queued, **fields
        )
        s.add(job)
        s.commit()
        return job.id


def _job(init_db, job_id: int) -> DownloadJob | None:
    with Session(init_db["engine"]) as s:
        return s.get(DownloadJob, job_id)


def _videos(init_db) -> list[Video]:
    with Session(init_db["engine"]) as s:
        return list(s.exec(select(Video)).all())


def _wait(condition: Callable[[], bool], what: str, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, f"timed out waiting for {what}"
        time.sleep(0.02)


def _wait_idle(job_id: int) -> None:
    """The download thread and any ffmpeg stage of the job have ended."""
    _wait(lambda: not downloader.download_queue.is_running(job_id), "job to stop")


def _staging(init_db, job_id: int) -> Path:
    return init_db["downloads"] / STAGING_DIR_NAME / str(job_id)


def test_queue_runs_a_new_download_to_a_library_video(init_db, fake):
    job_id = _add_job(init_db)
    downloader.download_queue.enqueue(job_id)
    _wait(
        lambda: _job(init_db, job_id).status == JobStatus.completed,
        "download to complete",
    )
    _wait_idle(job_id)

    (video,) = _videos(init_db)
    job = _job(init_db, job_id)
    assert job.video_id == video.id
    assert (video.title, video.channel) == ("Clip", "Chan")
    assert (init_db["downloads"] / video.file_path).is_file()
    assert not _staging(init_db, job_id).exists()
    snap = progress.progress_store[job_id]
    assert (snap["status"], snap["video_id"]) == ("completed", video.id)


def test_cookie_gate_retries_once_with_cookies(init_db, fake, monkeypatch, tmp_path):
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("# Netscape HTTP Cookie File\n")
    monkeypatch.setattr(ytdlp_common, "YTDLP_COOKIE_FILE", cookies)
    monkeypatch.setattr(ytdlp_common, "_cookie_required_until", {})
    calls: list[int] = []

    def gate_first_attempt(_path, _info):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError(
                "Sign in to confirm your age. This video may be inappropriate"
            )

    fake.before_merge = gate_first_attempt
    job_id = _add_job(init_db)
    run_job_inline(downloader, job_id)

    assert _job(init_db, job_id).status == JobStatus.completed
    first, second = (d["opts"] for d in fake.downloads)
    assert "cookiefile" not in first
    assert second["cookiefile"] == str(cookies)
    assert ytdlp_common.url_cookie_required(URL)


def test_failed_format_falls_back_to_the_next_selector(init_db, fake):
    from app.services.ytdlp_formats import format_chain

    calls: list[int] = []

    def first_selector_unavailable(_path, _info):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("Requested format is not available")

    fake.before_merge = first_selector_unavailable
    job_id = _add_job(init_db)
    run_job_inline(downloader, job_id)

    chain = format_chain("best", "av1")
    assert [d["opts"]["format"] for d in fake.downloads] == chain[:2]
    assert _job(init_db, job_id).status == JobStatus.completed
    assert len(_videos(init_db)) == 1


def test_every_selector_failing_ends_the_job_in_error(init_db, fake):
    def always(_path, _info):
        raise RuntimeError("HTTP Error 500")

    fake.before_merge = always
    job_id = _add_job(init_db)
    run_job_inline(downloader, job_id)

    job = _job(init_db, job_id)
    assert job.status == JobStatus.error
    assert job.error_kind == ERROR_KIND_UNKNOWN
    assert job.error
    assert progress.progress_store[job_id]["status"] == "error"
    assert _videos(init_db) == []
    assert not _staging(init_db, job_id).exists()


def test_postprocessor_error_after_the_merge_still_completes(init_db, fake):
    fake.fail_after_merge = RuntimeError("Postprocessing: Unable to rename file")
    job_id = _add_job(init_db)
    run_job_inline(downloader, job_id)

    assert _job(init_db, job_id).status == JobStatus.completed
    (video,) = _videos(init_db)
    assert (init_db["downloads"] / video.file_path).stat().st_size == fake.merged_bytes


def test_cancel_during_download_ends_cancelled_and_clean(init_db, fake):
    job_id = _add_job(init_db)
    in_merge = threading.Event()

    def wait_for_cancel(_path, _info):
        in_merge.set()
        downloader.download_queue.cancel_event(job_id).wait(10)
        raise errors.DownloadCancelled()

    fake.before_merge = wait_for_cancel
    downloader.download_queue.enqueue(job_id)
    assert in_merge.wait(10)
    assert downloader.download_queue.cancel_job(job_id) is True
    _wait_idle(job_id)

    job = _job(init_db, job_id)
    assert (job.status, job.error_kind) == (JobStatus.cancelled, ERROR_KIND_CANCELLED)
    assert _videos(init_db) == []
    assert not _staging(init_db, job_id).exists()
    assert progress.progress_store[job_id]["status"] == "cancelled"


def test_pause_requeues_the_job_and_resume_finishes_it(init_db, fake):
    job_id = _add_job(init_db)
    in_merge = threading.Event()

    def wait_for_pause(_path, _info):
        in_merge.set()
        downloader.download_queue.cancel_event(job_id).wait(10)
        raise errors.DownloadCancelled()

    fake.before_merge = wait_for_pause
    downloader.download_queue.enqueue(job_id)
    assert in_merge.wait(10)
    try:
        downloader.download_queue.pause_all()
        _wait_idle(job_id)

        job = _job(init_db, job_id)
        assert (job.status, job.paused) == (JobStatus.queued, True)
        # The staging dir stays for the resume (only a finished, failed or
        # cancelled job drops it); a pause itself discards the partial fragments.
        assert _staging(init_db, job_id).is_dir()
        assert progress.progress_store[job_id]["status"] == "queued"
    finally:
        fake.before_merge = None
        downloader.download_queue.resume_all()
    _wait(
        lambda: _job(init_db, job_id).status == JobStatus.completed,
        "resumed download to complete",
    )
    _wait_idle(job_id)
    assert not _job(init_db, job_id).paused
    assert len(_videos(init_db)) == 1


def test_device_download_stays_out_of_the_library(init_db, fake):
    job_id = _add_job(init_db, destination=DownloadDestination.device.value)
    run_job_inline(downloader, job_id)

    job = _job(init_db, job_id)
    assert job.status == JobStatus.completed
    assert job.video_id is None
    assert job.device_file_path.startswith(f"_device/{job_id}/")
    assert (init_db["downloads"] / job.device_file_path).is_file()
    assert _videos(init_db) == []
    snap = progress.progress_store[job_id]
    assert (snap["status"], snap["destination"]) == ("completed", "device")


def test_unplayable_download_ends_in_error_and_leaves_no_files(
    init_db, fake, monkeypatch
):
    stub_media_probes(monkeypatch, downloader, playable=False)
    job_id = _add_job(init_db)
    run_job_inline(downloader, job_id)

    assert _job(init_db, job_id).status == JobStatus.error
    assert _videos(init_db) == []
    leftovers = [
        p
        for p in init_db["downloads"].rglob("*")
        if p.is_file()
        and STAGING_DIR_NAME not in p.relative_to(init_db["downloads"]).parts
    ]
    assert leftovers == []
    assert not _staging(init_db, job_id).exists()


def test_members_only_video_is_reported_not_retried(init_db, fake, monkeypatch):
    purged: list[str] = []
    monkeypatch.setattr(
        "app.services.channel_catalog.skips.purge_members_only_by_yt_id", purged.append
    )
    fake.fetch_error = RuntimeError(
        "ERROR: [youtube] x: Join this channel to get access to members-only content"
    )
    job_id = _add_job(init_db)
    run_job_inline(downloader, job_id)

    job = _job(init_db, job_id)
    assert (job.status, job.error_kind) == (JobStatus.error, ERROR_KIND_MEMBERS)
    assert fake.downloads == []
    assert purged == [YT]
    assert progress.progress_store[job_id]["error_kind"] == ERROR_KIND_MEMBERS


def test_shorts_are_skipped_and_their_job_row_removed(init_db, fake):
    short_url = "https://www.youtube.com/shorts/shortvid001"
    fake.add(short_url, make_info("shortvid001", "Tiny", duration=20))
    job_id = _add_job(init_db, url=short_url)
    run_job_inline(downloader, job_id)

    assert _job(init_db, job_id) is None
    assert progress.progress_store[job_id] == {
        "status": "skipped",
        "reason": "shorts",
        "url": short_url,
    }
    assert fake.downloads == []
    assert _videos(init_db) == []

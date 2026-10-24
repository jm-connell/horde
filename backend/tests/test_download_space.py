"""Disk limits for downloads: the library size limit, the free-space floor and a full disk."""

from __future__ import annotations

import errno
import shutil
import time
from collections import namedtuple

import pytest
from sqlmodel import Session
from ytdlp_fakes import FakeYtdlp, make_info, run_job_inline, stub_media_probes

from app import config
from app.models import DownloadDestination, DownloadJob, JobStatus
from app.services import app_settings
from app.services.downloads import progress, runner, space
from app.services.downloads.queue import DownloadQueue, download_queue
from app.services.ytdlp_common import (
    ERROR_KIND_DISK_FULL,
    ERROR_KIND_UNKNOWN,
    classify_ytdlp_error,
)

GB = 1024**3
URL = "https://www.youtube.com/watch?v=space000001"
Usage = namedtuple("Usage", "total used free")


@pytest.fixture(autouse=True)
def _fresh_shared_queue():
    """The process-wide queue keeps holds, size hints and a full-disk mark; start and end clean."""
    download_queue.reset()
    yield
    download_queue.reset()


def _add_job(init_db, **fields) -> int:
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url=fields.pop("url", URL),
            quality_preset="best",
            status=fields.pop("status", JobStatus.queued),
            **fields,
        )
        s.add(job)
        s.commit()
        return job.id


def _job(init_db, job_id: int) -> DownloadJob:
    with Session(init_db["engine"]) as s:
        job = s.get(DownloadJob, job_id)
        assert job is not None
        return job


@pytest.fixture
def queue(init_db, monkeypatch) -> DownloadQueue:
    """A queue that only answers "which job next"; nothing is dispatched."""
    monkeypatch.setattr(DownloadQueue, "_dispatch", lambda self: None)
    return DownloadQueue()


@pytest.fixture
def library_size(monkeypatch):
    """Control the measured library size; ``size["bytes"]`` is what the gate sees."""
    size = {"bytes": 0}
    monkeypatch.setattr(space.SpaceGate, "library_bytes", lambda self: size["bytes"])
    return size


@pytest.fixture
def free_space(monkeypatch):
    """Control the free space on the downloads volume; ``free["bytes"]`` is what the gate sees."""
    free = {"bytes": 500 * GB}
    monkeypatch.setattr(
        shutil, "disk_usage", lambda _p: Usage(1000 * GB, 0, free["bytes"])
    )
    return free


def _set_limit(gb: float | None) -> None:
    app_settings.save({"max_library_bytes": int(gb * GB) if gb else None})


# -- the library size limit -----------------------------------------------------


def test_without_a_limit_nothing_is_held(queue, init_db, library_size, free_space):
    library_size["bytes"] = 900 * GB
    job_id = _add_job(init_db)
    assert queue._next_job_id() == job_id
    assert queue.space_hold() is None


def test_job_is_held_while_the_library_is_at_its_limit(
    queue, init_db, library_size, free_space
):
    _set_limit(55)
    library_size["bytes"] = 55 * GB
    job_id = _add_job(init_db)

    assert queue._next_job_id() is None
    assert queue.held_reason(job_id) == "Paused: library is at its 55 GB limit"
    hold = queue.space_hold()
    assert hold is not None and hold.code == "library_full"
    # Held is not failed: the job stays queued and its card hears about it.
    assert _job(init_db, job_id).status == JobStatus.queued
    assert (
        progress.progress_store[job_id]["held_reason"]
        == "Paused: library is at its 55 GB limit"
    )

    library_size["bytes"] = 40 * GB
    assert queue._next_job_id() == job_id
    assert queue.held_reason(job_id) is None
    assert queue.space_hold() is None
    assert progress.progress_store[job_id]["held_reason"] is None


def test_a_job_that_would_cross_the_limit_is_held(
    queue, init_db, library_size, free_space
):
    _set_limit(10)
    library_size["bytes"] = 6 * GB
    job_id = _add_job(init_db)
    queue._size_hints[job_id] = 5 * GB

    assert queue._next_job_id() is None
    hold = queue.space_hold()
    assert hold is not None and hold.code == "would_exceed"
    assert "10 GB" in hold.reason

    queue._size_hints[job_id] = 3 * GB
    assert queue._next_job_id() == job_id


def test_a_device_download_ignores_the_library_limit(
    queue, init_db, library_size, free_space
):
    _set_limit(10)
    library_size["bytes"] = 10 * GB
    library_job = _add_job(init_db)
    device_job = _add_job(init_db, destination=DownloadDestination.device.value)

    # The library job is first in line but waits; the device job goes ahead of it.
    assert queue._next_job_id() == device_job
    assert queue.held_reason(library_job) is not None
    assert queue.held_reason(device_job) is None


def test_the_limit_is_in_gigabytes_with_a_fraction(
    queue, init_db, library_size, free_space
):
    _set_limit(2.5)
    library_size["bytes"] = 3 * GB
    job_id = _add_job(init_db)
    assert queue._next_job_id() is None
    assert queue.held_reason(job_id) == "Paused: library is at its 2.5 GB limit"


# -- the free-space floor ---------------------------------------------------------


def test_job_is_held_below_the_free_space_floor(
    queue, init_db, library_size, free_space, monkeypatch
):
    monkeypatch.setattr(config, "MIN_FREE_GB", 2.0)
    free_space["bytes"] = GB
    library_job = _add_job(init_db)

    assert queue._next_job_id() is None
    assert queue.held_reason(library_job) == "Paused: less than 2 GB free on disk"
    hold = queue.space_hold()
    assert hold is not None and hold.code == "low_disk"

    free_space["bytes"] = 3 * GB
    assert queue._next_job_id() == library_job


def test_the_floor_holds_device_downloads_too(
    queue, init_db, library_size, free_space, monkeypatch
):
    monkeypatch.setattr(config, "MIN_FREE_GB", 2.0)
    free_space["bytes"] = GB
    device_job = _add_job(init_db, destination=DownloadDestination.device.value)
    assert queue._next_job_id() is None
    assert queue.held_reason(device_job) is not None


def test_a_floor_of_zero_turns_the_check_off(
    queue, init_db, library_size, free_space, monkeypatch
):
    monkeypatch.setattr(config, "MIN_FREE_GB", 0.0)
    free_space["bytes"] = 0
    job_id = _add_job(init_db)
    assert queue._next_job_id() == job_id


# -- a full disk ------------------------------------------------------------------


def test_a_full_disk_holds_the_queue_until_room_is_made(
    queue, init_db, library_size, free_space
):
    job_id = _add_job(init_db)
    queue.note_disk_full()
    assert queue._next_job_id() is None
    hold = queue.space_hold()
    assert hold is not None and hold.code == "disk_full"

    queue.library_changed(room_made=True)
    assert queue._next_job_id() == job_id


def test_the_full_disk_hold_ends_by_itself_after_a_while(
    init_db, library_size, free_space
):
    now = {"t": 1000.0}
    gate = space.SpaceGate(clock=lambda: now["t"])
    gate.note_disk_full()
    assert gate.check("library") is not None
    now["t"] += space.DISK_FULL_COOLDOWN_SECONDS + 1
    assert gate.check("library") is None


@pytest.mark.parametrize(
    "error",
    [
        OSError(errno.ENOSPC, "No space left on device"),
        OSError(errno.EDQUOT, "Disk quota exceeded"),
        RuntimeError(
            "ERROR: unable to download video data: [Errno 28] No space left on device"
        ),
        RuntimeError("Error opening output file x.mp4: No space left on device"),
    ],
)
def test_out_of_space_errors_are_classified_as_disk_full(error):
    kind, message = classify_ytdlp_error(error)
    assert kind == ERROR_KIND_DISK_FULL
    assert "disk is full" in message


def test_the_cause_of_an_error_counts(init_db):
    try:
        try:
            raise OSError(errno.ENOSPC, "No space left on device")
        except OSError as inner:
            raise RuntimeError("download failed") from inner
    except RuntimeError as wrapped:
        assert classify_ytdlp_error(wrapped)[0] == ERROR_KIND_DISK_FULL
    assert classify_ytdlp_error(RuntimeError("boom"))[0] == ERROR_KIND_UNKNOWN


# -- through the real pipeline --------------------------------------------------


@pytest.fixture
def fake(init_db, monkeypatch):
    f = FakeYtdlp()
    f.install(monkeypatch)
    stub_media_probes(monkeypatch)
    f.add(URL, make_info("space000001", "Clip"))
    return f


def _wait(condition, what: str, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, f"timed out waiting for {what}"
        time.sleep(0.02)


def test_a_held_job_starts_by_itself_once_there_is_room(
    init_db, fake, library_size, free_space
):
    _set_limit(10)
    library_size["bytes"] = 10 * GB
    job_id = _add_job(init_db)

    download_queue.enqueue(job_id)
    time.sleep(0.2)
    assert _job(init_db, job_id).status == JobStatus.queued
    assert fake.downloads == []
    assert download_queue.held_reason(job_id) == "Paused: library is at its 10 GB limit"

    library_size["bytes"] = 1 * GB
    download_queue.recheck_holds()
    _wait(lambda: _job(init_db, job_id).status == JobStatus.completed, "the download")
    _wait(lambda: not download_queue.is_running(job_id), "the job to stop")
    assert download_queue.space_hold() is None


def test_raising_the_limit_releases_held_jobs(init_db, fake, library_size, free_space):
    _set_limit(10)
    library_size["bytes"] = 10 * GB
    job_id = _add_job(init_db)
    download_queue.enqueue(job_id)
    assert download_queue.space_hold() is not None

    _set_limit(20)
    download_queue.library_changed(room_made=True)
    _wait(lambda: _job(init_db, job_id).status == JobStatus.completed, "the download")
    _wait(lambda: not download_queue.is_running(job_id), "the job to stop")


def test_a_video_too_big_for_the_limit_goes_back_to_the_queue(
    init_db, fake, library_size, free_space, monkeypatch
):
    _set_limit(10)
    library_size["bytes"] = 6 * GB
    monkeypatch.setattr(
        runner, "estimate_download_bytes", lambda _info, _preset: 5 * GB
    )
    job_id = _add_job(init_db)

    run_job_inline(job_id)

    job = _job(init_db, job_id)
    assert (job.status, job.error, job.error_kind) == (JobStatus.queued, None, None)
    assert fake.downloads == []
    assert download_queue.held_reason(job_id) is None  # the queue has not looked yet
    reason = progress.progress_store[job_id]["held_reason"]
    assert "would not fit in the 10 GB library limit" in reason

    # The size is remembered, so the queue keeps it waiting without trying again.
    assert download_queue._next_job_id() is None
    assert download_queue.space_hold() is not None
    library_size["bytes"] = 4 * GB
    assert download_queue._next_job_id() == job_id


def test_running_out_of_disk_fails_the_job_and_holds_the_queue(
    init_db, fake, library_size, free_space
):
    def disk_fills_up(_path, _info):
        raise OSError(errno.ENOSPC, "No space left on device")

    fake.before_merge = disk_fills_up
    job_id = _add_job(init_db)
    next_job = _add_job(init_db)

    run_job_inline(job_id)

    job = _job(init_db, job_id)
    assert (job.status, job.error_kind) == (JobStatus.error, ERROR_KIND_DISK_FULL)
    assert "disk is full" in (job.error or "")
    assert progress.progress_store[job_id]["error_kind"] == ERROR_KIND_DISK_FULL
    # Only one format was tried: the others would need the same space.
    assert len(fake.downloads) == 1
    # The next job waits instead of failing the same way.
    assert download_queue._next_job_id() is None
    assert download_queue.held_reason(next_job) == "Paused: the disk ran out of space"
    assert _job(init_db, next_job).status == JobStatus.queued


def test_yt_dlp_reporting_a_full_disk_through_its_logger_is_caught(
    init_db, fake, library_size, free_space, monkeypatch
):
    # With ignoreerrors yt-dlp logs the failure and carries on instead of raising.
    # (The fake leaves a whole file behind; a real full disk leaves a truncated one.)
    monkeypatch.setattr(
        runner.DownloadRun, "_hand_off_recovered_file", lambda _self: False
    )
    fake.log_error = (
        "ERROR: unable to download video data: [Errno 28] No space left on device"
    )
    job_id = _add_job(init_db)
    run_job_inline(job_id)
    assert _job(init_db, job_id).error_kind == ERROR_KIND_DISK_FULL


# -- the API ------------------------------------------------------------------------


def test_the_limit_round_trips_and_clears(client):
    assert client.get("/api/settings").json()["max_library_bytes"] is None

    patched = client.patch("/api/settings", json={"max_library_bytes": 55 * GB})
    assert patched.status_code == 200
    assert patched.json()["max_library_bytes"] == 55 * GB
    assert client.get("/api/settings").json()["max_library_bytes"] == 55 * GB

    # Other saves leave it alone; null and 0 both mean "no limit".
    client.patch("/api/settings", json={"progress_expiry_days": 30})
    assert client.get("/api/settings").json()["max_library_bytes"] == 55 * GB
    assert (
        client.patch("/api/settings", json={"max_library_bytes": 0}).json()[
            "max_library_bytes"
        ]
        is None
    )
    client.patch("/api/settings", json={"max_library_bytes": 55 * GB})
    cleared = client.patch("/api/settings", json={"max_library_bytes": None})
    assert cleared.json()["max_library_bytes"] is None


def test_a_tiny_limit_is_raised_to_one_gigabyte(client):
    out = client.patch("/api/settings", json={"max_library_bytes": 1000}).json()
    assert out["max_library_bytes"] == GB


def test_a_negative_limit_is_refused(client):
    assert (
        client.patch("/api/settings", json={"max_library_bytes": -1}).status_code == 422
    )


def test_a_member_cannot_set_the_limit_and_does_not_see_it(client, member_client):
    client.patch("/api/settings", json={"max_library_bytes": 55 * GB})

    refused = member_client.patch("/api/settings", json={"max_library_bytes": GB * 5})
    assert refused.status_code == 403
    assert refused.json()["code"] == "admin_required"
    assert (
        member_client.patch(
            "/api/settings", json={"max_library_bytes": None}
        ).status_code
        == 403
    )
    assert member_client.get("/api/settings").json()["max_library_bytes"] is None
    assert client.get("/api/settings").json()["max_library_bytes"] == 55 * GB


def test_changing_the_limit_wakes_the_queue(client, monkeypatch):
    calls: list[bool] = []
    monkeypatch.setattr(
        DownloadQueue,
        "library_changed",
        lambda self, *, room_made=False: calls.append(room_made),
    )
    client.patch("/api/settings", json={"progress_expiry_days": 30})
    assert calls == []
    client.patch("/api/settings", json={"max_library_bytes": 55 * GB})
    assert calls == [True]


def test_deleting_a_video_wakes_the_queue(client, add_video, monkeypatch):
    calls: list[bool] = []
    monkeypatch.setattr(
        DownloadQueue,
        "library_changed",
        lambda self, *, room_made=False: calls.append(room_made),
    )
    video = add_video()
    assert client.delete(f"/api/videos/{video.id}").status_code == 204
    other = add_video()
    assert (
        client.post(
            "/api/videos/bulk-delete", json={"video_ids": [other.id]}
        ).status_code
        == 204
    )
    assert calls == [True, True]


def test_held_jobs_and_the_queue_say_why(client, init_db, library_size, free_space):
    _set_limit(10)
    library_size["bytes"] = 10 * GB
    job_id = _add_job(init_db)
    download_queue._next_job_id()

    status = client.get("/api/downloads/queue/status").json()
    assert status["held_code"] == "library_full"
    assert status["held_reason"] == "Paused: library is at its 10 GB limit"
    (job,) = client.get("/api/downloads").json()
    assert job["id"] == job_id
    assert job["held_reason"] == "Paused: library is at its 10 GB limit"
    assert (
        client.get(f"/api/downloads/{job_id}").json()["held_reason"]
        == job["held_reason"]
    )

    health = client.get("/api/health").json()
    assert health["status"] == "warning"
    assert health["downloads"]["held_code"] == "library_full"
    assert health["downloads"]["held_reason"] == job["held_reason"]

    library_size["bytes"] = GB
    download_queue._next_job_id()
    status = client.get("/api/downloads/queue/status").json()
    assert (status["held_code"], status["held_reason"]) == (None, None)
    assert client.get("/api/downloads").json()[0]["held_reason"] is None
    assert client.get("/api/health").json()["status"] == "ok"

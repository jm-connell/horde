"""Download jobs always reach a terminal or queued state; queue bookkeeping is cheap."""

from __future__ import annotations

import threading

import pytest
from sqlalchemy.exc import OperationalError
from sqlmodel import Session
from ytdlp_fakes import FakeYtdlp, make_info, stub_media_probes

from app.models import DownloadJob, JobStatus
from app.services import downloader, job_metadata
from app.services.downloads import dbwrite, progress, runner
from app.services.downloads import queue as dq

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


@pytest.fixture(autouse=True)
def _no_db_retry_sleep(monkeypatch):
    monkeypatch.setattr(dbwrite, "DB_RETRY_BASE_DELAY", 0.0)


def _job(init_db, **fields) -> int:
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            **{
                "url": URL,
                "quality_preset": "best",
                "status": JobStatus.queued,
                **fields,
            }
        )
        s.add(job)
        s.commit()
        return job.id


def _get(init_db, job_id) -> DownloadJob:
    with Session(init_db["engine"]) as s:
        return s.get(DownloadJob, job_id)


def _run_worker(q, job_id):
    q._running.add(job_id)
    q._worker(job_id, threading.Event())


def test_worker_crash_ends_job_in_error(init_db, monkeypatch):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    job_id = _job(init_db)

    def boom(*_a, **_k):
        raise RuntimeError("kaboom")

    q.runner = boom
    _run_worker(q, job_id)
    job = _get(init_db, job_id)
    assert job.status == JobStatus.error
    assert job_id not in q._running


def test_initial_status_write_failure_ends_in_error_not_downloading(
    init_db, monkeypatch
):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    job_id = _job(init_db)
    real = dbwrite.update_job

    def flaky(jid, **fields):
        if fields.get("status") == JobStatus.downloading:
            raise OperationalError("UPDATE", {}, Exception("database is locked"))
        return real(jid, **fields)

    monkeypatch.setattr(dbwrite, "update_job", flaky)
    _run_worker(q, job_id)
    assert _get(init_db, job_id).status == JobStatus.error


def test_locked_database_writes_are_retried(init_db, monkeypatch):
    job_id = _job(init_db)
    real_commit = Session.commit
    calls = {"n": 0}

    def commit(self):
        calls["n"] += 1
        if calls["n"] <= 3:
            raise OperationalError("COMMIT", {}, Exception("database is locked"))
        return real_commit(self)

    monkeypatch.setattr(Session, "commit", commit)
    dbwrite.update_job(job_id, progress=42.0)
    monkeypatch.undo()
    assert _get(init_db, job_id).progress == 42.0
    assert calls["n"] == 4


def test_non_lock_database_errors_are_not_retried(init_db, monkeypatch):
    job_id = _job(init_db)
    calls = {"n": 0}

    def commit(self):
        calls["n"] += 1
        raise OperationalError("COMMIT", {}, Exception("disk I/O error"))

    monkeypatch.setattr(Session, "commit", commit)
    with pytest.raises(OperationalError):
        dbwrite.update_job(job_id, progress=1.0)
    assert calls["n"] == 1


def test_reaper_requeues_orphaned_downloading_jobs_after_grace(init_db, monkeypatch):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    orphan = _job(init_db, status=JobStatus.downloading, progress=40.0)
    running = _job(init_db, status=JobStatus.downloading)
    encoding = _job(init_db, status=JobStatus.downloading)
    q._running.add(running)
    q._ffmpeg_running.add(encoding)

    assert q.reap_stuck_jobs(now=1000.0, grace=120) == []  # first sighting
    assert q.reap_stuck_jobs(now=1060.0, grace=120) == []  # inside the grace
    assert q.reap_stuck_jobs(now=1130.0, grace=120) == [orphan]

    assert _get(init_db, orphan).status == JobStatus.queued
    assert _get(init_db, orphan).progress == 0.0
    assert _get(init_db, running).status == JobStatus.downloading
    assert _get(init_db, encoding).status == JobStatus.downloading


def test_reaper_forgets_jobs_that_became_owned(init_db, monkeypatch):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    job_id = _job(init_db, status=JobStatus.downloading)
    q.reap_stuck_jobs(now=0.0, grace=100)
    q._ffmpeg_running.add(job_id)  # handed to ffmpeg meanwhile
    q.reap_stuck_jobs(now=50.0, grace=100)
    q._ffmpeg_running.discard(job_id)
    # The clock restarts when it becomes orphaned again.
    assert q.reap_stuck_jobs(now=120.0, grace=100) == []
    assert q.reap_stuck_jobs(now=230.0, grace=100) == [job_id]


def test_counts_use_sql_count(init_db):
    q = downloader.DownloadQueue()
    _job(init_db)
    _job(init_db, status=JobStatus.downloading)
    _job(init_db, status=JobStatus.completed)
    assert q.queued_count() == 1
    assert q.active_count() == 2


def test_next_job_id_orders_by_age_and_skips_running_and_held(init_db):
    q = downloader.DownloadQueue()
    a, b, c = _job(init_db), _job(init_db), _job(init_db)
    assert q._next_job_id() == a
    q._running.add(a)
    q._held.add(b)
    assert q._next_job_id() == c
    q._running.add(c)
    assert q._next_job_id() is None


def test_dispatch_runs_jobs_fifo_within_concurrency_end_to_end(init_db, monkeypatch):
    """Jobs run through the real dispatcher with a fake extractor."""
    monkeypatch.setattr(dq, "MAX_DOWNLOAD_CONCURRENCY", 1)
    fake = FakeYtdlp()
    fake.install(monkeypatch, downloader)
    stub_media_probes(monkeypatch, downloader)
    ids = []
    for n in range(3):
        url = f"https://www.youtube.com/watch?v=aaaaaaaaa{n:02d}"
        fake.add(url, make_info(f"aaaaaaaaa{n:02d}", f"Vid {n}"))
        ids.append(_job(init_db, url=url))

    started: list[int] = []
    release = threading.Event()
    all_done = threading.Event()
    real_run = runner.run_download
    lock = threading.Lock()
    running_now = {"n": 0, "max": 0}

    def tracked(job_id, cancel_event=None, queue=None):
        with lock:
            started.append(job_id)
            running_now["n"] += 1
            running_now["max"] = max(running_now["max"], running_now["n"])
        release.wait(5)
        try:
            return real_run(job_id, cancel_event=cancel_event, queue=queue)
        finally:
            with lock:
                running_now["n"] -= 1
                if len(started) == 3 and running_now["n"] == 0:
                    all_done.set()

    q = downloader.DownloadQueue(runner=tracked)
    monkeypatch.setattr(
        downloader.ffmpeg_queue,
        "enqueue",
        lambda task: (
            q.claim_ffmpeg(task.job_id),
            downloader.ffmpeg_queue._worker(task),
        ),
    )
    q._dispatch()
    release.set()
    assert all_done.wait(20)
    assert started == ids  # FIFO
    assert running_now["max"] == 1
    for t in threading.enumerate():
        if t is not threading.current_thread() and t.name.startswith("Thread-"):
            t.join(timeout=5)
    assert all(_get(init_db, i).status == JobStatus.completed for i in ids)


def test_paused_queue_dispatches_nothing(init_db, monkeypatch):
    q = downloader.DownloadQueue()
    q._global_paused = True
    started = []
    monkeypatch.setattr(q, "_worker", lambda *a: started.append(a))
    _job(init_db)
    q._dispatch()
    assert started == []


# -- progress store -----------------------------------------------------------


def test_progress_store_merge_is_atomic_under_threads():
    store = progress.ProgressStore()

    def writer(key):
        for i in range(500):
            store.merge(1, {key: i})

    threads = [threading.Thread(target=writer, args=(f"k{n}",)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert {f"k{n}" for n in range(4)} <= set(store[1])
    assert all(store[1][f"k{n}"] == 499 for n in range(4))


def test_progress_store_prunes_finished_jobs_after_ttl():
    store = progress.ProgressStore(ttl=10)
    store[1] = {"status": "downloading"}
    store[2] = {"status": "completed"}
    store[3] = {"status": "error"}
    store[3] = {"status": "queued"}  # retried: no longer finished
    import time

    future = time.monotonic() + 11
    assert store.prune(future) == 1
    assert 2 not in store and 1 in store and 3 in store
    assert store.prune(future) == 0


# -- job metadata rehydration -----------------------------------------------------


def test_rehydrate_requeues_jobs_missing_metadata(init_db, monkeypatch):
    requested: list[int] = []
    monkeypatch.setattr(job_metadata, "request_job_metadata", requested.append)
    bare = _job(init_db)
    complete = _job(init_db, title="T", available_presets_json='["1080p"]')
    no_presets = _job(init_db, title="T")
    done = _job(init_db, status=JobStatus.completed)
    assert job_metadata.rehydrate_pending() == 2
    assert sorted(requested) == sorted([bare, no_presets])
    assert complete not in requested and done not in requested

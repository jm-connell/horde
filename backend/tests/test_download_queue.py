"""DownloadQueue state transitions with stubbed worker (no yt-dlp)."""

from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app.models import DownloadJob, JobStatus
from app.services import downloader
from app.services.ytdlp_common import ERROR_KIND_CANCELLED


def _add_job(session: Session, **fields) -> DownloadJob:
    job = DownloadJob(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        quality_preset="best",
        **{"status": JobStatus.queued, **fields},
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def test_cancel_queued_job(init_db, monkeypatch):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    with Session(init_db["engine"]) as session:
        job = _add_job(session)
        job_id = job.id
    assert q.cancel_job(job_id) is True
    with Session(init_db["engine"]) as session:
        job = session.get(DownloadJob, job_id)
        assert job.status == JobStatus.cancelled
        assert job.error_kind == ERROR_KIND_CANCELLED


def test_cancel_completed_returns_false(init_db, monkeypatch):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    with Session(init_db["engine"]) as session:
        job = _add_job(session, status=JobStatus.completed)
        job_id = job.id
    assert q.cancel_job(job_id) is False


def test_pause_and_resume_all(init_db, monkeypatch):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    with Session(init_db["engine"]) as session:
        queued = _add_job(session)
        downloading = _add_job(session, status=JobStatus.downloading)
        q_id, d_id = queued.id, downloading.id

    q.pause_all()
    assert q.is_paused() is True
    with Session(init_db["engine"]) as session:
        q_job = session.get(DownloadJob, q_id)
        d_job = session.get(DownloadJob, d_id)
        assert q_job.paused is True
        assert d_job.paused is True
        assert d_job.status == JobStatus.queued

    q.resume_all()
    assert q.is_paused() is False
    with Session(init_db["engine"]) as session:
        jobs = session.exec(
            select(DownloadJob).where(DownloadJob.id.in_([q_id, d_id]))
        ).all()
        assert all(not j.paused for j in jobs)


def test_recover_stuck_downloading(init_db, monkeypatch):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    with Session(init_db["engine"]) as session:
        job = _add_job(session, status=JobStatus.downloading, progress=42.0)
        job_id = job.id

    q.recover()
    with Session(init_db["engine"]) as session:
        job = session.get(DownloadJob, job_id)
        assert job.status == JobStatus.queued
        assert job.progress == 0.0


def test_next_job_id_skips_paused_fifo(init_db, monkeypatch):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    now = datetime.now(timezone.utc)
    with Session(init_db["engine"]) as session:
        older = _add_job(session, paused=True)
        older.created_at = now - timedelta(minutes=5)
        session.add(older)
        newer = _add_job(session, paused=False)
        newer.created_at = now
        session.add(newer)
        session.commit()
        newer_id = newer.id

    with q._lock:
        assert q._next_job_id() == newer_id


def test_next_job_id_skips_held(init_db, monkeypatch):
    monkeypatch.setattr(downloader.DownloadQueue, "_dispatch", lambda self: None)
    q = downloader.DownloadQueue()
    with Session(init_db["engine"]) as session:
        held = _add_job(session)
        ready = _add_job(session)
        held_id, ready_id = held.id, ready.id
    q._held.add(held_id)
    with q._lock:
        assert q._next_job_id() == ready_id

"""Background fill of cheap-enqueued download jobs."""

import threading

from sqlmodel import Session

from app.models import DownloadJob, JobStatus
from app.services import downloader, job_metadata


def test_fill_job_writes_title_and_resolves_best(init_db, monkeypatch):
    def fake_preview(url, *, priority=2):
        return {
            "id": "dQw4w9WgXcQ",
            "title": "Filled Title",
            "channel": "Filled Chan",
            "thumbnail_url": "https://example.com/t.jpg",
            "is_playlist": False,
            "available_presets": ["2160p", "1080p", "720p"],
        }

    monkeypatch.setattr(job_metadata, "extract_preview", fake_preview)
    with Session(init_db["engine"]) as session:
        job = DownloadJob(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            quality_preset="best",
            status=JobStatus.queued,
        )
        session.add(job)
        session.commit()
        job_id = job.id

    job_metadata._fill_job(job_id)
    with Session(init_db["engine"]) as session:
        job = session.get(DownloadJob, job_id)
        assert job.title == "Filled Title"
        assert job.channel == "Filled Chan"
        assert job.quality_preset == "2160p"
    snap = downloader.progress_store[job_id]
    assert snap["title"] == "Filled Title"
    assert snap["available_presets"][0] == "2160p"


def test_fill_job_drops_shorts(init_db, monkeypatch):
    def fake_preview(url, *, priority=2):
        return {
            "id": "shortsidxxx",
            "title": "A #shorts clip",
            "duration": 12,
            "is_playlist": False,
        }

    monkeypatch.setattr(job_metadata, "extract_preview", fake_preview)
    monkeypatch.setattr(job_metadata, "is_youtube_short_entry", lambda info: True)
    with Session(init_db["engine"]) as session:
        job = DownloadJob(
            url="https://www.youtube.com/watch?v=shortsidxxx",
            quality_preset="best",
            status=JobStatus.queued,
        )
        session.add(job)
        session.commit()
        job_id = job.id

    job_metadata._fill_job(job_id)
    with Session(init_db["engine"]) as session:
        assert session.get(DownloadJob, job_id) is None
    assert downloader.progress_store[job_id]["status"] == "skipped"
    assert downloader.progress_store[job_id]["reason"] == "shorts"


def test_worker_fills_queued_job(init_db, monkeypatch):
    done = threading.Event()

    def fake_preview(url, *, priority=2):
        done.set()
        return {
            "id": "dQw4w9WgXcQ",
            "title": "From Worker",
            "channel": "Chan",
            "is_playlist": False,
            "available_presets": ["1080p"],
        }

    monkeypatch.setattr(job_metadata, "extract_preview", fake_preview)
    with Session(init_db["engine"]) as session:
        job = DownloadJob(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            quality_preset="best",
            status=JobStatus.queued,
        )
        session.add(job)
        session.commit()
        job_id = job.id

    job_metadata.start_job_metadata_worker()
    try:
        job_metadata.request_job_metadata(job_id)
        assert done.wait(timeout=5)
        for _ in range(20):
            with Session(init_db["engine"]) as session:
                job = session.get(DownloadJob, job_id)
                if job and job.title == "From Worker":
                    break
            done.wait(timeout=0.1)
        with Session(init_db["engine"]) as session:
            job = session.get(DownloadJob, job_id)
            assert job.title == "From Worker"
    finally:
        job_metadata.stop_job_metadata_worker()

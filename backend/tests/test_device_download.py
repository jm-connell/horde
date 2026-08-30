"""Ephemeral download-to-device jobs: complete, serve, dismiss, GC."""

from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import DownloadDestination, DownloadJob, JobStatus, Video
from app.services import downloader


def _write_media(path: Path, size: int = 64) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00" * size)


def test_complete_device_skips_library_row(init_db, monkeypatch):
    monkeypatch.setattr(downloader, "_apply_loudnorm", lambda _p: None)
    monkeypatch.setattr(
        "app.services.mp4_compat.ensure_iphone_mp4", lambda _p: None
    )
    monkeypatch.setattr(downloader, "_check_quality", lambda *_a, **_k: None)
    monkeypatch.setattr(downloader, "probe_duration", lambda _p: 12.0)
    monkeypatch.setattr(downloader, "probe_dimensions", lambda _p: (1280, 720))

    downloads = init_db["downloads"]
    with Session(init_db["engine"]) as session:
        job = DownloadJob(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            quality_preset="720p",
            status=JobStatus.downloading,
            destination=DownloadDestination.device.value,
            title="Device Clip",
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id

    final = downloads / "_device" / str(job_id) / "Device Clip [dQw4w9WgXcQ].mp4"
    _write_media(final)

    result = downloader._complete_download(
        job_id,
        final,
        {"title": "Device Clip", "id": "dQw4w9WgXcQ", "uploader": "Rick"},
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "720p",
        None,
        None,
        False,
        None,
        None,
        destination=DownloadDestination.device.value,
    )
    assert result is None

    with Session(init_db["engine"]) as session:
        job = session.get(DownloadJob, job_id)
        assert job is not None
        assert job.status == JobStatus.completed
        assert job.video_id is None
        assert job.device_file_path == f"_device/{job_id}/Device Clip [dQw4w9WgXcQ].mp4"
        assert session.exec(select(Video)).first() is None

    snap = downloader.progress_store[job_id]
    assert snap["status"] == "completed"
    assert snap["destination"] == "device"
    assert "video_id" not in snap


def test_device_file_endpoint_and_dismiss_cleanup(init_db):
    from app.api import downloads as downloads_api

    downloads = init_db["downloads"]
    with Session(init_db["engine"]) as session:
        job = DownloadJob(
            url="https://example.com/v",
            quality_preset="best",
            status=JobStatus.completed,
            destination=DownloadDestination.device.value,
            title="Saved Clip",
            title_override="My Save",
            file_size=64,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id
        job.device_file_path = f"_device/{job_id}/clip.mp4"
        session.add(job)
        session.commit()

    media = downloads / "_device" / str(job_id) / "clip.mp4"
    _write_media(media)

    with Session(init_db["engine"]) as session:
        resp = downloads_api.download_device_file(job_id, session)
    assert resp.path == str(media.resolve()) or Path(resp.path).resolve() == media.resolve()
    assert resp.filename and "My Save" in resp.filename

    with Session(init_db["engine"]) as session:
        lib = DownloadJob(
            url="https://example.com/lib",
            quality_preset="best",
            status=JobStatus.completed,
            destination=DownloadDestination.library.value,
        )
        session.add(lib)
        session.commit()
        session.refresh(lib)
        lib_id = lib.id

    with Session(init_db["engine"]) as session:
        with pytest.raises(HTTPException) as exc:
            downloads_api.download_device_file(lib_id, session)
        assert exc.value.status_code == 409

    with Session(init_db["engine"]) as session:
        result = downloads_api.dismiss_job(job_id, session)
    assert result.status_code == 204
    assert not media.exists()
    assert not (downloads / "_device" / str(job_id)).exists()
    with Session(init_db["engine"]) as session:
        assert session.get(DownloadJob, job_id) is None


def test_gc_orphaned_device_dirs(init_db):
    downloads = init_db["downloads"]
    orphan = downloads / "_device" / "999"
    orphan.mkdir(parents=True)
    (orphan / "leftover.mp4").write_bytes(b"x")

    with Session(init_db["engine"]) as session:
        job = DownloadJob(
            url="https://example.com/v",
            quality_preset="best",
            status=JobStatus.completed,
            destination=DownloadDestination.device.value,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        keep_id = job.id
        job.device_file_path = f"_device/{keep_id}/keep.mp4"
        session.add(job)
        session.commit()

    keep = downloads / "_device" / str(keep_id)
    keep.mkdir(parents=True, exist_ok=True)
    (keep / "keep.mp4").write_bytes(b"y")

    removed = downloader.gc_orphaned_device_dirs()
    assert removed >= 1
    assert not orphan.exists()
    assert keep.exists()


def test_scanner_skips_device_staging(init_db):
    from app.services.scanner import ingest_media_file

    downloads = init_db["downloads"]
    path = downloads / "_device" / "42" / "staged.mp4"
    _write_media(path, size=1024)

    with Session(init_db["engine"]) as session:
        assert ingest_media_file(session, path, require_stable=False) is None
        assert session.exec(select(Video)).first() is None

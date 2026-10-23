"""Ephemeral download-to-device jobs: complete, serve, dismiss, GC."""

import threading
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import DownloadDestination, DownloadJob, JobStatus, Video
from app.services.auth.accounts import AuthUser
from app.services.downloads import finalize, postprocess, progress, staging
from app.services.downloads.spec import JobSpec

ADMIN = AuthUser(id=1, username="admin", is_admin=True)


def _write_media(path: Path, size: int = 64) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00" * size)


def test_complete_device_skips_library_row(init_db, monkeypatch):
    monkeypatch.setattr(postprocess, "apply_loudnorm", lambda _p: None)
    monkeypatch.setattr(postprocess, "check_quality", lambda *_a, **_k: None)
    monkeypatch.setattr(finalize, "probe_duration", lambda _p: 12.0)
    monkeypatch.setattr(finalize, "probe_dimensions", lambda _p: (1280, 720))

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

    result = finalize.complete_download(
        postprocess.PostprocessTask(
            spec=JobSpec(
                job_id=job_id,
                url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                quality_preset="720p",
                destination=DownloadDestination.device.value,
            ),
            final_path=final,
            info={"title": "Device Clip", "id": "dQw4w9WgXcQ", "uploader": "Rick"},
            cancel_event=threading.Event(),
        )
    )
    assert result is None

    with Session(init_db["engine"]) as session:
        job = session.get(DownloadJob, job_id)
        assert job is not None
        assert job.status == JobStatus.completed
        assert job.video_id is None
        assert job.device_file_path == f"_device/{job_id}/Device Clip [dQw4w9WgXcQ].mp4"
        assert session.exec(select(Video)).first() is None

    snap = progress.progress_store[job_id]
    assert snap["status"] == "completed"
    assert snap["destination"] == "device"
    assert "video_id" not in snap


def test_complete_download_reports_post_download_stages(init_db, monkeypatch):
    from app.services.mp4_compat import MediaProbe

    seen: list[tuple[str, str | None]] = []
    job_id = 0

    def fake_ensure(path: Path, **_kwargs: object) -> Path:
        seen.append(("ensure", progress.progress_store.get(job_id, {}).get("stage")))
        return path

    def fake_transcode(path: Path, target: str, **_kwargs: object) -> Path:
        seen.append(("transcode", progress.progress_store.get(job_id, {}).get("stage")))
        return path

    def fake_loudnorm(_path: Path, **_kwargs: object) -> None:
        seen.append(("loudnorm", progress.progress_store.get(job_id, {}).get("stage")))
        return None

    monkeypatch.setattr(postprocess, "apply_loudnorm", fake_loudnorm)
    monkeypatch.setattr(postprocess, "check_quality", lambda *_a, **_k: None)
    monkeypatch.setattr(finalize, "probe_duration", lambda _p: 12.0)
    monkeypatch.setattr(finalize, "probe_dimensions", lambda _p: (1280, 720))
    monkeypatch.setattr(postprocess, "probe_duration", lambda _p: 12.0)
    monkeypatch.setattr(postprocess, "probe_dimensions", lambda _p: (1280, 720))
    monkeypatch.setattr(postprocess, "ensure_safari_mp4", fake_ensure)
    monkeypatch.setattr(postprocess, "transcode_video", fake_transcode)
    monkeypatch.setattr(
        postprocess,
        "probe_media",
        lambda _p: MediaProbe(
            video_codec="av1",
            audio_codec="opus",
            format_name="mov,mp4,m4a,3gp,3g2,mj2",
            moov_front=False,
        ),
    )

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

    progress.progress_store[job_id] = {
        "status": "processing",
        "progress": 99.0,
        "title": "Device Clip",
    }
    final = downloads / "_device" / str(job_id) / "Device Clip [dQw4w9WgXcQ].mp4"
    _write_media(final)

    finalize.complete_download(
        postprocess.PostprocessTask(
            spec=JobSpec(
                job_id=job_id,
                url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                quality_preset="720p",
                normalize_volume=True,
                destination=DownloadDestination.device.value,
                video_codec="h264",
            ),
            final_path=final,
            info={"title": "Device Clip", "id": "dQw4w9WgXcQ", "uploader": "Rick"},
            cancel_event=threading.Event(),
        )
    )
    assert seen == [
        ("ensure", "encoding_audio"),
        ("transcode", "transcoding"),
        ("loudnorm", "normalizing"),
    ]


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
        resp = downloads_api.download_device_file(job_id, session, ADMIN)
    assert (
        resp.path == str(media.resolve())
        or Path(resp.path).resolve() == media.resolve()
    )
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
            downloads_api.download_device_file(lib_id, session, ADMIN)
        assert exc.value.status_code == 409

    with Session(init_db["engine"]) as session:
        result = downloads_api.dismiss_job(job_id, session, ADMIN)
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

    removed = staging.gc_orphaned_device_dirs()
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

"""Re-downloads stage in a per-job dir and only then replace the library file."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, select
from ytdlp_fakes import FakeYtdlp, make_info, run_job_inline, stub_media_probes

from app.models import DownloadJob, JobStatus, Video
from app.services import downloader, scanner
from app.services.paths import STAGING_DIR_NAME

YT = "aaaaaaaaaaa"
URL = f"https://www.youtube.com/watch?v={YT}"
OLD = b"OLD" * 100


@pytest.fixture
def fake(init_db, monkeypatch):
    f = FakeYtdlp()
    f.install(monkeypatch, downloader)
    stub_media_probes(monkeypatch, downloader)
    f.add(URL, make_info(YT, "Clip", uploader="Chan"))
    return f


@pytest.fixture
def existing(add_video, init_db):
    """A library video whose file lives where a re-download will land."""
    video = add_video(
        write_file=True,
        file_bytes=OLD,
        yt_id=YT,
        channel="Chan",
        title="Clip",
        file_path=f"Chan/2024/Clip [{YT}].mp4",
    )
    return video


def _redownload_job(init_db, video) -> int:
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url=URL,
            quality_preset="best",
            status=JobStatus.queued,
            replace_video_id=video.id,
            channel_override=video.channel,
            title_override=video.title,
        )
        s.add(job)
        s.commit()
        return job.id


def _status(init_db, job_id):
    with Session(init_db["engine"]) as s:
        return s.get(DownloadJob, job_id).status


def _library_media(root: Path) -> list[Path]:
    return [
        p
        for p in root.rglob("*")
        if p.is_file() and STAGING_DIR_NAME not in p.relative_to(root).parts
    ]


def test_new_download_lands_in_library_only_after_postprocess(init_db, fake):
    root = init_db["downloads"]
    seen: list[list[Path]] = []
    fake.before_merge = lambda _p, _i: seen.append(_library_media(root))
    with Session(init_db["engine"]) as s:
        job = DownloadJob(url=URL, quality_preset="best", status=JobStatus.queued)
        s.add(job)
        s.commit()
        job_id = job.id
    run_job_inline(downloader, job_id)

    assert seen == [[]], "yt-dlp wrote into the library while downloading"
    with Session(init_db["engine"]) as s:
        video = s.exec(select(Video)).one()
    assert (root / video.file_path).is_file()
    assert _status(init_db, job_id) == JobStatus.completed
    assert not (root / STAGING_DIR_NAME / str(job_id)).exists()


def test_cancelled_redownload_leaves_library_file_untouched(init_db, fake, existing):
    root = init_db["downloads"]
    cancel = threading.Event()
    fake.before_merge = lambda _p, _i: cancel.set()
    job_id = _redownload_job(init_db, existing)

    run_job_inline(downloader, job_id, cancel_event=cancel)

    assert (root / existing.file_path).read_bytes() == OLD
    assert _status(init_db, job_id) == JobStatus.cancelled
    assert not (root / STAGING_DIR_NAME / str(job_id)).exists()
    with Session(init_db["engine"]) as s:
        assert s.get(Video, existing.id).file_path == existing.file_path


def test_failed_redownload_leaves_library_file_untouched(init_db, fake, existing):
    root = init_db["downloads"]

    def boom(_p, _i):
        raise RuntimeError("HTTP Error 403")

    fake.before_merge = boom
    job_id = _redownload_job(init_db, existing)
    run_job_inline(downloader, job_id)

    assert (root / existing.file_path).read_bytes() == OLD
    assert _status(init_db, job_id) == JobStatus.error
    assert _library_media(root) == [root / existing.file_path]
    assert not (root / STAGING_DIR_NAME / str(job_id)).exists()


def test_unplayable_redownload_never_touches_library_file(
    init_db, fake, existing, monkeypatch
):
    stub_media_probes(monkeypatch, downloader, playable=False)
    root = init_db["downloads"]
    job_id = _redownload_job(init_db, existing)
    run_job_inline(downloader, job_id)
    assert (root / existing.file_path).read_bytes() == OLD
    assert _status(init_db, job_id) == JobStatus.error


def test_successful_redownload_replaces_atomically_and_updates_row(
    init_db, fake, existing
):
    root = init_db["downloads"]
    fake.merged_bytes = 777
    job_id = _redownload_job(init_db, existing)
    run_job_inline(downloader, job_id)

    path = root / existing.file_path
    assert path.stat().st_size == 777
    assert _library_media(root) == [path]  # no backups or fragments left behind
    with Session(init_db["engine"]) as s:
        assert s.get(Video, existing.id).file_size == 777
    assert not (root / STAGING_DIR_NAME / str(job_id)).exists()


def test_replace_into_new_folder_removes_old_copy_after_commit(
    init_db, fake, add_video
):
    root = init_db["downloads"]
    video = add_video(
        write_file=True,
        file_bytes=OLD,
        yt_id=YT,
        channel="Renamed",
        file_path=f"Old Folder/2020/Clip [{YT}].mp4",
    )
    old = root / video.file_path
    job_id = _redownload_job(init_db, video)
    run_job_inline(downloader, job_id)

    with Session(init_db["engine"]) as s:
        row = s.get(Video, video.id)
    assert row.file_path.startswith("Renamed/")
    assert (root / row.file_path).is_file()
    assert not old.exists()


def test_commit_failure_restores_the_replaced_file(
    init_db, fake, existing, monkeypatch
):
    root = init_db["downloads"]

    def failing(**_kw):
        raise OperationalError("COMMIT", {}, Exception("disk I/O error"))

    monkeypatch.setattr(downloader, "_commit_library_video", failing)
    job_id = _redownload_job(init_db, existing)
    run_job_inline(downloader, job_id)

    assert (root / existing.file_path).read_bytes() == OLD
    assert _library_media(root) == [root / existing.file_path]
    assert _status(init_db, job_id) == JobStatus.error


def test_scanner_ignores_staging_dir(init_db):
    root = init_db["downloads"]
    staged = root / STAGING_DIR_NAME / "7" / "Chan" / "2024" / f"Clip [{YT}].mp4"
    staged.parent.mkdir(parents=True)
    staged.write_bytes(b"x" * 64)
    assert not scanner._is_media(staged)
    with Session(init_db["engine"]) as s:
        assert scanner.ingest_media_file(s, staged, require_stable=False) is None


def test_paused_job_keeps_its_staging_dir_for_resume(init_db, fake):
    root = init_db["downloads"]
    with Session(init_db["engine"]) as s:
        job = DownloadJob(url=URL, quality_preset="best", status=JobStatus.queued)
        s.add(job)
        s.commit()
        job_id = job.id
    staging = root / STAGING_DIR_NAME / str(job_id)
    staging.mkdir(parents=True)
    (staging / "x.f137.mp4.part").write_bytes(b"1")
    downloader._discard_staging_unless_requeued(job_id)
    assert staging.exists()
    downloader._update_job(job_id, status=JobStatus.cancelled)
    downloader._discard_staging_unless_requeued(job_id)
    assert not staging.exists()

"""Filesystem-safe output paths for new downloads (driven through a fake yt-dlp)."""

from __future__ import annotations

import os

import pytest
from sqlmodel import Session, select
from ytdlp_fakes import FakeYtdlp, make_info, run_job_inline, stub_media_probes

from app.models import DownloadJob, JobStatus, Video

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


@pytest.fixture
def fake(init_db, monkeypatch):
    f = FakeYtdlp()
    f.install(monkeypatch)
    stub_media_probes(monkeypatch)
    return f


def _job(init_db, **fields) -> int:
    with Session(init_db["engine"]) as session:
        job = DownloadJob(
            url=URL, quality_preset="best", status=JobStatus.queued, **fields
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        return job.id


def _video(init_db) -> Video:
    with Session(init_db["engine"]) as session:
        return session.exec(select(Video)).one()


def test_four_byte_title_stays_under_255_bytes_with_every_suffix(init_db, fake):
    # 100 emoji = 400 bytes: the old "%(title)s" template raised ENAMETOOLONG.
    fake.add(URL, make_info(title="🎬" * 100))
    job_id = _job(init_db)
    run_job_inline(job_id)

    assert fake.written, "fake yt-dlp wrote nothing"
    for path in fake.written:
        assert len(os.fsencode(path.name)) <= 255, path.name
    video = _video(init_db)
    final = init_db["downloads"] / video.file_path
    assert final.is_file()
    # Room is left for yt-dlp/Horde suffixes (.f137.mp4.part, .horde-h264.mp4, .en.vtt).
    assert len(os.fsencode(final.name)) <= 255 - 40


def test_title_that_expands_when_sanitised_is_shrunk_to_fit(init_db, fake):
    # ':' and '?' become 3-byte full-width characters after truncation.
    fake.add(URL, make_info(title="Q: why? " * 40))
    run_job_inline(_job(init_db))
    final = init_db["downloads"] / _video(init_db).file_path
    assert len(os.fsencode(final.name)) <= 255 - 40


def test_missing_uploader_gets_a_readable_folder_not_NA(init_db, fake):
    fake.add(URL, make_info(uploader=None, upload_date=None))
    run_job_inline(_job(init_db))
    video = _video(init_db)
    assert video.file_path.startswith("Unknown channel/Unknown year/")
    assert "NA" not in video.file_path.split("/")[:2]


def test_channel_override_names_the_folder_and_matches_db_channel(init_db, fake):
    fake.add(URL, make_info(uploader="Uploader Name"))
    run_job_inline(_job(init_db, channel_override="My Curated Channel"))
    video = _video(init_db)
    assert video.channel == "My Curated Channel"
    assert video.file_path.split("/")[0] == "My Curated Channel"


def test_channel_override_is_sanitised_for_the_filesystem(init_db, fake):
    fake.add(URL, make_info())
    run_job_inline(_job(init_db, channel_override="AC/DC. "))
    video = _video(init_db)
    folder = video.file_path.split("/")[0]
    assert "/" not in folder and not folder.endswith((".", " "))
    assert (init_db["downloads"] / video.file_path).is_file()


def test_reserved_windows_name_uploader_folder_is_prefixed(init_db, fake):
    fake.add(URL, make_info(uploader="NUL"))
    run_job_inline(_job(init_db))
    assert _video(init_db).file_path.split("/")[0] == "_NUL"


def test_long_uploader_is_byte_truncated(init_db, fake):
    fake.add(URL, make_info(uploader="长" * 80))
    run_job_inline(_job(init_db))
    folder = _video(init_db).file_path.split("/")[0]
    assert len(folder.encode()) <= 80


def test_windows_filenames_option_is_forced(init_db, fake):
    fake.add(URL, make_info())
    run_job_inline(_job(init_db))
    assert fake.downloads[0]["opts"]["windowsfilenames"] is True

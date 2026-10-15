"""Files and DB rows must never disagree, even when a commit fails."""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.exc import OperationalError
from sqlmodel import Session

from app.models import Video
from app.services import downloader, mp4_compat, video_transcode
from app.services.downloads import finalize
from app.services.paths import rename_video_file


def _fail_commit(monkeypatch, times: int = 1_000):
    state = {"n": 0}
    real = Session.commit

    def commit(self):
        state["n"] += 1
        if state["n"] <= times:
            raise OperationalError("COMMIT", {}, Exception("disk I/O error"))
        return real(self)

    monkeypatch.setattr(Session, "commit", commit)


def test_rename_commit_failure_moves_files_back(
    session, add_video, init_db, monkeypatch
):
    video = add_video(write_file=True, file_path="imports/old.mp4")
    root = init_db["downloads"]
    (root / "imports" / "old.horde-h264.mp4").write_bytes(b"s")
    video.compat_path = "imports/old.horde-h264.mp4"
    session.add(video)
    session.commit()
    vid = video.id

    _fail_commit(monkeypatch)
    with pytest.raises(OperationalError):
        rename_video_file(session, video, "imports/new.mp4")
    monkeypatch.undo()

    assert (root / "imports/old.mp4").is_file()
    assert (root / "imports/old.horde-h264.mp4").is_file()
    assert not (root / "imports/new.mp4").exists()
    with Session(init_db["engine"]) as s:
        row = s.get(Video, vid)
        assert row.file_path == "imports/old.mp4"
        assert row.compat_path == "imports/old.horde-h264.mp4"


def test_rename_never_overwrites_and_restores_on_midway_failure(
    session, add_video, init_db, monkeypatch
):
    video = add_video(write_file=True, file_path="imports/old.mp4")
    root = init_db["downloads"]
    (root / "imports" / "old.horde-h264.mp4").write_bytes(b"s")
    video.compat_path = "imports/old.horde-h264.mp4"
    session.add(video)
    session.commit()
    # A foreign file already sits where the sidecar would go.
    (root / "imports" / "new.horde-h264.mp4").write_bytes(b"other")

    with pytest.raises(FileExistsError):
        rename_video_file(session, video, "imports/new.mp4")
    assert (root / "imports/old.mp4").is_file()
    assert not (root / "imports/new.mp4").exists()
    assert (root / "imports/new.horde-h264.mp4").read_bytes() == b"other"


def _fake_remux(monkeypatch, module):
    """Make ffmpeg 'produce' the temp file without running it."""

    def run_ffmpeg(cmd, **_kw):
        Path(cmd[-1]).write_bytes(b"new media")

    monkeypatch.setattr(module, "run_ffmpeg", run_ffmpeg)


def test_safari_remux_updates_row_before_removing_original(
    session, add_video, init_db, monkeypatch
):
    video = add_video(write_file=True, file_path="Chan/clip [aaaaaaaaaaa].mkv")
    root = init_db["downloads"]
    old = root / video.file_path
    _fake_remux(monkeypatch, mp4_compat)
    monkeypatch.setattr(mp4_compat, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(
        mp4_compat,
        "probe_media",
        lambda _p: mp4_compat.MediaProbe("h264", "aac", "matroska,webm", None),
    )
    seen: dict[str, bool] = {}

    def persist(new_path: Path) -> None:
        seen["old_still_there"] = old.exists()
        seen["new_there"] = new_path.exists()
        seen["scanner_ignores"] = mp4_compat.scanner._is_active(
            "Chan/clip [aaaaaaaaaaa].mp4"
        )

    out = mp4_compat.ensure_safari_mp4(old, on_replace=persist)
    assert out.suffix == ".mp4" and out.exists()
    assert seen == {"old_still_there": True, "new_there": True, "scanner_ignores": True}
    assert not old.exists()


def test_safari_remux_callback_failure_keeps_original(add_video, init_db, monkeypatch):
    video = add_video(write_file=True, file_path="Chan/clip [aaaaaaaaaaa].mkv")
    old = init_db["downloads"] / video.file_path
    _fake_remux(monkeypatch, mp4_compat)
    monkeypatch.setattr(mp4_compat, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(
        mp4_compat,
        "probe_media",
        lambda _p: mp4_compat.MediaProbe("h264", "aac", "matroska,webm", None),
    )

    def persist(_p: Path) -> None:
        raise RuntimeError("commit failed")

    with pytest.raises(RuntimeError):
        mp4_compat.ensure_safari_mp4(old, on_replace=persist)
    assert old.exists()
    assert not old.with_suffix(".mp4").exists()


def test_transcode_callback_failure_keeps_original(add_video, init_db, monkeypatch):
    from app.services.encode_probe import EncoderChoice

    video = add_video(write_file=True, file_path="Chan/clip [aaaaaaaaaaa].webm")
    old = init_db["downloads"] / video.file_path
    _fake_remux(monkeypatch, video_transcode)
    monkeypatch.setattr(
        video_transcode,
        "probe_encode_capabilities",
        lambda: type("C", (), {"encoders": []})(),
    )
    monkeypatch.setattr(video_transcode, "probe_media", lambda _p: None)

    def boom(_p: Path) -> None:
        raise RuntimeError("commit failed")

    with pytest.raises(RuntimeError):
        video_transcode.transcode_video(
            old,
            "h264",
            encoder=EncoderChoice(name="libx264", kind="software", hw=False),
            on_replace=boom,
        )
    assert old.exists()
    assert not old.with_suffix(".mp4").exists()


def test_replace_keeps_old_files_when_row_commit_fails(init_db, add_video, monkeypatch):
    """The previous media and subtitles are only deleted after the commit."""
    from ytdlp_fakes import FakeYtdlp, make_info, run_job_inline, stub_media_probes

    from app.models import DownloadJob, JobStatus

    fake = FakeYtdlp()
    fake.install(monkeypatch, downloader)
    stub_media_probes(monkeypatch, downloader)
    url = "https://www.youtube.com/watch?v=aaaaaaaaaaa"
    # Old copy lives in a different folder than the new one will.
    video = add_video(
        write_file=True,
        yt_id="aaaaaaaaaaa",
        channel="Old",
        file_path="Old/2020/Clip [aaaaaaaaaaa].mp4",
        subtitles='[{"lang":"en","path":"Old/2020/Clip [aaaaaaaaaaa].en.vtt","auto":false}]',
    )
    root = init_db["downloads"]
    sub = root / "Old/2020/Clip [aaaaaaaaaaa].en.vtt"
    sub.write_bytes(b"v")
    fake.add(url, make_info("aaaaaaaaaaa", "Clip", uploader="New"))
    with Session(init_db["engine"]) as s:
        job = DownloadJob(
            url=url,
            quality_preset="best",
            status=JobStatus.queued,
            replace_video_id=video.id,
        )
        s.add(job)
        s.commit()
        job_id = job.id

    original = finalize.commit_library_video

    def failing(**_kw):
        raise OperationalError("COMMIT", {}, Exception("disk I/O error"))

    monkeypatch.setattr(finalize, "commit_library_video", failing)
    run_job_inline(downloader, job_id)
    monkeypatch.setattr(finalize, "commit_library_video", original)

    assert (root / video.file_path).is_file()
    assert sub.is_file()
    with Session(init_db["engine"]) as s:
        assert s.get(Video, video.id).file_path == video.file_path
        assert s.get(DownloadJob, job_id).status == JobStatus.error

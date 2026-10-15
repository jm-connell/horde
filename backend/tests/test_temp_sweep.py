"""Boot-time sweep of stale download leftovers."""

from __future__ import annotations

import os
import time
from pathlib import Path

from sqlmodel import Session

from app.models import DownloadJob, JobStatus
from app.services import temp_sweep
from app.services.paths import STAGING_DIR_NAME

OLD = time.time() - 24 * 3600


def _touch(path: Path, *, age_ts: float | None = OLD) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")
    if age_ts is not None:
        os.utime(path, (age_ts, age_ts))
    return path


def test_is_temp_artifact():
    for name in (
        "a [x].f137.mp4.part",
        "a [x].ytdl",
        "a.temp.mp4",
        "a.norm.123.mp4",
        "a.compat.9.mp4",
        "a.xcode.9.mp4",
        "a [x].horde-h264.dl.f137.mp4",
        "a [x].horde-h264.enc.mp4",
    ):
        assert temp_sweep.is_temp_artifact(name), name
    for name in ("a [x].mp4", "a [x].horde-h264.mp4", "a.en.vtt"):
        assert not temp_sweep.is_temp_artifact(name), name


def test_sweep_removes_only_old_unreferenced_temp_files(init_db, add_video):
    root = init_db["downloads"]
    stale = _touch(root / "Chan/2024/a [x].f137.mp4.part")
    stale2 = _touch(root / "Chan/2024/a [x].norm.5.mp4")
    fresh = _touch(root / "Chan/2024/b [y].f137.mp4.part", age_ts=None)
    media = _touch(root / "Chan/2024/c [z].mp4")
    sidecar = _touch(root / "Chan/2024/c [z].horde-h264.mp4")
    # A library video that legitimately has ".temp." in its name is kept.
    add_video(write_file=True, file_path="Chan/notes.temp.mp4")
    kept = root / "Chan/notes.temp.mp4"
    os.utime(kept, (OLD, OLD))

    removed = temp_sweep.sweep_temp_artifacts(6)

    assert set(removed) == {stale, stale2}
    assert fresh.exists() and media.exists() and sidecar.exists() and kept.exists()


def test_sweep_spares_active_job_staging_and_reaps_finished(init_db):
    root = init_db["downloads"]
    with Session(init_db["engine"]) as s:
        active = DownloadJob(url="u1", status=JobStatus.queued)
        done = DownloadJob(url="u2", status=JobStatus.completed)
        s.add(active)
        s.add(done)
        s.commit()
        active_id, done_id = active.id, done.id
    resumable = _touch(root / STAGING_DIR_NAME / str(active_id) / "a.f1.mp4.part")
    finished = _touch(root / STAGING_DIR_NAME / str(done_id) / "a.f1.mp4.part")
    ghost = _touch(root / STAGING_DIR_NAME / "9999" / "a.mp4")

    temp_sweep.run_boot_cleanup()

    assert resumable.exists()
    assert not finished.parent.exists()
    assert not ghost.parent.exists()


def test_sweep_never_follows_symlinks_or_leaves_the_library(init_db, tmp_path):
    root = init_db["downloads"]
    outside = tmp_path / "outside"
    outside.mkdir()
    victim = _touch(outside / "keep.part")
    (root / "link").symlink_to(outside, target_is_directory=True)
    file_link = root / "dangling.part"
    file_link.symlink_to(victim)
    os.utime(file_link, (OLD, OLD), follow_symlinks=False)

    assert temp_sweep.sweep_temp_artifacts(6) == []
    assert victim.exists()
    assert file_link.is_symlink()


def test_sweep_can_be_disabled(init_db):
    stale = _touch(init_db["downloads"] / "a.part")
    assert temp_sweep.sweep_temp_artifacts(0) == []
    assert stale.exists()

"""Worker lifecycle: everything the lifespan starts stops again, children included."""

from __future__ import annotations

import logging
import os
import subprocess
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app import main
from app.models import DownloadJob, JobStatus
from app.security import HostPolicy
from app.services import ffmpeg_progress, scanner, sprites
from app.services.auth import accounts
from app.services.auth.runtime import AuthConfig, AuthRuntime
from app.services.downloads import errors, postprocess
from app.services.downloads.ffmpeg_queue import ffmpeg_queue
from app.services.downloads.queue import download_queue
from app.services.downloads.spec import JobSpec
from app.services.workers import BackgroundWorker, WorkerRegistry

EXPECTED_WORKERS = {
    "ffmpeg-children",
    "download-queue",
    "ffmpeg-queue",
    "download-reaper",
    "sprites",
    "scanner-watchdog",
    "scanner-poller",
    "metadata-sync",
    "horde-ai-worker",
    "horde-ai-timer",
    "horde-channel-catalog",
    "autodownload-poller",
    "live-poller",
    "subtitle-retry",
    "stream-ai",
    "job-metadata",
    "trash-purge",
    "notifications",
    "codec-probe-backfill",
    "nightly-backup",
}


def _live_thread_names() -> set[str]:
    return {t.name for t in threading.enumerate()}


def _wait_for(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


@pytest.fixture
def lifespan_env(init_db, monkeypatch):
    """The real app, with the work that would touch the network or disk stubbed."""
    monkeypatch.setattr("app.services.ytdlp_common.ensure_plugins_loaded", lambda: None)
    return init_db


def test_lifespan_starts_registers_and_stops_every_worker(lifespan_env):
    before = _live_thread_names()
    victim = subprocess.Popen(["sleep", "60"], start_new_session=True)
    started = time.monotonic()
    with TestClient(main.app) as client:
        registry = client.app.state.workers
        workers = registry.workers
        assert {w.name for w in workers} == EXPECTED_WORKERS
        assert all(w.healthy for w in workers)
        assert client.get("/api/ready").json()["ready"] is True
        # A stray ffmpeg-like child that no job will ever cancel.
        assert ffmpeg_progress.children.add(victim)
    elapsed = time.monotonic() - started

    assert elapsed < 20
    assert registry.workers == []
    assert not [w.name for w in workers if w.is_alive]
    assert _wait_for(lambda: victim.poll() is not None), "child process survived"
    leaked = {
        name
        for name in _live_thread_names() - before
        if name in EXPECTED_WORKERS or name.startswith(("sprites-", "download-"))
    }
    assert not leaked, f"worker threads still running: {leaked}"


def test_startup_failure_stops_the_workers_already_started(lifespan_env, monkeypatch):
    seen: list[WorkerRegistry] = []

    class Recording(WorkerRegistry):
        def __init__(self) -> None:
            super().__init__()
            seen.append(self)

    monkeypatch.setattr("app.services.workers.WorkerRegistry", Recording)

    def boom() -> BackgroundWorker:
        raise RuntimeError("cannot start")

    monkeypatch.setattr("app.services.subtitle_retry.create_worker", boom)
    with pytest.raises(RuntimeError, match="cannot start"), TestClient(main.app):
        pytest.fail("startup should have failed")

    # stop_all() emptied the registry; nothing it started may still be running.
    assert seen and seen[0].workers == []
    assert not [n for n in _live_thread_names() if n in EXPECTED_WORKERS]


def test_initial_library_scan_does_not_delay_startup(lifespan_env, monkeypatch):
    release = threading.Event()
    entered = threading.Event()

    def slow_scan(**_kwargs):
        entered.set()
        release.wait(30)
        return 0, 0

    monkeypatch.setattr(scanner, "scan_once", slow_scan)
    try:
        with TestClient(main.app) as client:
            # Startup finished and the API answers while the scan is still walking.
            assert entered.wait(5)
            assert client.get("/api/ping").json() == {"ok": True}
            assert not release.is_set()
            release.set()
    finally:
        release.set()


@pytest.mark.parametrize(
    ("trust_proxy", "hosts", "warns"),
    [
        (True, "", True),
        (True, "horde.example.com", False),
        (True, "*", False),
        (False, "", False),
    ],
)
def test_startup_warns_about_a_proxy_without_allowed_hosts(
    lifespan_env, monkeypatch, caplog, trust_proxy, hosts, warns
):
    monkeypatch.setattr(
        main.app.state, "host_policy", HostPolicy.from_env(hosts), raising=False
    )
    monkeypatch.setattr(
        main.app.state,
        "auth",
        AuthRuntime(config=AuthConfig(trust_proxy=trust_proxy)),
        raising=False,
    )

    with caplog.at_level(logging.WARNING, logger="app.main"), TestClient(main.app):
        pass

    mentioned = "HORDE_ALLOWED_HOSTS is empty" in caplog.text
    assert mentioned is warns


def test_event_streams_end_when_shutdown_starts(lifespan_env):
    with TestClient(main.app) as client:
        # The stream is for signed-in users: an anonymous request ends at once.
        with Session(client.app.state.ctx.engine) as session:
            user = accounts.create_user(session, "reader", "reader-password")
            client.cookies.set(
                accounts.SESSION_COOKIE, accounts.start_session(session, user)
            )
        done = threading.Event()
        lines: list[str] = []

        def read() -> None:
            with client.stream("GET", "/api/downloads/events") as response:
                for line in response.iter_lines():
                    lines.append(line)
            done.set()

        reader = threading.Thread(target=read, name="sse-reader", daemon=True)
        reader.start()
        time.sleep(0.5)
        assert not done.is_set()
        client.app.state.shutdown_event.set()
        assert done.wait(5), "the event stream ignored the shutdown signal"
        reader.join(5)


def test_registry_reports_a_worker_that_will_not_stop():
    release = threading.Event()
    stubborn = BackgroundWorker(
        "stubborn", lambda _w: release.wait(10), stop_timeout=0.1
    )
    polite = BackgroundWorker("polite", lambda w: w.sleep(30))
    registry = WorkerRegistry()
    registry.start(polite)
    registry.start(stubborn)
    try:
        assert registry.status() == {"polite": True, "stubborn": True}
        assert registry.stop_all() == ["stubborn"]
        assert not polite.is_alive
    finally:
        release.set()


def test_crashed_worker_is_unhealthy_and_finished_worker_is_not():
    def crash(_w: BackgroundWorker) -> None:
        raise RuntimeError("boom")

    crashed = BackgroundWorker("crashy", crash)
    finished = BackgroundWorker("oneshot", lambda _w: None)
    crashed.start()
    finished.start()
    crashed._thread.join(2)
    finished._thread.join(2)
    assert not crashed.healthy
    assert finished.healthy


def test_shutdown_requeues_running_downloads(init_db, monkeypatch):
    started = threading.Event()

    def blocking_download(job_id, cancel_event=None, queue=None):
        started.set()
        cancel_event.wait(30)
        raise errors.DownloadCancelled()

    monkeypatch.setattr(download_queue, "runner", blocking_download)
    with Session(init_db["engine"]) as session:
        job = DownloadJob(url="https://example.com/v", status=JobStatus.queued)
        session.add(job)
        session.commit()
        job_id = job.id

    download_queue.enqueue(job_id)
    assert started.wait(5)
    assert download_queue.stop(timeout=5)

    with Session(init_db["engine"]) as session:
        row = session.get(DownloadJob, job_id)
        # Not "cancelled": the next boot picks the job up again.
        assert row.status == JobStatus.queued
        assert row.paused is False
    # And a stopped queue starts nothing new.
    download_queue.enqueue(job_id)
    time.sleep(0.2)
    assert not download_queue.is_running(job_id)


def test_sprite_pool_never_starts_more_threads_than_its_limit(init_db, monkeypatch):
    gate = threading.Event()
    monkeypatch.setattr(sprites, "_build_sprites", lambda *_a: gate.wait(10))
    pool = sprites.SpritePool(concurrency=2)
    try:
        for video_id in range(1, 201):
            pool.enqueue(video_id, "test")
        time.sleep(0.2)
        sprite_threads = [
            t for t in threading.enumerate() if t.name.startswith("sprites-")
        ]
        assert len(sprite_threads) <= 2
        assert pool.in_progress(200)
    finally:
        gate.set()
    assert pool.wait_idle(10)
    assert pool.stop(timeout=5)
    assert not pool.in_progress(200)


def _script(tmp_path, body: str):
    path = tmp_path / "fake-ffmpeg"
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)
    return str(path)


def test_cancelling_ffmpeg_ends_its_whole_process_group(tmp_path):
    marker = tmp_path / "grandchild.pid"
    # The script forks a grandchild, like an ffmpeg helper would.
    cmd = _script(tmp_path, f"sleep 60 &\necho $! > {marker}\nwait")
    cancel = threading.Event()
    outcome: list[BaseException] = []

    def run() -> None:
        try:
            ffmpeg_progress.run_ffmpeg([cmd], cancel_event=cancel)
        except ffmpeg_progress.FfmpegCancelled as exc:
            outcome.append(exc)

    thread = threading.Thread(target=run, name="ffmpeg-test")
    thread.start()
    assert _wait_for(marker.exists)
    grandchild = int(marker.read_text())
    cancel.set()
    thread.join(10)
    assert not thread.is_alive()
    assert isinstance(outcome[0], ffmpeg_progress.FfmpegCancelled)
    assert _wait_for(lambda: not _pid_alive(grandchild))


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers signal 0; it is dead as far as we are concerned.
    try:
        with open(f"/proc/{pid}/stat") as fh:
            return fh.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


def test_a_child_that_ignores_sigterm_is_killed_after_the_grace_period():
    proc = subprocess.Popen(
        ["sh", "-c", "trap '' TERM; sleep 60"], start_new_session=True
    )
    time.sleep(0.2)
    started = time.monotonic()
    ffmpeg_progress.terminate_process(proc, grace=0.4)
    assert proc.poll() is not None
    assert time.monotonic() - started >= 0.4


def test_shutdown_refuses_new_ffmpeg_children(tmp_path):
    ffmpeg_progress.children.shutdown()
    with pytest.raises(ffmpeg_progress.FfmpegCancelled):
        ffmpeg_progress.run_ffmpeg([_script(tmp_path, "sleep 60")])


def test_stop_all_never_outlasts_its_total_budget():
    release = threading.Event()
    registry = WorkerRegistry()
    for n in range(6):
        registry.start(
            BackgroundWorker(f"stuck-{n}", lambda _w: release.wait(30), stop_timeout=5)
        )
    try:
        started = time.monotonic()
        stuck = registry.stop_all(total_timeout=0.6)
        elapsed = time.monotonic() - started
    finally:
        release.set()
    assert len(stuck) == 6
    assert elapsed < 2.5, f"six stuck workers held shutdown for {elapsed:.1f}s"


def test_shutdown_requeues_pending_postprocess_and_keeps_its_staging(init_db):
    """Whatever order the registry signals the queues in, a download that is
    waiting for its remux is requeued with its staged file, never cancelled."""
    from app.services.paths import STAGING_DIR_NAME

    with Session(init_db["engine"]) as session:
        job = DownloadJob(url="https://example.com/v", status=JobStatus.downloading)
        session.add(job)
        session.commit()
        job_id = job.id
    staging = init_db["downloads"] / STAGING_DIR_NAME / str(job_id)
    staging.mkdir(parents=True)
    finished = staging / "Clip.mp4"
    finished.write_bytes(b"x" * 100)

    queue, ffmpeg = download_queue, ffmpeg_queue
    queue.claim_ffmpeg(job_id)
    ffmpeg._pending.append(
        postprocess.PostprocessTask(
            spec=JobSpec(
                job_id=job_id, url="https://example.com/v", quality_preset="best"
            ),
            final_path=finished,
            info={},
            cancel_event=threading.Event(),
            staging_dir=staging,
        )
    )
    registry = WorkerRegistry()
    registry.start(queue)  # registered first, so signalled last
    registry.start(ffmpeg)
    assert registry.stop_all() == []

    with Session(init_db["engine"]) as session:
        assert session.get(DownloadJob, job_id).status == JobStatus.queued
    assert finished.exists()


def test_stopping_the_sprite_pool_kills_its_running_ffmpeg(
    add_video, init_db, monkeypatch
):
    """A sprite build whose ffmpeg is mid-run no longer outlives shutdown."""
    from app.services import metadata

    marker = init_db["data"] / "grandchild.pid"
    fake = init_db["data"] / "fake-ffmpeg"
    fake.write_text(f"#!/bin/sh\nsleep 120 &\necho $! > {marker}\nwait\n")
    fake.chmod(0o755)
    monkeypatch.setattr(metadata, "ffmpeg_bin", lambda: str(fake))
    video = add_video(write_file=True, duration_sec=300.0)

    pool = sprites.SpritePool(concurrency=1)
    assert pool.enqueue(video.id, "test")
    assert _wait_for(marker.exists), "the fake ffmpeg never started"
    assert ffmpeg_progress.children.running() == 1

    started = time.monotonic()
    assert pool.stop(timeout=10)
    assert time.monotonic() - started < 8
    assert ffmpeg_progress.children.running() == 0
    assert _wait_for(lambda: not _pid_alive(int(marker.read_text())))
    assert not pool.in_progress(video.id)


def test_signal_wrapper_sets_the_event_and_chains_to_the_previous_handler():
    import signal

    seen: list[int] = []
    original = signal.signal(signal.SIGTERM, lambda signum, _f: seen.append(signum))
    try:
        event = threading.Event()
        restore = main._install_shutdown_signals(event)
        signal.raise_signal(signal.SIGTERM)
        assert event.is_set()
        assert seen == [signal.SIGTERM]
        restore()
        assert signal.getsignal(signal.SIGTERM) is not None
    finally:
        signal.signal(signal.SIGTERM, original)


def test_signal_wrapper_leaves_an_ignored_signal_alone():
    import signal

    original = signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        event = threading.Event()
        restore = main._install_shutdown_signals(event)
        assert signal.getsignal(signal.SIGTERM) == signal.SIG_IGN
        signal.raise_signal(signal.SIGTERM)  # ignored: nothing shuts down
        assert not event.is_set()
        restore()
        assert signal.getsignal(signal.SIGTERM) == signal.SIG_IGN
    finally:
        signal.signal(signal.SIGTERM, original)


def test_shutdown_logs_how_many_workers_stop_and_each_result(caplog):
    import logging

    caplog.set_level(logging.INFO, logger="app.services.workers")
    registry = WorkerRegistry()
    registry.start(BackgroundWorker("one", lambda w: w.sleep(30)))
    registry.start(BackgroundWorker("two", lambda w: w.sleep(30)))
    registry.stop_all()
    messages = [r.getMessage() for r in caplog.records]
    assert messages[0] == "stopping 2 background workers"
    assert messages[1:] == ["worker two stopped", "worker one stopped"]


def test_lifespan_restores_the_previous_context_on_shutdown(lifespan_env):
    from app import context

    before = context.current()
    with TestClient(main.app):
        assert context.current() is not before
        assert main.app.state.ctx is context.current()
    assert context.current() is before
    assert not hasattr(main.app.state, "ctx")


def test_failed_init_db_leaves_no_context_behind(lifespan_env, monkeypatch):
    from app import context

    before = context.current()

    def boom(_engine=None):
        raise RuntimeError("migration failed")

    monkeypatch.setattr(main, "init_db", boom)
    with pytest.raises(RuntimeError, match="migration failed"), TestClient(main.app):
        pass
    assert context.current() is before
    assert not hasattr(main.app.state, "ctx")


def test_startup_sanitizes_the_stored_ui_custom_css(lifespan_env, caplog):
    """Custom CSS saved before the sanitizer existed is cleaned once, at startup."""
    from app.services import app_settings

    evil = "@import url(http://evil.example/x.css); body{color:red}"
    app_settings.save({"ui": {"theme": "ember", "customCss": evil}})

    with caplog.at_level(logging.WARNING), TestClient(main.app):
        pass
    ui = app_settings.load()["ui"]
    assert ui == {"theme": "ember", "customCss": " body{color:red}"}
    assert "custom CSS" in caplog.text

    # Idempotent: a clean blob is left alone (no rewrite, no warning).
    caplog.clear()
    with caplog.at_level(logging.WARNING), TestClient(main.app):
        pass
    assert app_settings.load()["ui"] == ui
    assert "custom CSS" not in caplog.text

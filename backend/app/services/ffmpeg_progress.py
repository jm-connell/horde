"""Run ffmpeg with -progress parsing so the download bar can move during encode."""

from __future__ import annotations

import contextlib
import logging
import os
import signal
import subprocess
import threading
import time
from collections.abc import Callable

from .workers import CallbackWorker

logger = logging.getLogger(__name__)

#: Seconds an ffmpeg child gets to exit after SIGTERM before it is killed.
TERMINATE_GRACE_SEC = 3.0


class FfmpegCancelled(Exception):
    """ffmpeg was killed because the download job was cancelled."""


def terminate_process(
    proc: subprocess.Popen[bytes], grace: float = TERMINATE_GRACE_SEC
) -> None:
    """Stop ``proc`` and everything it spawned: SIGTERM, then SIGKILL after ``grace``.

    ``grace <= 0`` skips SIGTERM and kills at once.

    ffmpeg is started in its own session (``start_new_session``), so signalling the
    process group also reaches helpers it forks.
    """
    if proc.poll() is not None:
        return

    def send(sig: signal.Signals) -> None:
        try:
            if hasattr(os, "killpg"):
                os.killpg(proc.pid, sig)
            elif sig == signal.SIGTERM:
                proc.terminate()
            else:
                proc.kill()
        except (ProcessLookupError, PermissionError):
            return  # already gone

    hard_kill = getattr(signal, "SIGKILL", signal.SIGTERM)
    if grace > 0:
        send(signal.SIGTERM)
        try:
            proc.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            logger.warning("ffmpeg pid %s ignored SIGTERM; killing it", proc.pid)
    send(hard_kill)
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=5)


class ChildProcesses:
    """The ffmpeg processes `run_ffmpeg` has running, so shutdown can end them.

    Subprocesses are a process-wide resource, so one instance (``children``) serves
    the whole process. After ``shutdown()`` new spawns are refused until ``reopen()``.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._procs: set[subprocess.Popen[bytes]] = set()
        self._closed = False

    def add(self, proc: subprocess.Popen[bytes]) -> bool:
        with self._lock:
            if self._closed:
                return False
            self._procs.add(proc)
            return True

    def discard(self, proc: subprocess.Popen[bytes]) -> None:
        with self._lock:
            self._procs.discard(proc)

    def running(self) -> int:
        with self._lock:
            return sum(1 for p in self._procs if p.poll() is None)

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def reopen(self) -> None:
        with self._lock:
            self._closed = False

    def shutdown(self, grace: float = TERMINATE_GRACE_SEC) -> int:
        """Refuse new spawns and terminate the running ones. Returns how many."""
        with self._lock:
            self._closed = True
            procs = [p for p in self._procs if p.poll() is None]
        threads = [
            threading.Thread(target=terminate_process, args=(p, grace)) for p in procs
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return len(procs)


children = ChildProcesses()


def _stop_children(_timeout: float) -> None:
    children.shutdown()


def children_worker() -> CallbackWorker:
    """Registry entry that ends any ffmpeg still running at shutdown.

    Register it first: workers stop newest-first, so it runs last, after the
    queues have asked their own encodes to cancel.
    """
    return CallbackWorker(
        "ffmpeg-children",
        start=children.reopen,
        stop=_stop_children,
        is_alive=lambda: not children.closed,
    )


def parse_out_time_seconds(line: str) -> float | None:
    """Parse one ffmpeg -progress line into seconds, if it carries out_time."""
    raw = (line or "").strip()
    if raw.startswith(("out_time_ms=", "out_time_us=")):
        try:
            # ffmpeg names out_time_ms but the unit is microseconds.
            return max(0.0, int(raw.split("=", 1)[1]) / 1_000_000.0)
        except ValueError:
            return None
    if raw.startswith("out_time="):
        stamp = raw.split("=", 1)[1].strip()
        if stamp in {"N/A", "n/a"}:
            return None
        parts = stamp.split(":")
        try:
            if len(parts) == 3:
                hours, minutes, sec = parts
                return int(hours) * 3600 + int(minutes) * 60 + float(sec)
            if len(parts) == 2:
                return int(parts[0]) * 60 + float(parts[1])
        except ValueError:
            return None
    return None


def progress_percent(out_time: float, duration: float | None) -> float:
    if not duration or duration <= 0:
        return 0.0
    return min(100.0, max(0.0, (out_time / duration) * 100.0))


def _with_progress_args(cmd: list[str]) -> list[str]:
    if not cmd or "-progress" in cmd:
        return cmd
    return [cmd[0], "-nostats", "-progress", "pipe:1", *cmd[1:]]


def run_ffmpeg(
    cmd: list[str],
    *,
    duration: float | None = None,
    on_progress: Callable[[float], None] | None = None,
    cancel_event: threading.Event | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[bytes]:
    """Run ffmpeg, optionally reporting 0–100 progress from out_time.

    Raises FfmpegCancelled when ``cancel_event`` is set.
    """
    full = _with_progress_args(list(cmd))
    proc = subprocess.Popen(
        full,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    if not children.add(proc):
        terminate_process(proc, 0.0)
        raise FfmpegCancelled()
    stderr_chunks: list[bytes] = []
    stdout_chunks: list[bytes] = []
    watch_error: list[BaseException] = []
    start = time.monotonic()

    def _read_stderr() -> None:
        if proc.stderr is None:
            return
        try:
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                stderr_chunks.append(chunk)
        except OSError:
            return

    def _watch() -> None:
        while proc.poll() is None:
            if cancel_event is not None and cancel_event.is_set():
                watch_error.append(FfmpegCancelled())
                terminate_process(proc)
                return
            if timeout is not None and (time.monotonic() - start) > timeout:
                terminate_process(proc, 0.0)
                watch_error.append(subprocess.TimeoutExpired(full, timeout))
                return
            time.sleep(0.2)

    err_thread = threading.Thread(target=_read_stderr, daemon=True)
    watch_thread = threading.Thread(target=_watch, daemon=True)
    err_thread.start()
    watch_thread.start()

    try:
        if proc.stdout is not None:
            for raw_line in proc.stdout:
                stdout_chunks.append(raw_line)
                text = raw_line.decode("utf-8", "replace")
                out_time = parse_out_time_seconds(text)
                if out_time is None or on_progress is None:
                    continue
                try:
                    on_progress(progress_percent(out_time, duration))
                except Exception:
                    logger.debug("ffmpeg progress callback failed", exc_info=True)
        code = proc.wait()
        err_thread.join(timeout=2)
        if watch_error:
            raise watch_error[0]
        if cancel_event is not None and cancel_event.is_set():
            raise FfmpegCancelled()
        stdout = b"".join(stdout_chunks)
        stderr = b"".join(stderr_chunks)
        if code != 0:
            raise subprocess.CalledProcessError(
                code, full, output=stdout, stderr=stderr
            )
        return subprocess.CompletedProcess(full, code, stdout, stderr)
    except FfmpegCancelled:
        terminate_process(proc, 0.0)
        raise
    finally:
        terminate_process(proc, 0.0)
        children.discard(proc)
        err_thread.join(timeout=1)
        watch_thread.join(timeout=1)

"""Run ffmpeg with -progress parsing so the download bar can move during encode."""

from __future__ import annotations

import logging
import subprocess
import threading
import time
from typing import Callable, Optional

logger = logging.getLogger(__name__)


class FfmpegCancelled(Exception):
    """ffmpeg was killed because the download job was cancelled."""


def parse_out_time_seconds(line: str) -> Optional[float]:
    """Parse one ffmpeg -progress line into seconds, if it carries out_time."""
    raw = (line or "").strip()
    if raw.startswith("out_time_ms=") or raw.startswith("out_time_us="):
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


def progress_percent(out_time: float, duration: Optional[float]) -> float:
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
    duration: Optional[float] = None,
    on_progress: Optional[Callable[[float], None]] = None,
    cancel_event: Optional[threading.Event] = None,
    timeout: Optional[float] = None,
) -> subprocess.CompletedProcess[bytes]:
    """Run ffmpeg, optionally reporting 0–100 progress from out_time.

    Raises FfmpegCancelled when ``cancel_event`` is set.
    """
    full = _with_progress_args(list(cmd))
    proc = subprocess.Popen(
        full,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
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
                proc.kill()
                return
            if timeout is not None and (time.monotonic() - start) > timeout:
                proc.kill()
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
                except Exception:  # noqa: BLE001
                    pass
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
        try:
            proc.kill()
        except OSError:
            pass
        raise
    finally:
        try:
            proc.kill()
        except OSError:
            pass
        err_thread.join(timeout=1)
        watch_thread.join(timeout=1)

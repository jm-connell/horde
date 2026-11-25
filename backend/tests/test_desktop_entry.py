"""The desktop entry point: serves, ignores unknown lifeline lines, stops at EOF.

Runs the real ``python -m app.desktop_entry`` as a subprocess, the way the desktop
shell starts it. Portable on purpose (Windows and macOS run this suite too): no
signals, no POSIX-only calls, and a data folder with a space and a non-ASCII name.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from types import SimpleNamespace

from app import desktop_entry

BACKEND = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _ping(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/ping", timeout=2
        ) as resp:
            return bool(resp.status == 200)
    except OSError:  # URLError is one
        return False


def _accepts(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def _wait_for(check, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.2)
    return False


def test_serves_then_stops_when_stdin_closes(tmp_path):
    root = tmp_path / "hörde data"
    data = root / "data"
    port = _free_port()
    env = {
        **os.environ,
        "HOST": "127.0.0.1",
        "PORT": str(port),
        "HORDE_RUNTIME": "desktop",
        # No network workers; "setup" mode seeds nobody, as on a first run.
        "HORDE_E2E": "1",
        "HORDE_E2E_MODE": "setup",
        "DATA_DIR": str(data),
        "DOWNLOADS_DIR": str(root / "downloads"),
    }
    log_path = tmp_path / "server.log"
    with log_path.open("wb") as log:
        proc = subprocess.Popen(
            [sys.executable, "-m", "app.desktop_entry"],
            cwd=BACKEND,
            env=env,
            stdin=subprocess.PIPE,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            assert proc.stdin is not None
            _wait_for(lambda: proc.poll() is not None or _ping(port), 120)
            assert _ping(port), f"server never answered (exit code {proc.poll()})"

            status_file = data / "desktop" / "status.json"
            assert _wait_for(status_file.is_file, 10), "no status file"
            status = json.loads(status_file.read_text(encoding="utf-8"))
            assert status["setup_required"] is True
            assert status["busy"] is False

            proc.stdin.write(b"unknown\n")
            proc.stdin.flush()
            time.sleep(0.5)
            assert _ping(port), "an unknown lifeline line stopped the server"

            proc.stdin.close()
            assert proc.wait(timeout=20) == 0
            assert not _accepts(port)
        except BaseException:
            print(log_path.read_text(encoding="utf-8", errors="replace"))
            raise
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)


def test_lifeline_waits_on_an_empty_non_blocking_pipe_until_end_of_file(
    monkeypatch, caplog
):
    """No data yet is not the end: only end of file stops the server."""
    monkeypatch.setattr(desktop_entry, "_POLL_SEC", 0.05)
    caplog.set_level(logging.WARNING, logger="app.desktop_entry")
    read_end, write_end = os.pipe()
    os.set_blocking(read_end, False)
    server = SimpleNamespace(should_exit=False)
    watcher = threading.Thread(
        target=desktop_entry._watch_lifeline, args=(server, read_end)
    )
    watcher.start()
    try:
        time.sleep(0.3)
        assert server.should_exit is False
        os.write(write_end, b"unknown\n")
        time.sleep(0.2)
        assert server.should_exit is False
    finally:
        os.close(write_end)
        watcher.join(5)
        os.close(read_end)
    assert not watcher.is_alive()
    assert server.should_exit is True
    assert "non-blocking" in caplog.text
    assert "reached end of file" in caplog.text


def test_lifeline_read_error_stops_the_server_and_says_why(caplog):
    read_end, write_end = os.pipe()
    os.close(read_end)
    os.close(write_end)
    server = SimpleNamespace(should_exit=False)
    with caplog.at_level(logging.WARNING, logger="app.desktop_entry"):
        desktop_entry._watch_lifeline(server, read_end)
    assert server.should_exit is True
    assert "reading standard input failed (OSError(" in caplog.text

"""The desktop entry point: serves, ignores unknown lifeline lines, stops at EOF.

Runs the real ``python -m app.desktop_entry`` as a subprocess, the way the desktop
shell starts it. Portable on purpose (Windows and macOS run this suite too): no
signals, no POSIX-only calls, and a data folder with a space and a non-ASCII name.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

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
            _wait_for(lambda: proc.poll() is not None or _ping(port), 30)
            assert _ping(port), "server never answered"

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

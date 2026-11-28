"""docker/entrypoint.sh started as a non-root user (`docker run --user`, TrueNAS Apps).

The container then cannot create accounts, chown or switch users, so the
entrypoint must run the app as the user it was started as.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[2] / "docker" / "entrypoint.sh"

pytestmark = [
    pytest.mark.skipif(
        sys.platform != "linux",
        reason="docker/entrypoint.sh runs only inside the Linux image",
    ),
    # Short-circuits off Linux, where os.geteuid does not exist (Windows).
    pytest.mark.skipif(
        sys.platform == "linux" and os.geteuid() == 0,
        reason="needs a non-root user, like `docker run --user`",
    ),
]


def _run(tmp_path: Path, **env: str) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    # None of these may run without root: fail loudly if the entrypoint tries.
    for tool in ("gosu", "groupadd", "useradd", "chown"):
        stub = bin_dir / tool
        stub.write_text(f"#!/bin/sh\necho 'unexpected {tool}' >&2\nexit 99\n")
        stub.chmod(0o755)
    data = tmp_path / "data"
    downloads = tmp_path / "downloads"
    data.mkdir(exist_ok=True)
    downloads.mkdir(exist_ok=True)
    return subprocess.run(
        ["bash", str(ENTRYPOINT), "sh", "-c", 'echo "app uid=$(id -u)"'],
        capture_output=True,
        text=True,
        check=False,
        env={
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "DATA_DIR": str(data),
            "DOWNLOADS_DIR": str(downloads),
            "BUILD_INFO_FILE": str(tmp_path / "none"),
            # Set by a compose file written for the root start; ignored here.
            "PUID": "1234",
            "PGID": "1234",
            **env,
        },
    )


def test_runs_the_app_as_the_starting_user(tmp_path):
    result = _run(tmp_path)
    assert result.returncode == 0, result.stderr + result.stdout
    assert f"app uid={os.geteuid()}" in result.stdout
    assert "unexpected" not in result.stderr
    assert (tmp_path / "data" / "thumbnails").is_dir()


def test_puid_zero_is_not_refused_when_not_root(tmp_path):
    # The process is not root whatever PUID says, so there is nothing to refuse.
    result = _run(tmp_path, PUID="0", PGID="0")
    assert result.returncode == 0, result.stderr + result.stdout
    assert f"app uid={os.geteuid()}" in result.stdout


def test_unwritable_data_dir_stops_with_the_fix(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    data.chmod(0o555)
    try:
        result = _run(tmp_path)
    finally:
        data.chmod(0o755)
    assert result.returncode == 1
    assert "is not writable" in result.stderr
    assert "app uid" not in result.stdout


def test_unwritable_media_folder_is_reported(tmp_path):
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    downloads.chmod(0o555)
    try:
        result = _run(tmp_path)
    finally:
        downloads.chmod(0o755)
    assert result.returncode == 0, result.stderr + result.stdout
    assert "not writable" in result.stderr

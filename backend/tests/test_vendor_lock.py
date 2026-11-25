"""scripts/check_vendor_lock.py: the desktop app's pinned programs stay complete
and in step with the image."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_vendor_lock.py"
LOCK = REPO / "desktop" / "vendor.lock.json"


def _check(lock: Path, dockerfile: Path = REPO / "Dockerfile"):
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(lock), str(dockerfile)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_the_committed_lock_passes():
    done = _check(LOCK)
    assert done.returncode == 0, done.stderr


def test_a_deno_version_that_differs_from_the_image_fails(tmp_path):
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    lock["deno"]["version"] = "0.0.1"
    changed = tmp_path / "vendor.lock.json"
    changed.write_text(json.dumps(lock), encoding="utf-8")
    done = _check(changed)
    assert done.returncode == 1
    assert "bump both together" in done.stderr


def test_a_missing_target_or_bad_hash_fails(tmp_path):
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    del lock["ffmpeg"]["targets"]["win32-x64"]
    lock["python"]["targets"]["linux-x64"]["sha256"] = "abc"
    changed = tmp_path / "vendor.lock.json"
    changed.write_text(json.dumps(lock), encoding="utf-8")
    done = _check(changed)
    assert done.returncode == 1
    assert "ffmpeg: no entry for win32-x64" in done.stderr
    assert "python linux-x64: sha256" in done.stderr

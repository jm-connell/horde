"""scripts/check_release_assets.py: a release is published only with every
desktop file present."""

from __future__ import annotations

import hashlib
import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_release_assets.py"

_spec = importlib.util.spec_from_file_location("check_release_assets", SCRIPT)
assert _spec and _spec.loader
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
EVERY_ASSET = _module.expected(["windows", "mac", "linux"])
INSTALLERS = [name for name in EVERY_ASSET if name.endswith(_module.INSTALLERS)]


def _complete(folder: Path) -> Path:
    sums = []
    for name in EVERY_ASSET:
        data = f"contents of {name}".encode()
        (folder / name).write_bytes(data)
        if name in INSTALLERS:
            sums.append(f"{hashlib.sha256(data).hexdigest()}  {name}")
    (folder / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    return folder


def _check(folder: Path, *extra: str):
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(folder), *extra],
        capture_output=True,
        text=True,
        check=False,
    )


def test_a_complete_folder_passes(tmp_path):
    done = _check(_complete(tmp_path))
    assert done.returncode == 0, done.stderr


@pytest.mark.parametrize("name", [*EVERY_ASSET, "SHA256SUMS"])
def test_any_missing_file_fails_and_is_named(tmp_path, name):
    (_complete(tmp_path) / name).unlink()
    done = _check(tmp_path)
    assert done.returncode == 1
    assert f"missing {name}" in done.stderr


def test_an_installer_that_does_not_match_its_listed_hash_fails(tmp_path):
    (_complete(tmp_path) / INSTALLERS[0]).write_bytes(b"something else")
    done = _check(tmp_path)
    assert done.returncode == 1
    assert f"wrong hash for {INSTALLERS[0]}" in done.stderr


def test_a_system_left_out_of_the_release_is_not_required(tmp_path):
    folder = _complete(tmp_path)
    for name in _module.ASSETS["mac"]:
        (folder / name).unlink()
    assert _check(folder).returncode == 1
    assert _check(folder, "--targets", "windows,linux").returncode == 0

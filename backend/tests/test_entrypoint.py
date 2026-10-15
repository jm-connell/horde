"""docker/entrypoint.sh: ownership repair and the root refusal, with stubbed gosu."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[2] / "docker" / "entrypoint.sh"

pytestmark = pytest.mark.skipif(
    os.geteuid() != 0, reason="needs root to create files owned by another uid"
)


@pytest.fixture
def tmp_path():
    """World-traversable temp dir: the dropped-privilege user must reach it."""
    path = Path(tempfile.mkdtemp(prefix="horde-entrypoint-"))
    path.chmod(0o755)
    yield path
    shutil.rmtree(path, ignore_errors=True)


def _run(tmp_path: Path, **env: str) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    # The image provides gosu; here it just runs the command. getent says the
    # user/group already exist so no accounts are created on the test host.
    # setpriv drops privileges like gosu, so directories the entrypoint creates
    # "as the runtime user" really are owned by it.
    (bin_dir / "gosu").write_text(
        "#!/bin/bash\n"
        'exec setpriv --reuid="${1%%:*}" --regid="${1##*:}" --clear-groups -- "${@:2}"\n'
    )
    (bin_dir / "getent").write_text("#!/bin/sh\nexit 0\n")
    for stub in bin_dir.iterdir():
        stub.chmod(0o755)
    data = tmp_path / "data"
    downloads = tmp_path / "downloads"
    data.mkdir(exist_ok=True)
    downloads.mkdir(exist_ok=True)
    return subprocess.run(
        ["bash", str(ENTRYPOINT), "true"],
        capture_output=True,
        text=True,
        check=False,
        env={
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "DATA_DIR": str(data),
            "DOWNLOADS_DIR": str(downloads),
            "BUILD_INFO_FILE": str(tmp_path / "none"),
            "PUID": "1234",
            "PGID": "1234",
            **env,
        },
    )


def _owner(path: Path) -> tuple[int, int]:
    info = path.stat()
    return info.st_uid, info.st_gid


def test_first_start_takes_ownership_of_the_data_dir(tmp_path):
    result = _run(tmp_path)
    assert result.returncode == 0, result.stderr + result.stdout
    assert "chown -R 1234:1234" in result.stdout
    assert _owner(tmp_path / "data") == (1234, 1234)
    assert _owner(tmp_path / "data" / "thumbnails") == (1234, 1234)


def test_second_start_does_not_walk_an_owned_tree(tmp_path):
    assert _run(tmp_path).returncode == 0
    result = _run(tmp_path)
    assert result.returncode == 0
    assert "chown" not in result.stdout


def test_root_owned_file_in_an_owned_dir_is_repaired(tmp_path):
    assert _run(tmp_path).returncode == 0
    # What a rollback leaves behind: a restored database owned by root inside a
    # directory that already belongs to PUID:PGID.
    restored = tmp_path / "data" / "horde.db"
    restored.write_text("db")
    os.chown(restored, 0, 0)

    result = _run(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "chown -R" in result.stdout
    assert _owner(restored) == (1234, 1234)


def test_root_is_refused_unless_explicitly_allowed(tmp_path):
    refused = _run(tmp_path, PUID="0", PGID="0")
    assert refused.returncode == 1
    assert "refusing to run as root" in refused.stderr

    allowed = _run(tmp_path, PUID="0", PGID="0", HORDE_ALLOW_ROOT="1")
    assert allowed.returncode == 0, allowed.stderr

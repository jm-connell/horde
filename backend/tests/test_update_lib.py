"""Regression: host volume paths and .env survive the TrueNAS update script."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LIB = REPO / "scripts" / "update_lib.sh"
UPDATE_SH = REPO / "update.sh"


def _run(script: str, *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    bash = f"set -euo pipefail\nsource '{LIB}'\n{script}\n"
    return subprocess.run(
        ["bash", "-c", bash],
        cwd=cwd or REPO,
        capture_output=True,
        text=True,
        check=False,
    )


def _check(script: str, *, cwd: Path | None = None) -> str:
    result = _run(script, cwd=cwd)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    return result.stdout


def test_update_scripts_are_valid_bash():
    for path in (LIB, UPDATE_SH):
        result = subprocess.run(
            ["bash", "-n", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, f"{path}: {result.stderr}"


def test_env_get_handles_quotes_export_and_last_assignment(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "# comment\n"
        "DOWNLOADS_PATH=/old\n"
        "export DATA_PATH='/mnt/tank/data'\n"
        'DOWNLOADS_PATH="/mnt/tank/media/YouTube Archive"\n'
        "PUID=1000\n",
        encoding="utf-8",
    )
    out = _check(
        f"""
        printf '%s\\n' "$(horde_env_get '{env}' DOWNLOADS_PATH)"
        printf '%s\\n' "$(horde_env_get '{env}' DATA_PATH)"
        printf 'missing=%s\\n' "$(horde_env_get '{env}' MISSING)"
        """
    )
    lines = out.splitlines()
    assert lines[0] == "/mnt/tank/media/YouTube Archive"
    assert lines[1] == "/mnt/tank/data"
    assert lines[2] == "missing="


def test_env_upsert_replaces_empty_and_does_not_duplicate(tmp_path):
    env = tmp_path / ".env"
    env.write_text("PUID=1000\nDOWNLOADS_PATH=\n", encoding="utf-8")
    _check(
        f"""
        horde_env_upsert '{env}' DOWNLOADS_PATH '/mnt/real/media'
        horde_env_upsert '{env}' DOWNLOADS_PATH '/mnt/real/media'
        horde_env_set_if_missing '{env}' PUID '568'
        horde_env_set_if_missing '{env}' DATA_PATH '/mnt/real/data'
        """
    )
    text = env.read_text(encoding="utf-8")
    assert text.count("DOWNLOADS_PATH=") == 1
    assert "DOWNLOADS_PATH=/mnt/real/media" in text
    assert "PUID=1000" in text
    assert "PUID=568" not in text
    assert "DATA_PATH=/mnt/real/data" in text


def test_seed_env_prefers_live_container_paths_over_stale_env(tmp_path):
    env = tmp_path / ".env"
    snap = tmp_path / "live.env"
    env.write_text(
        "DOWNLOADS_PATH=/mnt/tank/media/youtube_archive\n"
        "DATA_PATH=/opt/dockge/horde/data\n",
        encoding="utf-8",
    )
    snap.write_text(
        "DOWNLOADS_PATH=/mnt/tank/media/actual_library\n"
        "DATA_PATH=/mnt/tank/apps/horde-data\n"
        "PUID=568\n",
        encoding="utf-8",
    )
    _check(f"horde_seed_env_from_snapshot '{env}' '{snap}'")
    text = env.read_text(encoding="utf-8")
    assert "DOWNLOADS_PATH=/mnt/tank/media/actual_library" in text
    assert "DATA_PATH=/mnt/tank/apps/horde-data" in text
    assert "PUID=568" in text
    assert "/opt/dockge/horde/data" not in text


def test_guard_blocks_volume_path_change():
    result = _run(
        """
        if horde_guard_volume_paths \\
            /mnt/live/media /mnt/live/data \\
            /mnt/tank/media/youtube_archive /opt/dockge/horde/data; then
          echo ALLOWED
          exit 0
        fi
        echo BLOCKED
        """
    )
    assert result.returncode == 0
    assert "BLOCKED" in result.stdout
    assert "DOWNLOADS_PATH would change" in result.stderr
    assert "DATA_PATH would change" in result.stderr


def test_guard_allows_same_paths_with_trailing_slash():
    result = _run(
        """
        horde_guard_volume_paths \\
            /mnt/live/media /mnt/live/data/ \\
            /mnt/live/media/ /mnt/live/data
        echo OK
        """
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_extract_bind_mounts_from_compose_json():
    json_cfg = """
    {
      "services": {
        "horde": {
          "volumes": [
            {"type": "bind", "source": "/mnt/media", "target": "/downloads"},
            {"type": "bind", "source": "/mnt/data", "target": "/app/data"}
          ]
        }
      }
    }
    """
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"set -euo pipefail; source '{LIB}'; horde_extract_horde_bind_mounts",
        ],
        input=json_cfg,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    lines = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    assert lines["/downloads"] == "/mnt/media"
    assert lines["/app/data"] == "/mnt/data"


def test_git_pull_keeps_env_and_recovers_compose_conflicts(tmp_path):
    work = tmp_path / "stack"
    other = tmp_path / "other"
    origin = tmp_path / "origin.git"
    work.mkdir()

    def git(repo: Path, *args: str) -> None:
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.com",
        }
        subprocess.run(
            ["git", "-C", str(repo), *args],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )

    init = subprocess.run(
        ["git", "init", "-b", "main", str(work)],
        capture_output=True,
        text=True,
        check=False,
    )
    if init.returncode != 0:
        subprocess.run(["git", "init", str(work)], check=True, capture_output=True)
        git(work, "checkout", "-B", "main")
    git(work, "config", "user.email", "test@example.com")
    git(work, "config", "user.name", "Test")
    (work / ".gitignore").write_text(".env\n", encoding="utf-8")
    (work / "docker-compose.yml").write_text(
        "services:\n"
        "  horde:\n"
        "    volumes:\n"
        "      - ${DOWNLOADS_PATH:-/mnt/tank/media/youtube_archive}:/downloads\n"
        "      - ${DATA_PATH:-/opt/dockge/horde/data}:/app/data\n",
        encoding="utf-8",
    )
    (work / ".env").write_text(
        "DOWNLOADS_PATH=/mnt/custom/media\nDATA_PATH=/mnt/custom/data\n",
        encoding="utf-8",
    )
    git(work, "add", ".gitignore", "docker-compose.yml")
    git(work, "commit", "-m", "initial")
    subprocess.run(
        ["git", "clone", "--bare", str(work), str(origin)],
        check=True,
        capture_output=True,
    )
    git(work, "remote", "add", "origin", str(origin))
    git(work, "push", "-u", "origin", "main")

    subprocess.run(["git", "clone", str(origin), str(other)], check=True, capture_output=True)
    git(other, "config", "user.email", "test@example.com")
    git(other, "config", "user.name", "Test")
    compose = (other / "docker-compose.yml").read_text(encoding="utf-8")
    (other / "docker-compose.yml").write_text(
        compose + "    image: horde:latest\n",
        encoding="utf-8",
    )
    git(other, "add", "docker-compose.yml")
    git(other, "commit", "-m", "upstream compose tweak")
    git(other, "push", "origin", "main")

    # Dockge-style local edit: hardcode volume paths in the tracked compose file.
    (work / "docker-compose.yml").write_text(
        "services:\n"
        "  horde:\n"
        "    volumes:\n"
        "      - /mnt/custom/media:/downloads\n"
        "      - /mnt/custom/data:/app/data\n",
        encoding="utf-8",
    )

    result = _run("horde_git_pull", cwd=work)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr

    env_text = (work / ".env").read_text(encoding="utf-8")
    assert "DOWNLOADS_PATH=/mnt/custom/media" in env_text
    assert "DATA_PATH=/mnt/custom/data" in env_text

    compose_text = (work / "docker-compose.yml").read_text(encoding="utf-8")
    assert "<<<<<<<" not in compose_text
    assert ">>>>>>>" not in compose_text
    assert (
        "horde:latest" in compose_text
        or "DOWNLOADS_PATH" in compose_text
        or "/mnt/custom/media" in compose_text
    )

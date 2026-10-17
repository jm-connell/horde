"""``python -m app.export_openapi`` writes a stable, complete schema."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def _run(*args: str, cwd: Path = BACKEND) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "app.export_openapi", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )


def test_export_writes_the_schema_and_check_detects_drift(tmp_path):
    target = tmp_path / "openapi.json"
    done = _run(str(target))
    assert done.returncode == 0, done.stderr
    schema = json.loads(target.read_text())
    assert schema["openapi"].startswith("3.")
    assert "/api/videos" in schema["paths"]
    assert "VideoPage" in schema["components"]["schemas"]
    assert "ErrorResponse" in schema["components"]["schemas"]
    assert "/api/e2e/reset" not in schema["paths"]

    assert _run("--check", str(target)).returncode == 0
    target.write_text("{}\n")
    assert _run("--check", str(target)).returncode == 1

"""scripts/release_notes.py: a tag's CHANGELOG section becomes its release page."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "release_notes.py"

CHANGELOG = """\
# Changelog

## [Unreleased]

- Not released yet.

## [1.2.0] - 2026-10-29

Clips and a help chat.

### Upgrade notes

- **One migration** runs at startup. Rolling back needs a
  [restored backup](docs/ops/backup.md#restore), see
  [the guide](https://example.com/guide) or [below](#added).

### Added

- Clips.
  Several per video.
- Help chat.

## [1.1.1] - 2026-10-26

- Older change.

[Unreleased]: https://github.com/o/r/compare/v1.2.0...main
[1.2.0]: https://github.com/o/r/compare/v1.1.1...v1.2.0
"""


def _run(tmp_path: Path, tag: str) -> subprocess.CompletedProcess[str]:
    path = tmp_path / "CHANGELOG.md"
    path.write_text(CHANGELOG)
    return subprocess.run(
        [sys.executable, str(SCRIPT), tag, "o/r", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_prints_only_the_tagged_section_with_lines_joined(tmp_path):
    out = _run(tmp_path, "v1.2.0")
    assert out.returncode == 0, out.stderr
    assert out.stdout == (
        "Clips and a help chat.\n"
        "\n"
        "### Upgrade notes\n"
        "\n"
        "- **One migration** runs at startup. Rolling back needs a "
        "[restored backup](https://github.com/o/r/blob/v1.2.0/docs/ops/backup.md#restore), "
        "see [the guide](https://example.com/guide) or [below](#added).\n"
        "\n"
        "### Added\n"
        "\n"
        "- Clips. Several per video.\n"
        "- Help chat.\n"
    )


def test_the_last_section_stops_at_the_link_definitions(tmp_path):
    out = _run(tmp_path, "v1.1.1")
    assert out.returncode == 0, out.stderr
    assert out.stdout == "- Older change.\n"


def test_a_stable_tag_without_a_section_fails(tmp_path):
    out = _run(tmp_path, "v1.3.0")
    assert out.returncode == 1
    assert "## [1.3.0]" in out.stderr
    assert out.stdout == ""


def test_a_prerelease_without_a_section_prints_nothing(tmp_path):
    out = _run(tmp_path, "v1.3.0-rc.1")
    assert out.returncode == 0, out.stderr
    assert out.stdout == ""

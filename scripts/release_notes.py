#!/usr/bin/env python3
"""Print a version's CHANGELOG.md section as the body of its GitHub Release.

The Release workflow runs this so the release page says what changed, not only
the list of merged pull requests GitHub generates. The section is reshaped for
the release page: wrapped lines are joined (release bodies render each newline
as a line break) and links to files in the repository point at the tag on
GitHub (a relative link on a release page goes nowhere).

A stable version must have a section (the release process adds it before
tagging); a pre-release without one prints nothing.

Usage: python scripts/release_notes.py vX.Y.Z owner/repo [CHANGELOG.md]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_SECTION = re.compile(r"^## \[")
_LINK_DEF = re.compile(r"^\[[^\]]+\]: ")
_BLOCK_START = re.compile(r"^(#{1,6} |- |\* |\d+\. |```|~~~|>|\|)")
_RELATIVE_LINK = re.compile(r"\]\((?!https?://|#|mailto:)/?([^)\s]+)\)")


def section(changelog: str, version: str) -> list[str] | None:
    """The lines under ``## [version]``, without the heading, or None."""
    heading = re.compile(rf"^## \[{re.escape(version)}\](\s|$)")
    lines = changelog.splitlines()
    for start, line in enumerate(lines):
        if heading.match(line):
            body: list[str] = []
            for line in lines[start + 1 :]:
                if _SECTION.match(line) or _LINK_DEF.match(line):
                    break
                body.append(line)
            return body
    return None


def unwrap(lines: list[str]) -> list[str]:
    """Join hard-wrapped paragraph and list-item lines into one line each."""
    out: list[str] = []
    in_fence = False
    for line in lines:
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            out.append(line)
            continue
        joins = (
            not in_fence
            and out
            and out[-1].strip()
            and not out[-1].lstrip().startswith(("#", "```", "~~~"))
            and line.strip()
            and not _BLOCK_START.match(line.lstrip())
        )
        if joins:
            out[-1] = f"{out[-1]} {line.strip()}"
        else:
            out.append(line)
    return out


def release_notes(changelog: str, version: str, repo: str) -> str | None:
    body = section(changelog, version)
    if body is None:
        return None
    text = "\n".join(unwrap(body)).strip()
    base = f"https://github.com/{repo}/blob/v{version}/"
    return _RELATIVE_LINK.sub(lambda m: f"]({base}{m.group(1)})", text)


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 4):
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    version = argv[1].removeprefix("v")
    repo = argv[2]
    path = Path(argv[3]) if len(argv) == 4 else ROOT / "CHANGELOG.md"
    notes = release_notes(path.read_text(encoding="utf-8"), version, repo)
    if notes is None:
        if "-" in version:
            return 0
        print(
            f"CHANGELOG.md has no '## [{version}]' section; add it before tagging "
            "(docs/development/release-process.md).",
            file=sys.stderr,
        )
        return 1
    print(notes)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

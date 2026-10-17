#!/usr/bin/env python3
"""Fail when backend/requirements.lock is stale relative to backend/requirements.txt.

The Docker image and CI install the hash-pinned lock file, not requirements.txt.
A change to requirements.txt alone (a Dependabot bump, a hand edit) would pass
every test against the old lock and ship the old version. This check needs no
network: every direct requirement must be in the lock at a version its specifier
allows. Regenerate the lock with the command in its header (see
docs/development/dependencies.md).

Usage: python scripts/check_requirements_lock.py [requirements.txt requirements.lock]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REQUIREMENTS = ROOT / "backend" / "requirements.txt"
DEFAULT_LOCK = ROOT / "backend" / "requirements.lock"

_PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)")


def direct_requirements(path: Path) -> list[Requirement]:
    out: list[Requirement] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split(" #", 1)[0].strip()
        if not line or line.startswith(("#", "-")):
            continue
        out.append(Requirement(line))
    return out


def locked_versions(path: Path) -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = _PIN.match(line)
        if match:
            pins[canonicalize_name(match.group(1))] = match.group(2)
    return pins


def problems(requirements: Path, lock: Path) -> list[str]:
    try:
        wanted = direct_requirements(requirements)
    except InvalidRequirement as exc:
        return [f"{requirements.name}: {exc}"]
    pins = locked_versions(lock)
    found: list[str] = []
    for req in wanted:
        if req.marker is not None and not req.marker.evaluate():
            continue
        pinned = pins.get(canonicalize_name(req.name))
        if pinned is None:
            found.append(f"{req.name} is in {requirements.name} but not in {lock.name}")
            continue
        try:
            ok = req.specifier.contains(Version(pinned), prereleases=True)
        except InvalidVersion:
            ok = False
        if not ok:
            found.append(
                f"{req.name}: {requirements.name} wants '{req.specifier}', "
                f"{lock.name} pins {pinned}"
            )
    return found


def main(argv: list[str]) -> int:
    requirements, lock = (
        (Path(argv[0]), Path(argv[1]))
        if len(argv) == 2
        else (DEFAULT_REQUIREMENTS, DEFAULT_LOCK)
    )
    found = problems(requirements, lock)
    if not found:
        print(f"{lock.name} matches {requirements.name}")
        return 0
    for line in found:
        print(f"stale lock: {line}", file=sys.stderr)
    print(
        "Regenerate it: uv pip compile --generate-hashes --python-version 3.12 "
        "backend/requirements.txt -o backend/requirements.lock "
        "(see docs/development/dependencies.md)",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

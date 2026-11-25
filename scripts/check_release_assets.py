#!/usr/bin/env python3
"""Refuse to publish a release whose desktop assets are incomplete.

    python scripts/check_release_assets.py <folder> [--targets windows,mac,linux]

The Release workflow uploads every desktop file to a draft release and runs this
on the folder before publishing. The updater and the download links in the docs
rely on these exact names, so one missing file means a broken update or a dead
link for everyone on that system.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

#: Per system: the files a release must carry. Names are fixed (no version) so
#: ``releases/latest/download/<name>`` links never change.
ASSETS: dict[str, tuple[str, ...]] = {
    "windows": (
        "Horde-windows-x64-setup.exe",
        "Horde-windows-x64-setup.exe.blockmap",
        "latest.yml",
    ),
    "mac": (
        "Horde-mac-arm64.dmg",
        "Horde-mac-arm64.zip",
        "Horde-mac-arm64.zip.blockmap",
        "latest-mac.yml",
    ),
    "linux": (
        "Horde-linux-x64.AppImage",
        "latest-linux.yml",
    ),
}
#: The files people download; each must be listed in SHA256SUMS with its hash.
INSTALLERS = (".exe", ".dmg", ".zip", ".AppImage")
SUMS = "SHA256SUMS"


def expected(targets: list[str]) -> list[str]:
    return [name for target in targets for name in ASSETS[target]]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def problems(folder: Path, targets: list[str]) -> list[str]:
    found = [f"missing {name}" for name in expected(targets) if not (folder / name).is_file()]
    found += [f"empty {name}" for name in expected(targets)
              if (folder / name).is_file() and (folder / name).stat().st_size == 0]  # fmt: skip
    sums_file = folder / SUMS
    if not sums_file.is_file():
        return [*found, f"missing {SUMS}"]
    listed: dict[str, str] = {}
    for line in sums_file.read_text(encoding="utf-8").splitlines():
        digest, _, name = line.strip().partition("  ")
        if name:
            listed[name.lstrip("*")] = digest
    for name in expected(targets):
        path = folder / name
        if not name.endswith(INSTALLERS) or not path.is_file():
            continue
        if name not in listed:
            found.append(f"{SUMS} does not list {name}")
        elif listed[name] != sha256(path):
            found.append(f"{SUMS} has the wrong hash for {name}")
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("folder", type=Path)
    parser.add_argument("--targets", default="windows,mac,linux")
    args = parser.parse_args()
    targets = [t for t in args.targets.split(",") if t]
    unknown = [t for t in targets if t not in ASSETS]
    if unknown or not targets:
        print(f"unknown targets: {unknown or '(none given)'}", file=sys.stderr)
        return 2
    found = problems(args.folder, targets)
    for line in found:
        print(f"release assets: {line}", file=sys.stderr)
    if not found:
        print(f"release assets complete: {len(expected(targets))} files and {SUMS}")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())

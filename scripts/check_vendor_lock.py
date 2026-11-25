#!/usr/bin/env python3
"""Check desktop/vendor.lock.json: complete, well formed, and in step with the image.

The desktop app and the Docker image must ship the same deno, so the version
pinned here has to equal the one in the Dockerfile's ``denoland/deno:bin-<version>``.
Bump both together.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TARGETS = ("win32-x64", "darwin-arm64", "linux-x64")
PARTS = ("python", "ffmpeg", "deno")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_DENO_IMAGE = re.compile(r"^FROM\s+denoland/deno:bin-([0-9.]+)", re.MULTILINE)
_FFMPEG_PACKAGE = re.compile(r"jellyfin-ffmpeg(\d+)")


def problems(lock_path: Path, dockerfile: Path) -> list[str]:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    found: list[str] = []
    for part in PARTS:
        entry = lock.get(part)
        if not isinstance(entry, dict) or not entry.get("version"):
            found.append(f"{part}: missing or without a version")
            continue
        for target in TARGETS:
            pin = entry.get("targets", {}).get(target)
            if not isinstance(pin, dict):
                found.append(f"{part}: no entry for {target}")
                continue
            url, sha = str(pin.get("url", "")), str(pin.get("sha256", ""))
            if not url.startswith("https://github.com/"):
                found.append(f"{part} {target}: the URL must be https://github.com/...")
            if not _SHA256.fullmatch(sha):
                found.append(f"{part} {target}: sha256 must be 64 lowercase hex characters")

    docker = dockerfile.read_text(encoding="utf-8")
    image_deno = _DENO_IMAGE.search(docker)
    lock_deno = lock.get("deno", {}).get("version")
    if image_deno is None:
        found.append("Dockerfile: no denoland/deno:bin-<version> line found")
    elif image_deno.group(1) != lock_deno:
        found.append(
            f"deno is {lock_deno} in desktop/vendor.lock.json but "
            f"{image_deno.group(1)} in the Dockerfile; bump both together"
        )
    image_ffmpeg = _FFMPEG_PACKAGE.search(docker)
    lock_ffmpeg = str(lock.get("ffmpeg", {}).get("version", ""))
    if image_ffmpeg and lock_ffmpeg.split(".")[0] != image_ffmpeg.group(1):
        found.append(
            f"ffmpeg is {lock_ffmpeg} in desktop/vendor.lock.json but the image "
            f"installs jellyfin-ffmpeg{image_ffmpeg.group(1)}; keep the same major"
        )
    return found


def main(argv: list[str]) -> int:
    lock_path = Path(argv[1]) if len(argv) > 1 else REPO / "desktop" / "vendor.lock.json"
    dockerfile = Path(argv[2]) if len(argv) > 2 else REPO / "Dockerfile"
    found = problems(lock_path, dockerfile)
    for line in found:
        print(f"vendor lock: {line}", file=sys.stderr)
    if not found:
        print("desktop/vendor.lock.json is complete and matches the Dockerfile")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

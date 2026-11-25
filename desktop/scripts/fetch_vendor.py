#!/usr/bin/env python3
"""Download the pinned third-party programs for one desktop target.

    python desktop/scripts/fetch_vendor.py --target linux-x64

Reads ``desktop/vendor.lock.json`` and, for Python, ffmpeg, deno and the
YouTube helper's source, downloads the archive for the target, refuses it unless
its SHA-256 matches the lock, and extracts it under ``--out`` (``python/``,
``ffmpeg/``, ``deno/``, ``pot/``). Downloads are
kept in ``--cache`` by hash, so a second run fetches nothing.

Standard library only: this runs on a bare CI runner before anything is
installed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

DESKTOP = Path(__file__).resolve().parent.parent
LOCK = DESKTOP / "vendor.lock.json"
TARGETS = ("win32-x64", "darwin-arm64", "linux-x64")
PARTS = ("python", "ffmpeg", "deno", "pot")
_CHUNK = 1 << 20


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _archive_suffix(url: str) -> str:
    for suffix in (".tar.gz", ".tar.xz", ".zip"):
        if url.endswith(suffix):
            return suffix
    raise SystemExit(f"unsupported archive type: {url}")


def download(url: str, sha256: str, cache: Path) -> Path:
    """The verified archive in the cache, fetched if it is not there yet."""
    if not url.startswith("https://"):
        raise SystemExit(f"refusing a non-https URL: {url}")
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"{sha256}{_archive_suffix(url)}"
    if target.is_file() and _sha256(target) == sha256:
        return target
    partial = target.with_name(target.name + ".part")
    print(f"downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=120) as resp, partial.open("wb") as fh:  # noqa: S310 - https only, checked above
        shutil.copyfileobj(resp, fh, _CHUNK)
    got = _sha256(partial)
    if got != sha256:
        partial.unlink()
        raise SystemExit(f"hash mismatch for {url}\n  expected {sha256}\n  got      {got}")
    partial.replace(target)
    return target


def extract(archive: Path, dest: Path) -> None:
    """Unpack into an empty ``dest``; archive members cannot escape it."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(dest)  # zipfile strips absolute paths and ".."
    else:
        with tarfile.open(archive) as tf:
            tf.extractall(dest, filter="data")
    # One top-level folder (python-build-standalone ships "python/"): lift it.
    entries = list(dest.iterdir())
    if len(entries) == 1 and entries[0].is_dir():
        inner = entries[0]
        staging = dest.with_name(dest.name + ".lift")
        inner.rename(staging)
        dest.rmdir()
        staging.rename(dest)
    # Zip archives carry no permissions; everything here is a program.
    if archive.name.endswith(".zip"):
        for path in dest.iterdir():
            if path.is_file():
                path.chmod(0o755)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", required=True, choices=TARGETS)
    parser.add_argument("--out", type=Path, default=DESKTOP / "build" / "vendor")
    parser.add_argument("--cache", type=Path, default=DESKTOP / "build" / "cache")
    args = parser.parse_args()

    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    for part in PARTS:
        entry = lock[part]["targets"][args.target]
        archive = download(entry["url"], entry["sha256"], args.cache)
        extract(archive, args.out / part)
        print(f"{part} {lock[part]['version']} -> {args.out / part}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

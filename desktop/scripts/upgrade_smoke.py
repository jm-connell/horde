#!/usr/bin/env python3
"""Upgrade smoke test: the previous release's data must start under this build.

    python desktop/scripts/upgrade_smoke.py --target linux-x64

Downloads the newest published desktop release for the target, unpacks it,
starts ITS server on an empty data folder and creates an administrator, stops
it, then starts THIS build's server (``desktop/build/resources``) on the same
folder and signs in. That is what an update does to someone's install, and the
desktop app has no automatic way back, so a build that cannot start on the
previous version's data must not be published.

Skips (exit 0, with a notice) when there is no earlier desktop release for the
target yet. Standard library only; unpacking Windows installers needs ``7z``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

DESKTOP = Path(__file__).resolve().parent.parent
#: The file to download per target, as the Release workflow publishes it.
ASSETS = {
    "win32-x64": "Horde-windows-x64-setup.exe",
    "darwin-arm64": "Horde-mac-arm64.zip",
    "linux-x64": "Horde-linux-x64.AppImage",
}
ADMIN = {"username": "upgrade-smoke", "password": "correct horse battery staple 42"}
START_TIMEOUT_SEC = 180


def python_exe(resources: Path, target: str) -> Path:
    if target.startswith("win32"):
        return resources / "python" / "python.exe"
    return resources / "python" / "bin" / "python3"


def _api(url: str) -> object:
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)  # noqa: S310 - fixed https host
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
        return json.load(resp)


def previous_release(repo: str, asset: str, current: str) -> tuple[str, str] | None:
    """(tag, download URL) of the newest published release carrying ``asset``."""
    releases = _api(f"https://api.github.com/repos/{repo}/releases?per_page=30")
    assert isinstance(releases, list)
    for release in releases:
        tag = str(release.get("tag_name", ""))
        if release.get("draft") or tag.lstrip("v") == current:
            continue
        for item in release.get("assets", []):
            if item.get("name") == asset:
                return tag, str(item["browser_download_url"])
    return None


def download(url: str, dest: Path) -> None:
    if not url.startswith("https://github.com/"):
        raise SystemExit(f"refusing to download from {url}")
    print(f"downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=120) as resp, dest.open("wb") as fh:  # noqa: S310 - https github.com, checked above
        shutil.copyfileobj(resp, fh, 1 << 20)


def unpack(installer: Path, into: Path, target: str) -> Path:
    """Unpack a published installer; returns its ``resources`` folder."""
    if target == "linux-x64":
        installer.chmod(0o755)
        subprocess.run([str(installer), "--appimage-extract"], cwd=into, check=True,
                       stdout=subprocess.DEVNULL)  # fmt: skip
        return into / "squashfs-root" / "resources"
    if target == "darwin-arm64":
        # ditto keeps the bundle's symlinks and permissions; zipfile would not.
        subprocess.run(["ditto", "-x", "-k", str(installer), str(into)], check=True)
        return into / "Horde.app" / "Contents" / "Resources"
    # NSIS: the installer is a 7z archive holding the app as another one.
    outer = into / "outer"
    subprocess.run(["7z", "x", "-y", f"-o{outer}", str(installer)], check=True,
                   stdout=subprocess.DEVNULL)  # fmt: skip
    inner = next(outer.rglob("app-64.7z"), None)
    if inner is None:
        raise SystemExit(f"no app-64.7z inside {installer.name}")
    app = into / "app"
    subprocess.run(["7z", "x", "-y", f"-o{app}", str(inner)], check=True,
                   stdout=subprocess.DEVNULL)  # fmt: skip
    return app / "resources"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _request(url: str, body: dict[str, object] | None = None) -> tuple[int, str]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "X-Horde-Request": "1"}
    req = urllib.request.Request(url, data=data, headers=headers)  # noqa: S310 - loopback
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
            return int(resp.status), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except OSError as exc:
        return 0, repr(exc)


class Server:
    """One version's bundled server on a data folder, started as the shell does."""

    def __init__(self, resources: Path, target: str, data: Path, label: str) -> None:
        self.label = label
        self.port = _free_port()
        self.log = data.parent / f"{label}.log"
        suffix = ".exe" if target.startswith("win32") else ""
        env = {
            **os.environ,
            "HOST": "127.0.0.1",
            "PORT": str(self.port),
            "HORDE_RUNTIME": "desktop",
            "DATA_DIR": str(data),
            "DOWNLOADS_DIR": str(data.parent / "media"),
            "FFMPEG_BIN": str(resources / "bin" / f"ffmpeg{suffix}"),
            "BUILD_INFO_FILE": str(resources / "backend" / "BUILD_INFO"),
            "PYTHONUTF8": "1",
            "PYTHONNOUSERSITE": "1",
        }
        for name in ("PYTHONPATH", "PYTHONHOME", "HORDE_E2E", "HORDE_E2E_MODE"):
            env.pop(name, None)
        self._fh = self.log.open("wb")
        self.proc = subprocess.Popen(
            [str(python_exe(resources, target)), "-m", "app.desktop_entry"],
            cwd=resources / "backend",
            env=env,
            stdin=subprocess.PIPE,
            stdout=self._fh,
            stderr=subprocess.STDOUT,
        )

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def fail(self, why: str) -> SystemExit:
        self.stop()
        print(self.log.read_text(encoding="utf-8", errors="replace")[-6000:])
        return SystemExit(f"upgrade smoke test failed ({self.label}): {why}")

    def wait_ready(self) -> None:
        deadline = time.monotonic() + START_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise self.fail(f"the server exited with {self.proc.returncode}")
            if _request(self.url("/api/ping"))[0] == 200:
                return
            time.sleep(0.5)
        raise self.fail("the server never answered")

    def stop(self) -> int | None:
        if self.proc.poll() is None:
            assert self.proc.stdin is not None
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
                self._fh.close()
                return None
        self._fh.close()
        return self.proc.returncode


def run(previous: Path, current: Path, target: str) -> None:
    with tempfile.TemporaryDirectory(prefix="horde upgrade ") as tmp:
        data = Path(tmp) / "data"

        old = Server(previous, target, data, "previous")
        old.wait_ready()
        status, body = _request(old.url("/api/auth/bootstrap"), dict(ADMIN))
        if status != 200:
            raise old.fail(f"creating the administrator answered {status}: {body[:300]}")
        if old.stop() != 0:
            raise old.fail("the previous version did not stop cleanly")

        new = Server(current, target, data, "current")
        new.wait_ready()
        status, body = _request(new.url("/api/health"))
        if status != 200 or json.loads(body).get("status") != "ok":
            raise new.fail(f"/api/health answered {status}: {body[:300]}")
        status, body = _request(new.url("/api/auth/login"), dict(ADMIN))
        if status != 200:
            raise new.fail(
                f"the administrator made by the previous version cannot sign in "
                f"({status}): {body[:300]}"
            )
        if new.stop() != 0:
            raise new.fail("this build did not stop cleanly")
    print("upgrade smoke test passed", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", required=True, choices=sorted(ASSETS))
    parser.add_argument("--repo", default="jm-connell/horde")
    parser.add_argument("--current-version", default="")
    parser.add_argument("--resources", type=Path, default=DESKTOP / "build" / "resources")
    parser.add_argument(
        "--previous-resources",
        type=Path,
        help="an unpacked earlier build's resources folder (skips the download)",
    )
    args = parser.parse_args()
    current = args.resources.resolve()

    if args.previous_resources:
        run(args.previous_resources.resolve(), current, args.target)
        return 0

    asset = ASSETS[args.target]
    found = previous_release(args.repo, asset, args.current_version.lstrip("v"))
    if found is None:
        # GitHub shows this line on the run's summary page.
        print(f"::notice::upgrade smoke test skipped: no earlier release has {asset}")
        return 0
    tag, url = found
    print(f"upgrading from {tag}", flush=True)
    with tempfile.TemporaryDirectory(prefix="horde-previous-") as tmp:
        installer = Path(tmp) / asset
        download(url, installer)
        if args.target == "darwin-arm64" and not zipfile.is_zipfile(installer):
            raise SystemExit(f"{asset} from {tag} is not a zip file")
        previous = unpack(installer, Path(tmp), args.target)
        if not python_exe(previous, args.target).is_file():
            raise SystemExit(f"{tag}'s {asset} has no bundled Python where expected")
        run(previous, current, args.target)
    return 0


if __name__ == "__main__":
    sys.exit(main())

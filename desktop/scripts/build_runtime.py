#!/usr/bin/env python3
"""Assemble what the desktop app carries beside Electron, then prove it runs.

    python desktop/scripts/build_runtime.py --target linux-x64 --version 1.4.2 --sha <commit>

Run ``fetch_vendor.py`` first. The result, ``desktop/build/resources``, mirrors
the image's ``/app`` so the server finds everything by its ordinary paths:

    python/                 the pinned CPython with requirements.lock installed
    backend/app             the server (as ``COPY backend/app ./app``)
    backend/static          the built web UI, and the wiki in static/wiki
    backend/source          what "Ask about Horde" answers from
    backend/BUILD_INFO      version, commit, ffmpeg
    bin/                    ffmpeg, ffprobe, deno
    pot/server              the YouTube helper with its dependencies installed
    licenses/               licence texts of the bundled programs

The last step starts the bundled server with the bundled Python and checks that
it answers, serves the web UI and the wiki, and stops when its standard input
closes, and does the same for the YouTube helper. A runtime that fails this
never reaches the installer.

Needs ``uv`` on PATH, a built ``frontend/dist`` and a built wiki.
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
from pathlib import Path

DESKTOP = Path(__file__).resolve().parent.parent
REPO = DESKTOP.parent
TARGETS = ("win32-x64", "darwin-arm64", "linux-x64")
#: As the Dockerfile's ``COPY ... ./source/``.
SOURCE_FILES = (
    "README.md",
    "PRODUCT.md",
    "DESIGN.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    ".env.example",
    "docker-compose.yml",
)
#: Standard-library parts the server never imports.
UNUSED_STDLIB = ("test", "idlelib", "turtledemo", "ensurepip", "tkinter")
#: The helper's build and lint tools. ``deno install`` fetches them with the
#: rest (about 120 MB), and the helper never loads them at run time.
POT_DEV_PACKAGES = (
    "typescript",
    "prettier",
    "eslint",
    "@swc",
    "swc-node",
    "@typescript-eslint",
    "typescript-eslint",
    "@eslint",
    "@types",
    "@oxc-resolver",
    "@node-rs",
    "eslint-plugin-prettier",
    "eslint-plugin-only-warn",
    "eslint-config-prettier",
    "@commander-js",
    ".bin",
)
#: How the shell starts the helper, from ``pot/server/node_modules``.
POT_RUN_ARGS = (
    "run",
    "--cached-only",
    "--allow-env",
    "--allow-net",
    "--allow-ffi=.",
    "--allow-read=.",
    "../horde_lifeline.ts",
)
_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc")


def exe(name: str, target: str) -> str:
    return f"{name}.exe" if target.startswith("win32") else name


def python_exe(root: Path, target: str) -> Path:
    if target.startswith("win32"):
        return root / "python.exe"
    return root / "bin" / "python3"


def run(cmd: list[str | Path]) -> None:
    print("+", " ".join(str(part) for part in cmd), flush=True)
    subprocess.run([str(part) for part in cmd], check=True)


def stdlib_dir(root: Path, target: str) -> Path:
    if target.startswith("win32"):
        return root / "Lib"
    return next((root / "lib").glob("python3.*"))


def assemble_python(vendor: Path, out: Path, target: str) -> Path:
    root = out / "python"
    shutil.copytree(vendor / "python", root, symlinks=True)
    python = python_exe(root, target)
    # Wheels only, hash-checked, from the same lock the image installs.
    run(
        [
            "uv", "pip", "install",
            "--python", python,
            "--break-system-packages",
            "--require-hashes",
            "--only-binary", ":all:",
            "--no-cache",
            "-r", REPO / "backend" / "requirements.lock",
        ]
    )  # fmt: skip
    stdlib = stdlib_dir(root, target)
    for name in UNUSED_STDLIB:
        shutil.rmtree(stdlib / name, ignore_errors=True)
    site = stdlib / "site-packages"
    for leftover in [site / "pip", *site.glob("pip-*.dist-info")]:
        shutil.rmtree(leftover, ignore_errors=True)
    for cache in list(root.rglob("__pycache__")):
        shutil.rmtree(cache, ignore_errors=True)
    # Headers, man pages and Tcl/Tk: nothing the server runs.
    extras = [root / "include", root / "share", root / "tcl", root / "libs"]
    if not target.startswith("win32"):
        # Tcl/Tk libraries beside the standard library. Not on Windows: there
        # "lib" IS the standard library (Lib, case-insensitive), and a pattern
        # like thread* would delete threading.py.
        for pattern in ("tcl*", "tk*", "itcl*", "thread*", "libtcl*"):
            extras.extend((root / "lib").glob(pattern))
    for extra in extras:
        if extra.is_dir():
            shutil.rmtree(extra, ignore_errors=True)
        elif extra.exists():
            extra.unlink()
    return python


def assemble_backend(out: Path, web: Path, wiki: Path) -> Path:
    backend = out / "backend"
    shutil.copytree(REPO / "backend" / "app", backend / "app", ignore=_IGNORE)
    if not (web / "index.html").is_file():
        raise SystemExit(f"no built web UI in {web} (run `npm run build` in frontend/)")
    shutil.copytree(web, backend / "static")
    if not (wiki / "index.html").is_file():
        raise SystemExit(f"no built wiki in {wiki} (run `mkdocs build -d {wiki}`)")
    shutil.copytree(wiki, backend / "static" / "wiki", dirs_exist_ok=True)
    source = backend / "source"
    shutil.copytree(REPO / "docs", source / "docs", ignore=_IGNORE)
    for name in SOURCE_FILES:
        shutil.copy2(REPO / name, source / name)
    shutil.copytree(REPO / "frontend" / "src", source / "frontend" / "src")
    return backend


def assemble_bin(vendor: Path, out: Path, target: str) -> Path:
    bin_dir = out / "bin"
    bin_dir.mkdir(parents=True)
    for part, name in (("ffmpeg", "ffmpeg"), ("ffmpeg", "ffprobe"), ("deno", "deno")):
        src = vendor / part / exe(name, target)
        if not src.is_file():
            raise SystemExit(f"{src} is missing (run fetch_vendor.py for {target})")
        dst = bin_dir / src.name
        shutil.copy2(src, dst)
        dst.chmod(0o755)
    return bin_dir


def assemble_pot(vendor: Path, out: Path, bin_dir: Path, target: str) -> Path:
    """The YouTube helper (bgutil-ytdlp-pot-provider's server), ready to run offline.

    Its npm dependencies are installed with the bundled deno into a flat
    ``node_modules`` (the hoisted linker: no symlinks, which installers do not
    carry reliably). ``--frozen`` keeps to the helper's own lock file.
    """
    server = out / "pot" / "server"
    shutil.copytree(vendor / "pot" / "server", server)
    # Ours, beside theirs: starts the helper and ends it with the desktop app.
    shutil.copy2(DESKTOP / "pot" / "horde_lifeline.ts", server / "horde_lifeline.ts")
    deno = bin_dir / exe("deno", target)
    with tempfile.TemporaryDirectory(prefix="horde-deno-") as cache:
        print("+ deno install (YouTube helper)", flush=True)
        subprocess.run(
            [str(deno), "install", "--node-modules-linker=hoisted",
             "--allow-scripts=npm:canvas", "--frozen"],
            cwd=server,
            env={**os.environ, "DENO_DIR": cache, "DENO_NO_UPDATE_CHECK": "1"},
            check=True,
        )  # fmt: skip
    modules = server / "node_modules"
    for name in POT_DEV_PACKAGES:
        shutil.rmtree(modules / name, ignore_errors=True)
    return server


def assemble_licenses(out: Path, lock: dict[str, dict[str, str]]) -> None:
    licenses = out / "licenses"
    shutil.copytree(DESKTOP / "licenses", licenses)
    shutil.copy2(REPO / "LICENSE", licenses / "Horde-LICENSE.txt")
    lines = [
        "Horde's desktop app includes these programs, unmodified, as separate",
        "executables. Each keeps its own licence.",
        "",
        f"ffmpeg, ffprobe {lock['ffmpeg']['version']} (jellyfin-ffmpeg)",
        "  Licence: GNU General Public License v3 (GPL-3.0.txt)",
        f"  Source:  {lock['ffmpeg']['source']}",
        "",
        f"deno {lock['deno']['version']}",
        "  Licence: MIT (deno-MIT.txt)",
        f"  Source:  {lock['deno']['source']}",
        "",
        f"bgutil-ytdlp-pot-provider {lock['pot']['version']} (the YouTube helper, in pot/server)",
        "  Licence: GNU General Public License v3 (GPL-3.0.txt)",
        f"  Source:  {lock['pot']['source']}",
        "  Its npm packages keep their licence files in pot/server/node_modules.",
        "  horde_lifeline.ts in that folder is Horde's own launcher, not part of it.",
        "",
        f"CPython {lock['python']['version']} (python-build-standalone {lock['python']['release']})",
        "  Licence: Python Software Foundation License; see the LICENSE file in python/",
        f"  Source:  {lock['python']['source']}",
        "",
        "Python packages keep their licence files in their own folders under",
        "python/ (site-packages/<name>.dist-info).",
        "",
    ]
    (licenses / "THIRD-PARTY.txt").write_text("\n".join(lines), encoding="utf-8")


def first_line(cmd: list[str | Path]) -> str:
    done = subprocess.run(
        [str(part) for part in cmd], check=True, capture_output=True, text=True
    )
    return (done.stdout or done.stderr).splitlines()[0].strip()


def write_build_info(backend: Path, bin_dir: Path, target: str, version: str, sha: str) -> None:
    ffmpeg = first_line([bin_dir / exe("ffmpeg", target), "-version"])
    (backend / "BUILD_INFO").write_text(
        f"version={version}\ngit_sha={sha}\nruntime=desktop\ntarget={target}\n"
        f"ffmpeg_flavor=jellyfin\nffmpeg={ffmpeg}\n",
        encoding="utf-8",
    )


def compile_bytecode(python: Path, folders: list[Path]) -> None:
    # unchecked-hash: the compiled files stay valid whatever an installer does
    # to timestamps, and a read-only install (AppImage) never recompiles.
    done = subprocess.run(
        [str(python), "-m", "compileall", "-q", "-f",
         "--invalidation-mode", "unchecked-hash", *map(str, folders)],
        check=False,
    )  # fmt: skip
    if done.returncode != 0:
        print("compileall reported errors (files with syntax for other versions)")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _get(url: str) -> int:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:  # noqa: S310 - loopback
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return exc.code
    except OSError:
        return 0


def smoke_test(out: Path, target: str, lock: dict[str, dict[str, str]]) -> None:
    """Start the assembled server the way the shell does and check it."""
    bin_dir = out / "bin"
    for name, part in (("ffmpeg", "ffmpeg"), ("ffprobe", "ffmpeg")):
        line = first_line([bin_dir / exe(name, target), "-version"])
        upstream = lock[part]["version"].split("-")[0]
        if upstream not in line:
            raise SystemExit(f"{name} reports {line!r}, expected {upstream}")
    deno = first_line([bin_dir / exe("deno", target), "--version"])
    if lock["deno"]["version"] not in deno:
        raise SystemExit(f"deno reports {deno!r}, expected {lock['deno']['version']}")

    python = python_exe(out / "python", target)
    backend = out / "backend"
    port = _free_port()
    with tempfile.TemporaryDirectory(prefix="horde smoke ") as tmp:
        env = {
            **os.environ,
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "HORDE_RUNTIME": "desktop",
            "HORDE_E2E": "1",  # no network workers
            "HORDE_E2E_MODE": "setup",
            "DATA_DIR": str(Path(tmp) / "data"),
            "DOWNLOADS_DIR": str(Path(tmp) / "media"),
            "FFMPEG_BIN": str(bin_dir / exe("ffmpeg", target)),
            "BUILD_INFO_FILE": str(backend / "BUILD_INFO"),
            "PYTHONUTF8": "1",
        }
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        log = Path(tmp) / "server.log"
        with log.open("wb") as fh:
            proc = subprocess.Popen(
                [str(python), "-m", "app.desktop_entry"],
                cwd=backend,
                env=env,
                stdin=subprocess.PIPE,
                stdout=fh,
                stderr=subprocess.STDOUT,
            )
            try:
                base = f"http://127.0.0.1:{port}"
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline and proc.poll() is None:
                    if _get(f"{base}/api/ping") == 200:
                        break
                    time.sleep(0.5)
                checks = {path: _get(base + path) for path in ("/api/ping", "/api/health", "/", "/wiki/")}
                assert proc.stdin is not None
                proc.stdin.close()
                code = proc.wait(timeout=30)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=10)
        bad = {path: status for path, status in checks.items() if status != 200}
        if bad or code != 0:
            print(log.read_text(encoding="utf-8", errors="replace"))
            raise SystemExit(f"runtime smoke test failed: {bad or ''} exit code {code}")
    print("runtime smoke test passed:", checks, flush=True)


def smoke_test_pot(out: Path, target: str, lock: dict[str, dict[str, str]]) -> None:
    """Start the helper the way the shell does; it must answer and then stop."""
    deno = out / "bin" / exe("deno", target)
    port = _free_port()
    with tempfile.TemporaryDirectory(prefix="horde pot ") as tmp:
        log = Path(tmp) / "helper.log"
        with log.open("wb") as fh:
            proc = subprocess.Popen(
                [str(deno), *POT_RUN_ARGS, "--port", str(port)],
                cwd=out / "pot" / "server" / "node_modules",
                env={**os.environ, "DENO_DIR": str(Path(tmp) / "deno"),
                     "DENO_NO_UPDATE_CHECK": "1", "NO_COLOR": "1"},
                stdin=subprocess.PIPE,
                stdout=fh,
                stderr=subprocess.STDOUT,
            )  # fmt: skip
            body = ""
            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline and proc.poll() is None:
                    try:
                        with urllib.request.urlopen(  # noqa: S310 - loopback
                            f"http://127.0.0.1:{port}/ping", timeout=5
                        ) as resp:
                            body = resp.read().decode("utf-8", "replace")
                            break
                    except OSError:
                        time.sleep(0.5)
                assert proc.stdin is not None
                proc.stdin.close()
                code: int | None = proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                code = None
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=10)
        if lock["pot"]["version"] not in body or code != 0:
            print(log.read_text(encoding="utf-8", errors="replace"))
            raise SystemExit(
                f"YouTube helper smoke test failed: /ping said {body!r}, exit code {code}"
            )
    print("YouTube helper smoke test passed:", body.strip(), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", required=True, choices=TARGETS)
    parser.add_argument("--version", default="0.0.0-dev")
    parser.add_argument("--sha", default="unknown")
    parser.add_argument("--vendor", type=Path, default=DESKTOP / "build" / "vendor")
    parser.add_argument("--out", type=Path, default=DESKTOP / "build" / "resources")
    parser.add_argument("--web", type=Path, default=REPO / "frontend" / "dist")
    parser.add_argument("--wiki", type=Path, default=REPO / "backend" / "static" / "wiki")
    args = parser.parse_args()

    lock = json.loads((DESKTOP / "vendor.lock.json").read_text(encoding="utf-8"))
    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)

    python = assemble_python(args.vendor, args.out, args.target)
    backend = assemble_backend(args.out, args.web, args.wiki)
    bin_dir = assemble_bin(args.vendor, args.out, args.target)
    assemble_pot(args.vendor, args.out, bin_dir, args.target)
    assemble_licenses(args.out, lock)
    write_build_info(backend, bin_dir, args.target, args.version, args.sha)
    compile_bytecode(python, [args.out / "python", backend / "app"])
    smoke_test(args.out, args.target, lock)
    smoke_test_pot(args.out, args.target, lock)
    return 0


if __name__ == "__main__":
    sys.exit(main())

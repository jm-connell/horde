# Dependencies and reproducible builds

Horde pins everything that ends up in the Docker image so a rebuild next month
produces the same software as a rebuild today.

| What | Where | Pinned by |
|------|-------|-----------|
| Python runtime deps | `backend/requirements.txt` (direct) and `backend/requirements.lock` (full tree, hashes) | `uv pip compile --universal --generate-hashes` |
| Frontend deps | `frontend/package.json` and `frontend/package-lock.json` | `npm ci` |
| Desktop shell deps | `desktop/package.json` and `desktop/package-lock.json` | `npm ci` |
| Desktop bundled programs (Python, ffmpeg, deno, the YouTube helper) | `desktop/vendor.lock.json` | version, URL and SHA-256 for each of three targets |
| Docs toolchain | `docs/requirements.txt` | exact `mkdocs-material` version |
| pip in the image | `docker/pip.lock` | exact version plus hash |
| Base images | `Dockerfile` `FROM` lines | exact version tag plus `@sha256` digest |
| Node / Python in CI | `.nvmrc` (26) and `.github/workflows` | same major as the Dockerfile |

The Docker image installs the lock file with `pip install --require-hashes`, so a
tampered or unexpectedly changed package fails the build instead of shipping.

## Regenerating the Python lock file

Edit `backend/requirements.txt` (the direct dependencies), then:

```bash
uv pip compile --universal --generate-hashes --python-version 3.14 \
    backend/requirements.txt -o backend/requirements.lock
```

Commit both files together. To upgrade everything the constraints allow, add
`--upgrade`; to upgrade one package, add `--upgrade-package fastapi`.

`scripts/check_requirements_lock.py` (a gate in `scripts/check.sh` and CI) fails
when the two drift apart: every direct requirement must be in the lock at a
version its specifier allows. It needs no network. Dependabot cannot regenerate
the lock, so `.github/workflows/dependabot-lock.yml` runs the command above on
each Dependabot branch that bumps `requirements.txt`, pushes the new lock and
starts the checks again. Dependabot then stops rebasing that pull request; if it
conflicts, comment `@dependabot recreate` on it. The check cannot notice a dependency removed from
`requirements.txt` whose pins linger in the lock; regenerate after removals too.

`uv` is the only extra tool needed (`pipx install uv` or `pip install uv`). The
Python version must match the Docker image (3.14) so markers resolve the same way.

Then check for known advisories:

```bash
uvx pip-audit -r backend/requirements.lock --no-deps --disable-pip
```

CI runs the same audit weekly and on every pull request (`security.yml`).

## Bumping a base image

Base images are pinned like `python:3.14.8-slim-bookworm@sha256:…`. The tag keeps
the line readable, the digest makes it immutable. Dependabot opens weekly pull
requests for both, except a new Python minor (3.14 to 3.15), which it is told to
ignore: that move changes the lock, CI, ruff and mypy targets together and is
done by hand. To bump by hand, find the new digest with
`docker buildx imagetools inspect python:3.14.9-slim-bookworm` and update the tag
and digest together.

## Bumping pip

The image's pip is pinned in `docker/pip.lock` rather than taken from the base
image, because pip vendors its own CA bundle (certifi) and uses it at runtime for
`YTDLP_AUTO_UPDATE`. Dependabot does not watch this file. When the Trivy image
scan flags a package under pip's vendored copies, bump the version and hash from
the pip release's PyPI page, and check the release's `src/pip/_vendor/vendor.txt`
to confirm it vendors the fixed version.

## Bumping yt-dlp

yt-dlp is the one dependency that has to move quickly when YouTube changes. See
[Maintenance](../ops/maintenance.md) for the manual bump, and the opt-in runtime
updater (`YTDLP_AUTO_UPDATE=1`) in [Environment variables](../ops/environment.md).
Dependabot checks yt-dlp daily.

`yt-dlp-ejs` holds the challenge-solver scripts yt-dlp runs in Deno (live 1440p
and 2160p, made-for-kids videos). A yt-dlp release accepts only the scripts its `default` extra
pins (`Requires-Dist: yt-dlp-ejs==…` on its PyPI page). The yt-dlp bump workflow
changes only yt-dlp, and Dependabot proposes `yt-dlp-ejs` weekly, so after a
yt-dlp release that moves the scripts, live streams stop at 1080p and
made-for-kids videos fail until the `yt-dlp-ejs` pin catches up. Bump both together when you can.

## Desktop app { #desktop-app }

The [desktop app](../getting-started/install-desktop.md) installs the same `backend/requirements.lock` as the image, so the Python lock needs no separate step. Two more things are pinned.

### `desktop/vendor.lock.json`

It names the three programs the installer carries: Python ([python-build-standalone](https://github.com/astral-sh/python-build-standalone), 3.14), jellyfin-ffmpeg (the same major, 7, as the image's `jellyfin-ffmpeg7`) and deno. Each has a `version`, and for each of `win32-x64`, `darwin-arm64` and `linux-x64` a download `url` and its `sha256`. `desktop/scripts/fetch_vendor.py` refuses a file whose hash differs.

To bump one, change the `version` and, for **all three targets**, the `url` and `sha256` (run `sha256sum` on the files you download). Keep to a Python 3.14 patch release: a new minor changes the lock, CI and the image together, as for the image.

- **deno must equal the Dockerfile's** (`FROM denoland/deno:bin-<version>`), so the app and the image run the same one. Bump both in the same commit.
- **ffmpeg** stays on the major the image uses.
- **The YouTube helper** (`pot`) is the source of `bgutil-ytdlp-pot-provider`'s server at one tag, the same archive for all three targets. Its version must equal the plugin's pin in `backend/requirements.txt` (and should match the image tag in `docker-compose.yml`): the plugin and the server are released together. `build_runtime.py` installs its npm dependencies from the helper's own lock file and starts it once.
- `scripts/check_vendor_lock.py` runs inside the backend suite (`backend/tests/test_vendor_lock.py`), so it is part of `scripts/check.sh` and CI. It fails when an entry or target is missing, a hash is not 64 hex characters, a URL is not on `github.com`, or the deno versions differ. It needs no network. Nothing bumps this file for you: Dependabot does not read it.

The Desktop workflow then builds and starts the app with the new files, which is the real test of a bump.

### `desktop/package.json`

Dependabot opens a weekly grouped minor and patch pull request for `/desktop`, and separate pull requests for majors. Electron has a new major about every eight weeks and the latest three are supported, so a major is a review, not a project: the packaged-app test plays AV1, VP9 and H.264.

Two majors are held back on purpose:

- **electron-builder stays on major 26.** Version 26 updates an unsigned Windows app by checking the SHA-512 in the release's update file. Version 27 refuses unsigned Windows updates by default and adds its own signature to the update file. Moving to it is a decision made together with signing ([ADR 0042](../adr/0042-desktop-apps.md)), so Dependabot ignores its major. Likewise ESLint stays on the frontend's major.
- The AppImage toolset in `desktop/electron-builder.yml` (`toolsets.appimage`) selects the static runtime, which is why the AppImage needs no FUSE. Keep it when bumping electron-builder.

## Frontend

```bash
cd frontend
npm ci            # exact install from the lock file (what CI and Docker do)
npm audit --omit=dev --audit-level=high
```

Node 24 or newer is required (`engines` in `package.json`); the image, CI and
`.nvmrc` at the repo root use Node 26.

`overrides` in `package.json` forces a patched version of a dependency that a
package pins to a vulnerable range. Today it holds one: `minimatch` 11 for
`@typescript-eslint/typescript-estree`, which still asks for 10.x
([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249);
lint-time only, nothing ships in the image). Remove it once a
`typescript-eslint` release depends on `minimatch` 11.0.1 or newer, then run
`npm install` and `npm audit`.

Dependabot is told to ignore major updates of `eslint` and `@eslint/js`:
`eslint-plugin-jsx-a11y` 6.10.2 accepts ESLint 9 at most, so an ESLint 10 bump
fails `npm ci`. Remove that `ignore` from `.github/dependabot.yml` once
jsx-a11y supports ESLint 10, then bump `eslint` and `@eslint/js` together.

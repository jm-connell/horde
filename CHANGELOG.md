# Changelog

All notable changes to Horde are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release steps are in
[docs/development/release-process.md](docs/development/release-process.md).

## [Unreleased]

This section summarizes the architecture and operations overhaul at a high
level. Detailed per-area entries are added by the maintainer at release time.

### Upgrade notes

- **`update.sh` now follows releases, not `main`.** It installs the newest stable
  `vX.Y.Z` tag on a local `horde-release` branch (until the first release exists
  it follows `main` as before). To keep tracking `main` set
  `HORDE_UPDATE_CHANNEL=main` in `.env`; `prerelease` also accepts `-rc` tags. An
  install that is ahead of the latest release is not downgraded unless you set
  `HORDE_ALLOW_DOWNGRADE=1`.
- **`PUID=0` / `PGID=0` no longer start.** The container now refuses to run the
  app as root. Set `PUID`/`PGID` to the owner of your media dataset, or set
  `HORDE_ALLOW_ROOT=1` in `.env` if you really want the old behaviour.
- `DATA_PATH` must be on a local disk (SQLite WAL is unsafe on SMB/NFS).
- A checkout that follows `main` bakes a `git describe` version such as
  `1.2.0-5-gabc1234`; the in-app update check then only reports **new releases**,
  not every new commit on `main`.

### Added

- Versioned releases: tagging `vX.Y.Z` publishes multi-arch (amd64, arm64)
  images to `ghcr.io/jm-connell/horde` and creates a GitHub Release.
- Optional use of the published image instead of building from source
  (`HORDE_IMAGE`).
- `update.sh` takes a verified SQLite backup before every update, tags images by
  commit, and rolls back automatically when the new version is not healthy;
  `update.sh --rollback` does it on demand.
- Container healthcheck, `no-new-privileges`, a process limit, an optional memory
  limit, and a refusal to run as root unless `HORDE_ALLOW_ROOT=1`.
- Opt-in runtime yt-dlp updater (`YTDLP_AUTO_UPDATE=1`).
- Build identity in `/app/BUILD_INFO` and OCI labels (version, commit, ffmpeg).
- CI: image smoke test, security scanning (pip-audit, npm audit, Trivy,
  gitleaks), Dependabot and a daily yt-dlp bump pull request.

### Changed

- Reproducible builds: pinned base images (version and digest), `npm ci`, Node 22
  everywhere, a hash-checked `backend/requirements.lock`, pinned docs toolchain.
- The ffmpeg flavor is an explicit build argument (`FFMPEG_FLAVOR=jellyfin|debian`);
  the build fails instead of silently falling back to Debian ffmpeg.
- The in-app update check follows GitHub releases and ignores bot and docs-only
  commits, so installs no longer report an update every day.
- Clone statistics are kept on a separate `stats` branch instead of `main`.
- `update.sh` uses fetch and fast-forward only; it no longer stashes or merges.
- Backend dependency upgrades (FastAPI 0.143, Starlette 1.8, uvicorn 0.54,
  python-multipart 0.0.32) and frontend toolchain upgrades (Vite 8, Vitest 5).

### Fixed

- Known advisories in FastAPI/Starlette/python-multipart and in the frontend
  build toolchain.
- Documentation now states that `DATA_PATH` must be a local disk (SQLite WAL is
  unsafe on SMB/NFS) and warns about the TrueNAS example paths on other hosts.

### Removed

- The committed `backend/static` build output and the empty root
  `package-lock.json`.

[Unreleased]: https://github.com/jm-connell/horde/commits/main

# Desktop App Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Horde as a desktop app on Windows, macOS and Linux from the same `vX.Y.Z` tag that ships the Docker image.

**Architecture:** A thin Electron shell (`desktop/`, main process only) starts the unchanged server with a real bundled Python and holds its standard input as a lifeline. Third-party binaries are pinned by hash in one manifest. One reusable workflow builds an installer per OS; pull requests and the Release workflow both call it, and the release is published from a draft only when every asset exists.

**Tech Stack:** Electron 45, electron-builder 26, electron-updater 6, TypeScript, Playwright (Electron), vitest; python-build-standalone CPython 3.14, uv, jellyfin-ffmpeg 7 portable, deno; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-24-desktop-releases-design.md`

## Global Constraints

- Everything in `CLAUDE.md` applies (thin routers, state on `AppContext`, `response_model`, the error envelope, no silent `except`, `noqa` needs a reason, docs in the same change).
- No signing. macOS builds are ad-hoc signed (`identity: "-"`) and do not auto-install updates.
- The server binds `127.0.0.1` on a desktop unless sharing is on. Default port `8686`.
- No Node access from Horde's pages: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no preload on the Horde origin.
- No new unauthenticated HTTP route. Shell and server talk through the lifeline pipe, `DATA_DIR/desktop/status.json` and the ADR 0011 files in `DATA_DIR/update/`.
- Fixed asset names: `Horde-windows-x64-setup.exe`, `Horde-mac-arm64.dmg`, `Horde-mac-arm64.zip`, `Horde-linux-x64.AppImage`.
- Packaged layout mirrors the image's `/app`: `resources/backend/{app,static,source,BUILD_INFO}`, plus `resources/python/`, `resources/bin/{ffmpeg,ffprobe,deno}`, `resources/licenses/`.
- Tests: few and end-to-end. One Playwright-Electron spec for the shell, one subprocess test for the entry point, one small unit file per side for pure logic. The existing backend suite is what proves Windows and macOS.
- electron-builder stays on major 26 (27 refuses unsigned Windows updates by default).
- Interface wording follows `CLAUDE.md` and the tone of the docs: plain, no jargon.

## Review Focus

1. **The shell dies without quitting** (crash, Task Manager kill, logout): the server must exit by itself and leave no ffmpeg behind. Pinned in Task 2's test and Task 4's e2e.
2. **Port 8686 is taken at first run**: the app picks a free port, saves it and keeps it. Pinned in Task 4's unit test.
3. **A second launch while running, including at sign-in with `--hidden`**: no second server, the window opens (or stays hidden for `--hidden`). Pinned in Task 4's e2e.
4. **Paths with spaces and non-ASCII characters** (`C:\Users\José Núñez\`): data, media and resource paths are passed as arguments and environment, never through a shell string. Pinned in Task 2's test (data folder named `hörde data`) and Task 4's e2e (home folder with a space).
5. **An update arrives while something is running or being watched**: nothing installs until idle as the spec defines it. Pinned in Task 4's unit test of `isIdle`.

## File Structure

```
backend/app/desktop_entry.py            entry point: uvicorn in-process + lifeline
backend/app/services/desktop_status.py  status file writer, last-media stamp
backend/tests/test_desktop_entry.py     subprocess e2e of the entry point
backend/tests/test_desktop_status.py    status file contents
desktop/package.json, tsconfig.json, electron-builder.yml, eslint.config.js
desktop/src/main.ts        wiring only
desktop/src/logic.ts       pure decisions (unit tested)
desktop/src/paths.ts       per-OS folders, packaged vs dev resources
desktop/src/config.ts      desktop.json
desktop/src/server.ts      start, lifeline, health, restart, stop, status file
desktop/src/window.ts      BrowserWindow and its security handlers
desktop/src/tray.ts        tray and menu
desktop/src/autostart.ts   start at sign-in per OS, Linux menu entry
desktop/src/firstRun.ts    welcome step, first-close notice
desktop/src/updater.ts     electron-updater, idle install, ADR 0011 files
desktop/test/logic.test.ts unit tests
desktop/e2e/app.spec.ts    Playwright-Electron e2e (dev and packaged)
desktop/vendor.lock.json   pinned Python, ffmpeg, deno
desktop/scripts/fetch_vendor.py   download + verify + extract (stdlib only)
desktop/scripts/build_runtime.py  assemble desktop/build/resources
scripts/check_vendor_lock.py      manifest shape + deno pin equals the Dockerfile's
scripts/check_release_assets.py   expected asset list
.github/workflows/desktop-build.yml  reusable: one OS, one artifact, smoke test
.github/workflows/desktop.yml        pull requests and main
.github/workflows/release.yml        preflight → desktop → image → publish
```

---

### Task 1: Cross-platform Python lock

**Files:** Modify `backend/requirements.lock`, `scripts/check_requirements_lock.py`, `backend/tests/test_requirements_lock.py`, `.github/workflows/ytdlp-bump.yml` (both compile commands), `.github/workflows/dependabot-lock.yml`, `docs/development/dependencies.md`.

**Produces:** a lock that `pip install --require-hashes -r backend/requirements.lock` and `uv pip install --require-hashes` accept on Linux, Windows and macOS with CPython 3.14.

- [ ] Regenerate with `uv pip compile --universal --generate-hashes --python-version 3.14 backend/requirements.txt -o backend/requirements.lock` (the existing file is the starting point, so versions already pinned do not move). Expected diff: platform markers appear (`uvloop ... ; sys_platform != 'win32' ...`), `colorama` appears for Windows; no version of an existing package changes.
- [ ] Update the command string everywhere it is written (the check script's message, the two workflows, the doc) to include `--universal`.
- [ ] Extend `backend/tests/test_requirements_lock.py` with `test_lock_is_universal`: the lock contains a `sys_platform` marker on `uvloop` and a `colorama` entry.
- [ ] Run `python scripts/check_requirements_lock.py` and `pytest backend/tests/test_requirements_lock.py`: both pass.
- [ ] Run `uv pip install --dry-run --require-hashes -r backend/requirements.lock --python-platform windows --python-version 3.14` and the same with `--python-platform aarch64-apple-darwin`: both resolve.
- [ ] Commit: "Resolve the Python lock for Windows and macOS too".

### Task 2: Server entry point, status file, Windows priority

**Files:** Create `backend/app/desktop_entry.py`, `backend/app/services/desktop_status.py`, `backend/tests/test_desktop_entry.py`, `backend/tests/test_desktop_status.py`. Modify `backend/app/context.py` (a `desktop: DesktopRuntime` field), `backend/app/main.py` (start the status worker when `HORDE_RUNTIME=desktop`; `runtime` in the signed-in health payload), `backend/app/schemas.py`, `backend/app/services/health.py` (`BUILD_INFO_FILE` environment override of `/app/BUILD_INFO`), `backend/app/services/ffmpeg_bin.py` and its callers (low priority on Windows), the media-serving routes (stamp), `backend/app/config.py` (`HORDE_RUNTIME`), `backend/openapi.json`, `frontend/src/api/schema.d.ts`, `docs/ops/environment.md`.

**Produces:**
- `python -m app.desktop_entry`: serves `app.main:app` on `HOST`/`PORT` with a 10 second graceful shutdown; a daemon thread reads standard input line by line and, at end of file, sets `server.should_exit = True`. Unknown lines are ignored. Exit code 0 on a clean stop.
- `config.HORDE_RUNTIME: str` = `"desktop"` when the environment says so, else `"server"`.
- `DATA_DIR/desktop/status.json`, rewritten atomically every 5 seconds and once at shutdown, only when the runtime is desktop:
  ```json
  {"written_at": "2026-11-24T10:00:00+00:00", "pid": 1234, "version": "1.4.2",
   "setup_required": false, "busy": true,
   "running": {"download": 2, "ffmpeg": 1}, "queued": 3,
   "last_media_at": "2026-11-24T09:58:12+00:00"}
  ```
  `running` counts `activity.snapshot()["running"]` by task kind; `queued` is the sum of its queue counts; `busy` is `bool(running) or queued > 0`; `last_media_at` is null until a video, preview or live segment has been served.
- `desktop_status.track_media`: a route dependency on the endpoints that send video bytes (library video, DASH preview, live HLS). It counts a response as in flight until it has been sent, so one long response (a whole film) keeps `busy` true; `media_active` in the status file is that count.
- `ffmpeg_bin.low_priority_kwargs() -> dict[str, int]`: `{"creationflags": subprocess.BELOW_NORMAL_PRIORITY_CLASS}` on Windows, `{}` elsewhere, passed to `Popen`/`run` wherever `below_playback` wraps the command.
- Health for signed-in users gains `runtime: "server" | "desktop"`.

- [ ] Write `test_desktop_entry.py::test_serves_then_stops_when_stdin_closes`: start `[sys.executable, "-m", "app.desktop_entry"]` with `cwd=backend`, `stdin=PIPE`, a free port, `HOST=127.0.0.1`, `HORDE_RUNTIME=desktop`, `HORDE_E2E=1` (no network workers), and `DATA_DIR` a temp folder named `hörde data`; poll `GET /api/ping` until 200 (30 s limit); assert `desktop/status.json` appears with `setup_required: true`, `busy: false`; write `b"unknown\n"` and assert it still answers; close stdin; assert `proc.wait(timeout=20) == 0` and the port no longer accepts connections. The fixture kills the process on failure.
- [ ] Run it: fails (no module).
- [ ] Implement `desktop_entry` and `desktop_status`; register the writer through the `WorkerRegistry` (it must run under `HORDE_E2E` too).
- [ ] Write `test_desktop_status.py`: with the `client` fixture, `build_status(ctx)` reports `busy: true` and `running == {"ffmpeg": 1}` while an `activity.track(...)` task of kind ffmpeg is open, and `last_media_at` is set after `note_media_served()`.
- [ ] `test_ffmpeg_bin` (existing file if present, else in `test_desktop_status.py`): `low_priority_kwargs()` is `{}` on POSIX; with `os.name` patched to `"nt"` and `subprocess.BELOW_NORMAL_PRIORITY_CLASS` patched in, it returns that flag.
- [ ] Regenerate `backend/openapi.json` and `frontend/src/api/schema.d.ts` (`npm run gen:api`).
- [ ] Run `pytest tests/test_desktop_entry.py tests/test_desktop_status.py tests/test_permissions.py tests/test_code_conventions.py`, `ruff check .`, `ruff format --check .`, `mypy`: all pass.
- [ ] Commit: "Add the desktop entry point and status file".

### Task 3: Desktop wording in the web UI

**Files:** Modify `frontend/src/pages/settings/system/UpdatesSection.tsx`, `frontend/src/pages/settings/system/updateView.ts`, `frontend/src/pages/Setup.tsx` (and wherever the `host.docker.internal` hint lives), `backend/app/services/ytdlp_common.py` (bot-check messages), tests beside them. Create `frontend/e2e/desktop-wording.spec.ts`.

**Consumes:** `runtime` from the health payload (Task 2).

- [ ] Updates, runtime desktop, watcher present: the confirm text says Horde restarts to install and, if the new version does not start, shows how to get the previous one. No promise of an automatic return.
- [ ] Updates, runtime desktop, watcher missing: instead of the cron setup help, "This computer installs updates by hand. Download the new version" with a link to `https://github.com/<repo>/releases/latest` through `safeHref()`.
- [ ] AI setup, runtime desktop: the Ollama hint says `http://localhost:11434`, not `host.docker.internal`.
- [ ] Bot-check errors, runtime desktop: no mention of Compose or `bgutil-pot`; say that YouTube asked for a sign-in check and to try again later or add cookies (the existing cookies wording).
- [ ] `desktop-wording.spec.ts`: with `page.route` rewriting the health response to `runtime: "desktop"`, assert the three UI texts above and that the Docker ones are absent; one test with the real response asserts the Docker texts are unchanged.
- [ ] A backend test for the bot-check message under `HORDE_RUNTIME=desktop` in the existing error-message test file.
- [ ] Run the affected vitest files, `npx playwright test e2e/desktop-wording.spec.ts`, eslint, prettier, tsc: pass.
- [ ] Commit: "Say desktop things on a desktop".

### Task 4: The Electron shell

**Files:** everything under `desktop/src`, `desktop/test`, `desktop/e2e`, `desktop/package.json`, `desktop/tsconfig.json`, `desktop/eslint.config.js`, `desktop/playwright.config.ts`, `desktop/.gitignore`. Modify `scripts/check.sh` (eslint, prettier, tsc, vitest for `desktop/`), `.github/dependabot.yml` (npm ecosystem for `/desktop`).

**Consumes:** `python -m app.desktop_entry`, `status.json`, the ADR 0011 files (`request.env`, `current.env`, `status.env`, `watcher.env`; keys as in `scripts/update_watch.sh` and `backend/app/services/update_control.py`).

**Produces** (names later tasks rely on):
- Environment overrides for development and tests: `HORDE_DESKTOP_HOME` (root for data, logs and `desktop.json`), `HORDE_DESKTOP_PYTHON`, `HORDE_DESKTOP_BACKEND_DIR`, `HORDE_DESKTOP_BIN_DIR`, `HORDE_DESKTOP_TEST=1` (no welcome step, no updater, no notifications; exposes `globalThis.__hordeTest = { trayMenu(): {label, enabled, checked}[], clickTray(label), serverPid(), port() }`).
- Command line: `--hidden` (no window at start).
- `desktop.json`: `{ "port": 8686, "mediaDir": "...", "shareOnNetwork": false, "welcomed": true, "closeNoticeShown": false, "pendingUpdate": null }`.
- `logic.ts` exports: `class RestartLimiter(max = 3, windowMs = 300_000) { allow(now: number): boolean }`; `isIdle(s: { windowOpen: boolean; status: ServerStatus | null; now: number }): boolean` (false when status is null, stale by more than 30 s, busy, or `last_media_at` within 15 minutes); `statusLine(status: ServerStatus | null): string`; `choosePort(preferred: number, isFree: (p: number) => Promise<boolean>): Promise<number>`; `parseEnvFile(text: string): Record<string, string>`; `watcherAction(files: { request?: Record<string,string>; status?: Record<string,string> }, updater: UpdaterState): WatcherAction`.

Behaviour, each item as the spec defines it: start and wait for `/api/ping`; lifeline; stop with a 40 second wait then tree kill; restart at most 3 times in 5 minutes then an error window with Open logs and Quit; single instance; window created on demand and destroyed on close; navigation confined to the server's origin and other `http(s)` links opened in the default browser; permission requests denied except fullscreen, pointer lock and clipboard write; tray menu as in the spec (the status line from `statusLine`; "Pause background work" is not part of this task); welcome step and first-close notice with native dialogs; start at sign-in (Windows and macOS through `app.setLoginItemSettings` with `--hidden`; Linux through `~/.config/autostart/horde.desktop`); Linux menu entry and icon under `~/.local/share` rewritten at each start when `APPIMAGE` is set; a 30 second delay before starting the server when launched with `--hidden`; Share on my home network (needs `setup_required: false`; restarts the server with `HOST=0.0.0.0`; shows the LAN address); logs to a rotating file (5 files of 5 MB); updater (check at start and every 6 hours; download on Windows and Linux; install on quit and when `isIdle`; on macOS notice only; play the ADR 0011 watcher on Windows and Linux; after an update, if the server is not healthy in 120 seconds, show the could-not-start window with the previous version's release link).

- [ ] `desktop/test/logic.test.ts` first, covering: `RestartLimiter` allows 3 in 5 minutes and refuses the 4th, allows again after the window; `isIdle` false for each reason and true otherwise (15 minute boundary); `choosePort` returns 8686 when free and the next free port when not; `parseEnvFile` ignores lines without `=`; `watcherAction` returns `stamp`, `start`, `report-updated`, `report-up-to-date`, `report-failed` for the corresponding inputs.
- [ ] `desktop/e2e/app.spec.ts`, run against the repository's Python in development and against the packaged app in CI (`HORDE_DESKTOP_APP` = path to the packaged executable), with `HORDE_DESKTOP_HOME` a temp folder whose name contains a space:
  1. the window shows the create-admin page;
  2. `MediaSource.isTypeSupported` is true for `video/mp4; codecs="avc1.640028"`, `video/mp4; codecs="av01.0.08M.08"`, `video/webm; codecs="vp09.00.40.08"` and `audio/mp4; codecs="mp4a.40.2"`;
  3. `window.require`, `window.process` and `window.electron` are undefined in the page;
  4. clicking a link to `https://example.com` does not navigate the window;
  5. closing the window leaves `/api/ping` answering, and the tray's "Open Horde" opens a window again;
  6. launching a second instance exits at once and the first shows a window;
  7. the tray menu contains every label in the spec;
  8. after "Quit Horde" the server process is gone and the port is closed;
  9. killing the Electron process (not quitting) also ends the server within 20 seconds.
- [ ] Implement; `npm run lint`, `npm run typecheck`, `npm test`, `npm run e2e` pass locally on Linux.
- [ ] Commit: "Add the desktop shell".

### Task 5: Pinned binaries and packaging

**Files:** Create `desktop/vendor.lock.json`, `desktop/scripts/fetch_vendor.py`, `desktop/scripts/build_runtime.py`, `desktop/electron-builder.yml`, `desktop/build/` (ignored), `desktop/assets/` (icons from `frontend/public/icon-512.png`), `desktop/installer.nsh`, `scripts/check_vendor_lock.py`, `backend/tests/test_vendor_lock.py`. Modify `scripts/check.sh`.

**Produces:**
- `vendor.lock.json`: `{ "python": {"version": "3.14.x", "targets": {"win32-x64": {"url", "sha256"}, "darwin-arm64": {...}, "linux-x64": {...}}}, "ffmpeg": {"version", "targets": ...}, "deno": {"version", "targets": ...} }`. Python from python-build-standalone `install_only_stripped`; ffmpeg from the newest jellyfin-ffmpeg 7.x release that has portable archives for all three targets; deno at the Dockerfile's version.
- `python desktop/scripts/fetch_vendor.py --target <os>-<arch> --out desktop/build/vendor`: downloads to a cache, refuses a hash mismatch, extracts. Standard library only.
- `python desktop/scripts/build_runtime.py --target <os>-<arch> --version <v> --sha <sha>`: assembles `desktop/build/resources` in the packaged layout, installs the lock into the bundled Python with `uv pip install --require-hashes`, copies `backend/app`, `frontend/dist` (to `backend/static`), the built wiki, the "Ask about Horde" sources the Dockerfile copies, writes `BUILD_INFO`, collects licences, ad-hoc signs Mach-O files on macOS, and then proves it: runs the bundled Python importing `app.main`, and `ffmpeg -version`, `ffprobe -version`, `deno --version`.
- `electron-builder.yml`: `appId: io.github.jm-connell.horde`, `productName: Horde`, the four fixed artifact names, NSIS one-click per-user with an uninstall question about Horde's data (default keep), `mac.identity: "-"` with dmg and zip, AppImage with `toolsets.appimage: "1.0.3"`, `publish: github` (never published by the builder itself).
- `npm run dist -- --<os>` in `desktop/` produces the installer under `desktop/release/`.

- [ ] `test_vendor_lock.py`: every target has an `https://` URL on github.com and a 64-hex `sha256`; the deno version equals the Dockerfile's `denoland/deno:bin-<version>`.
- [ ] Build the Linux target locally end to end; run `desktop/e2e/app.spec.ts` against `desktop/release/linux-unpacked/horde`.
- [ ] Commit: "Package the desktop app with pinned Python, ffmpeg and deno".

### Task 6: Desktop CI

**Files:** Create `.github/workflows/desktop-build.yml`, `.github/workflows/desktop.yml`. Modify `docs/getting-started/testing.md`.

**Produces:**
- `desktop-build.yml` (`workflow_call`; inputs `version`, `upload`): job `web` builds `frontend/dist` and the wiki once on Linux and shares them; job `build` is a matrix of `windows-2025` / `win32-x64`, `macos-15` / `darwin-arm64`, `ubuntu-24.04` / `linux-x64`: fetch, assemble, `npm run dist`, the packaged e2e (under `xvfb-run` on Linux), upload the artifact with its `latest*.yml` and blockmap.
- `desktop.yml` (pull requests, `main`): job `backend` runs the backend suite on `windows-2025` and `macos-15` (`pytest -q -n auto`), job `shell` runs lint, types and unit tests, then calls `desktop-build.yml` with version `0.0.0-dev`.
- Actions pinned by commit SHA like the existing workflows; `permissions: contents: read`.

- [ ] Validate both files with `actionlint` if available, else by `python -c "import yaml; yaml.safe_load(open(...))"`.
- [ ] Commit: "Build and test the desktop app on Windows, macOS and Linux".
- [ ] After the branch is pushed: read the Windows and macOS backend results, fix what they show (each fix its own commit with a test), and mark a test Linux-only only with a written reason.

### Task 7: Release wiring, docs and the decision record

**Files:** Modify `.github/workflows/release.yml`, `docs/development/release-process.md`, `docs/getting-started/other-platforms.md`, `docs/getting-started/updating.md`, `docs/ops/security.md`, `README.md`, `CHANGELOG.md`, `PRODUCT.md`, `mkdocs.yml`, `docs/adr/index.md`. Create `scripts/check_release_assets.py`, `backend/tests/test_release_assets.py`, `docs/getting-started/install-desktop.md`, `docs/adr/0042-desktop-apps.md`.

**Produces:**
- `release.yml` jobs: `preflight` (today's checks plus Desktop green on the commit) → `desktop` (calls `desktop-build.yml` with the tag's version) → `image` (today's build and push) → `publish` (create the release as a draft with today's notes, upload every desktop asset and `SHA256SUMS`, `scripts/check_release_assets.py`, attest, then publish).
- `python scripts/check_release_assets.py <dir>`: exits non-zero and names what is missing unless the folder holds the four fixed assets, `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, the blockmaps of the exe and zip, and `SHA256SUMS` listing each.

- [ ] `test_release_assets.py`: complete folder passes; removing any one file fails and names it; a `SHA256SUMS` missing an entry fails.
- [ ] Docs as the spec lists; the install page shows the first-open step per OS (screenshots are added by the owner after the hands-on check; the page has the clicks in words) and the hands-on checklist goes in the release-process doc.
- [ ] `mkdocs build --strict` passes.
- [ ] Commit: "Publish desktop apps with each release" and "Document the desktop app".

### Task 8: Review and full gate

- [ ] One independent review of the shell, the entry point and the workflows (process control, an updater, network exposure, release publishing), assuming they are broken; fix findings.
- [ ] `scripts/check.sh --e2e` once.

## Not in this plan

- Tray "Pause background work" and waiting on battery (spec Phase 5). The bundled YouTube helper and the upgrade smoke test were added after the first review, at the owner's request.
- Signing (spec Phase 6).
- The hands-on checks on a real Windows PC and Mac, which are the owner's.

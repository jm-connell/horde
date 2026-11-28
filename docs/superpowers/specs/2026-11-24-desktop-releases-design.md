# Desktop app releases: design

Date: 2026-11-24. Status: proposed, awaiting approval.

## Intent

Horde is installed today with Docker, a terminal and a `.env` file. That keeps out people who would use it but are not technical. A desktop app (download, double-click, done) on Windows, macOS and Linux gives them a way in. It has to behave like a normal program: found by searching "Horde", pinned to the taskbar, opened in its own window. It keeps working in the background so downloads finish, without surprising anyone or slowing their computer.

The second half of the intent is the maintainer's: every release must produce the desktop apps without extra thought. One tag, one workflow, the Docker image and all installers, or nothing.

## What was found

In the repository:

- The server is one Python process with plain dependencies (FastAPI, SQLite, numpy, Pillow, psutil, watchdog). It already runs natively on Windows for development (`dev.bat`). yt-dlp is imported as a library, not run as a program.
- Paths and tools are already set by environment: `DATA_DIR`, `DOWNLOADS_DIR`, `HOST`, `PORT`, `FFMPEG_BIN`, `YTDLP_JS_RUNTIME`, `HORDE_FRONTEND_DIR`, `HORDE_VERSION`. A desktop shell can configure the server without code forks.
- `backend/requirements.lock` is resolved for Linux only (`uvloop` unconditional, no Windows-only packages, no platform markers). It cannot install on Windows as it is.
- Tests and CI run on Linux only. Nothing proves the server on Windows or macOS.
- Some code is Linux-shaped: hardware encoder detection reads `/dev/dri` and `/dev/nvidia*`, `storage_check` reads `/proc`, `below_playback` lowers ffmpeg priority with `nice` (POSIX only).
- The Docker default binds `0.0.0.0` and the first visit creates the admin account. On a laptop on shared Wi-Fi that is a takeover risk.
- YouTube downloads rely on a helper container (`bgutil-ytdlp-pot-provider`, a Node server). Without it Horde runs, but hits bot checks sooner.
- "Update now" already works through files (`DATA_DIR/update/request.env`, `watcher.env`, `status.env`, [ADR 0011](../../adr/0011-in-app-updates.md)): Horde writes a request and something outside the server acts on it. The server backs up the database before any migration.
- A forgotten password is recovered by reading the server log ([ADR 0012](../../adr/0012-password-reset-through-the-server-log.md)), so a desktop user must be able to open the log.
- The licence is PolyForm Noncommercial, not an OSI licence.

From research (checked 24 Nov 2026):

- Comparable servers (Jellyfin, Plex, Sonarr, Stash) ship a tray icon and open the browser. Embedded system webviews (Tauri, pywebview, Wails) run the player on Safari's engine on Mac and WebKitGTK on Linux, Horde's weakest playback paths.
- Unsigned apps: Windows shows "Windows protected your PC" on every release, and Smart App Control can block them. macOS 15 and later removed right-click Open: the only way is System Settings → Privacy & Security → Open Anyway.
- Free open-source signing (SignPath Foundation) needs an OSI licence, so it is not available to Horde. Paid options: Apple Developer Program $99/yr; Azure Artifact Signing about $120/yr, individuals in the US or Canada only.
- GitHub gives free Windows, macOS (arm64 and Intel) and Linux runners to public repositories, and free build attestations.
- yt-dlp needs a JavaScript runtime for parts of YouTube; Horde already bundles deno off `PATH` in the image ([ADR 0039](../../adr/0039-deno-only-as-a-fallback.md)).
- Electron 45 is current (Chromium 156, Node 24), with a new major about every 8 weeks and the latest three supported. Official builds include H.264 and AAC.
- electron-builder is the fit for NSIS, dmg and AppImage published to GitHub Releases (Electron Forge has no NSIS or AppImage maker). Its stable line (26) updates an unsigned Windows app on the SHA-512 in the release's update file. The coming 27 refuses unsigned updates unless told otherwise and adds its own signature on the update file, so the major is pinned and moved deliberately.
- electron-builder 26 builds AppImages with the old FUSE 2 runtime by default, which fails on current Fedora and Ubuntu; the static runtime has to be selected.
- Apple silicon runs only signed code, but a free ad-hoc signature is enough. electron-builder does not add one unless asked. Electron's start-at-sign-in call "may silently fail" on an unsigned Mac app.
- The YouTube helper (`bgutil-ytdlp-pot-provider`, GPL-3.0) runs on Node 22+ or Deno 2+, so the deno Horde already bundles can run it.
- jellyfin-ffmpeg publishes portable builds for Windows, macOS (arm64 and Intel) and Linux. Its newest line is 8.1; the image uses 7.

## Goals

- A person with no terminal experience installs Horde on Windows, macOS or Linux from one downloaded file and reaches the create-admin page with no other step.
- Horde appears in the Start menu, Launchpad or app grid, can be pinned, and opens in its own window.
- Closing the window leaves Horde running in the tray so downloads and scheduled work continue. Starting at sign-in is offered, on by default, and always visible and reversible.
- Background running is transparent: the first close says Horde is still running and where; the tray shows what it is doing; Quit really quits.
- Background work does not make the computer feel slow.
- Pushing a `vX.Y.Z` tag builds, smoke-tests and publishes the Docker image and every desktop installer. A release is published only when all of them passed. No version number is edited by hand for the desktop apps.
- Desktop apps update themselves where the OS allows it unsigned (Windows, Linux); elsewhere they say a new version exists.
- The desktop app runs the same server code, the same pinned dependencies and the same ffmpeg flavour as the image, so a bug report means the same thing on both.
- Signing can be switched on later by adding secrets, without restructuring.

## Non-goals

- Code signing and notarization now (owner's decision: no signing for now).
- A separate desktop product: no desktop-only features in the web UI. The UI does change its wording where the Docker text would be wrong on a desktop (see The web UI on a desktop).
- Changing the auth model. The desktop app still has accounts and a sign-in; the window stays signed in.
- Replacing Docker. Docker stays the recommended install for servers and NAS boxes, and the main Linux path.
- Automatic rollback of a failed desktop update (see Updates).
- Windows on ARM, Intel Mac, Linux ARM builds, the Microsoft Store, winget, Homebrew, Flatpak. The pipeline is a matrix, so each is one more row later.
- Moving the media folder from the app after first run.
- Chromecast inside the app window. Electron does not appear to include Cast (to be confirmed in Phase 0); "Open in browser" covers it.

## Anti-goals

- A background app that people do not know is running, cannot find, or cannot stop.
- A desktop release path that needs manual steps per release, or that can publish a release with some installers missing.
- Two diverging servers: desktop-only code paths in the backend beyond small, tested platform shims.
- Node or shell access reachable from web content. The window shows Horde's pages, which render data from the internet (titles, descriptions, comments).
- A regression to the existing player or to the Docker install.
- Listening on the network by default on a personal computer.

## Constraints

- No signing budget for now. macOS can therefore not auto-update and needs the Open Anyway step; it ships labelled as a preview.
- Solo maintainer: every recurring chore must be automated or gated by CI.
- Project rules in `CLAUDE.md` apply: no module-level mutable state, state on `AppContext`, typed endpoints, the one error envelope, docs and ADR in the same change, tests in proportion.
- The existing release rules stay: tags are immutable, a release is fixed forward, the tag must be on a green `main`.

## Approaches

### The app window

1. **Tray icon and the person's browser.** Smallest and least to maintain; Chromecast works. But the pinned icon opens a browser tab that gets lost, and playback depends on a browser nobody chose (Safari on most Macs).
2. **System webview window (Tauri, pywebview).** Small download and a real window, but Safari's engine on Mac and WebKitGTK on Linux for an MSE player, plus known problems keeping a bundled Python process alive and replaceable.
3. **Electron window.** A real window with the same Chromium on every OS, which is also what the Playwright suite runs. One mature toolchain for tray, start at sign-in, single instance, installers and updates from GitHub Releases. Costs about 100 MB of download, memory while the window is open, no Chromecast in the window, and an Electron bump every few weeks.

**Picked by the owner: 3, Electron**, because people should be able to search "Horde", pin it and open it without thinking, and the player should behave the same everywhere.

### Python inside the app (my call)

1. **Freeze with PyInstaller.** One folder of compiled modules. Needs hooks per package, changes how imports and data files resolve, and is the usual source of antivirus false positives.
2. **Ship a real Python** ([python-build-standalone](https://github.com/astral-sh/python-build-standalone)) with the dependencies installed from `requirements.lock` into it.

**Picked: 2.** The server runs exactly as it does in the image and in development: same interpreter, same lock file, real tracebacks, Alembic and data files found by ordinary paths. No freezing step to debug. The cost is more files in the installer.

### How the release is wired (my call)

1. **A separate desktop workflow triggered by the tag.** Simple, but the image and the installers can succeed or fail independently, so half a release can ship.
2. **One Release workflow with ordered jobs**, building through a reusable workflow that pull requests also run.

**Picked: 2.** What is built on a tag is what was tested on the pull request, and publishing is one last job that runs only when everything before it passed.

## Design

### Shape

```
┌──────────────── Horde desktop app ────────────────┐
│ Electron shell (desktop/, TypeScript, main only)  │
│   window · tray · start at sign-in · updater      │
│        │ starts, watches, stops                   │
│        ▼                                          │
│ Horde server (the same backend/app, real Python)  │
│   127.0.0.1:8686 · workers · SQLite               │
│        │ runs                                     │
│        ▼                                          │
│ ffmpeg / ffprobe · deno (pinned, bundled)         │
└───────────────────────────────────────────────────┘
```

The shell is deliberately thin. It owns only what a browser tab cannot do: the window, the tray, starting at sign-in, starting and stopping the server, and updating the app. Everything else stays in the server and the existing web UI, so the Docker install and the desktop app remain one product.

New top-level folder `desktop/`:

- `package.json`, `electron-builder.yml`: Electron, electron-builder, electron-updater.
- `src/`: the main process. No renderer code and no preload for Horde's pages.
- `vendor.lock.json`: pinned third-party binaries (below).
- `scripts/`: fetch the pinned binaries, assemble the Python runtime.
- `e2e/`: the packaged-app smoke test.

One new backend module, `app/desktop_entry.py`: starts uvicorn in-process and stops it cleanly when the shell goes away.

### Starting, stopping and crashing

- The shell starts the server as a child process with its settings in the environment (`DATA_DIR`, `DOWNLOADS_DIR`, `HOST`, `PORT`, `FFMPEG_BIN`, `YTDLP_JS_RUNTIME`, `HORDE_FRONTEND_DIR`, `HORDE_VERSION`, `HORDE_GIT_SHA`, `HORDE_RUNTIME=desktop`), waits for `GET /api/ping`, then opens the window at `http://127.0.0.1:<port>/`.
- **Lifeline.** The server's standard input is a pipe held by the shell. When it closes, for any reason including a shell crash, `desktop_entry` asks uvicorn to shut down gracefully. This is the stop signal on every OS (Windows has no SIGTERM for a windowless child) and it is what prevents an orphaned server. On Quit the shell closes the pipe, waits up to 40 seconds (the stop time Compose gives the container), then kills the process tree.
- **Server crash.** The shell restarts it, at most 3 times in 5 minutes, then shows a plain error window with "Open logs" and "Quit". Never a silent restart loop.
- **One instance.** A second launch does not start a second server; it opens (or focuses) the window of the first. This is also the way back in when the tray icon is not visible (GNOME).
- **The window** is created when asked for and destroyed when closed, so no Chromium page stays in memory while Horde is in the background. Closing it never stops the server.
- **Server output** goes to a rotating log file. The tray has "Open logs" (needed for password reset codes).

### What is inside the installer

| Part | Source | Pinned by |
|---|---|---|
| Electron, electron-builder 26, electron-updater | npm | `desktop/package-lock.json` (Dependabot) |
| Python 3.14 | python-build-standalone | `vendor.lock.json`: version, URL and SHA-256 per OS |
| Python packages | PyPI | `backend/requirements.lock`, hash-checked, the same file the image uses |
| ffmpeg, ffprobe | jellyfin-ffmpeg portable builds, the same major (7) as the image's `jellyfin-ffmpeg7` | `vendor.lock.json` |
| deno | denoland releases, the version the Dockerfile pins | `vendor.lock.json`; a gate check fails when the two differ |
| Web UI and wiki | built once from this commit | n/a |
| Docs and source for "Ask about Horde" | this commit | n/a |

`requirements.lock` becomes a universal lock (`uv pip compile --universal`), so one file resolves on Linux, Windows and macOS. `scripts/check_requirements_lock.py`, the yt-dlp bump workflow, the Dependabot lock workflow and `docs/development/dependencies.md` change to match. The Docker image keeps installing from it with `--require-hashes`.

Licence texts for every bundled part are collected into the app (`licenses/`) and shown from About. ffmpeg is shipped as an unmodified separate program with its licence and a link to its exact source.

On macOS the app and every bundled binary (Python, ffmpeg, ffprobe, deno) get an ad-hoc signature at build time, which Apple silicon requires to run them at all. It is free and is not the paid Developer ID signature.

### Folders, port and network

| | Windows | macOS | Linux |
|---|---|---|---|
| Program | `%LOCALAPPDATA%\Programs\Horde` | `/Applications/Horde.app` | the AppImage file, plus a menu entry and icon it writes for itself |
| Data (`DATA_DIR`) | `%LOCALAPPDATA%\Horde\data` | `~/Library/Application Support/Horde/data` | `$XDG_DATA_HOME/horde/data` |
| Logs | `%LOCALAPPDATA%\Horde\logs` | `~/Library/Logs/Horde` | `$XDG_STATE_HOME/horde/logs` |
| Media (default) | `Videos\Horde` | `~/Movies/Horde` | the XDG videos folder, `/Horde` |

- Data is on a local disk and outside roaming profiles and cloud-synced folders, as the database requires.
- The shell keeps a small `desktop.json` beside the data folder for its own choices only: port, media folder, share on network, whether the first-run and first-close notices were shown. Horde's own settings stay where they are.
- **Port.** `8686`, the port the install guides already use. If another program holds it at first run, the shell picks a free port and saves it, so the address stays the same from then on (sign-in, the offline store and phone bookmarks depend on a stable address).
- **Network.** The server binds `127.0.0.1`. The tray has "Share on my home network": available only once an admin account exists, it explains what it does (and that Windows will ask to allow it through the firewall), restarts the server on `0.0.0.0`, and then shows the address other devices can open. Off by default.

### First run and background behaviour

First run, before the server starts, one welcome step:

```
Welcome to Horde

Videos are saved to:   C:\Users\Sam\Videos\Horde      [Change…]

[x] Start Horde when I sign in
    Horde keeps running in the background so downloads can
    finish. You'll find it next to the clock. Quit it there
    any time.

                                             [ Continue ]
```

Then the existing create-admin page.

The first time the window is closed, one notification: "Horde is still running. Open or quit it from the icon next to the clock." Shown once.

Tray menu, the same items on every OS:

```
Open Horde
Open in browser
──────────────
Idle                      (or: Downloading 2 videos · Making thumbnails)
Pause background work  ▸  For 1 hour / Until I resume
──────────────
✓ Start Horde when I sign in
  Share on my home network
──────────────
Open media folder
Open logs
Check for updates          (or: Restart to update to 1.5.0)
About Horde 1.4.2
──────────────
Quit Horde
```

- "Quit Horde" stops the server too. If downloads are running it asks first.
- Started at sign-in, Horde opens no window, and waits 30 seconds before starting the server so it does not compete with everything else at sign-in.
- Start at sign-in uses the OS's own mechanism (below), so it shows up in Task Manager's Startup apps and macOS Login Items, and a choice made there is respected, never silently re-added. On an unsigned Mac the login item call may not take effect; Phase 0 checks it, and if it does not, the shell writes a per-user LaunchAgent instead until the app is signed.
- The shell needs to know what the server is doing (to ask before Quit, and later for the status line and updates). The channel between them must be private to the two processes: a status file the server writes under `DATA_DIR` for state, and lines on the lifeline pipe for commands, in the style of ADR 0011. No new unauthenticated HTTP route. A minimal status file (what is running: downloads, ffmpeg jobs, AI work, live recordings; when a video was last served) is part of Phase 2. The status line and Pause in the tray arrive in Phase 5.

### Staying out of the way

- Nothing of the window stays in memory when it is closed.
- ffmpeg work that is not playback (thumbnails, sprites, compatibility copies, post-processing) runs at low OS priority on every OS. Today `below_playback` does this with `nice` on POSIX; it gains a Windows form (below-normal priority class). The server itself stays at normal priority because it serves playback.
- The existing limits stay as they are (`MAX_DOWNLOAD_CONCURRENCY=2`, `SPRITE_CONCURRENCY=1`, single-flight AI).
- Later phase: on battery, heavy optional work (encodes, sprites, embeddings) waits; downloads the person asked for do not. On by default, with a switch.
- Horde does not keep the computer awake.

### Updates

- **Windows and Linux.** The shell checks GitHub Releases at start and every 6 hours, downloads a new stable version in the background (changed blocks only on Windows), and installs it on the next quit. Because a background app may not be quit for weeks, it also installs by itself when Horde is idle (the owner's decision). Idle means all of: the window is closed; the status file shows no downloads, ffmpeg jobs, AI work or live recordings; and no video has been served to any device in the last 15 minutes (this covers someone watching from another device while sharing is on). A notification says "Horde was updated to 1.5.0". The tray shows "Restart to update" while one is waiting. Pre-release tags are never offered to stable installs.
- **macOS, while unsigned.** Auto-install needs a signed app. The shell only checks, and "A new version is available" opens the download page.
- **"Update now" in Settings** keeps working through the files of ADR 0011. On Windows and Linux the shell plays the part of the host watcher: it stamps `watcher.env` so the button is shown, picks up `request.env`, installs the downloaded update and writes the outcome to `status.env`. On unsigned macOS it does not stamp, so the button is hidden, as ADR 0011 already defines for a missing watcher. No new API.
- **The database** is backed up by the server before a migration, as today.
- **A new version that will not start.** The shell knows it just updated. If the server is not healthy within the timeout it shows "Horde 1.5.0 could not start" with "Open logs" and a link to the previous version's download, and says the database backup is in the data folder. Automatic rollback is left out: it would mean reinstalling the old program and restoring the database unattended, which is the riskiest code in `update.sh` and has no equivalent in the desktop updater. The pipeline's upgrade smoke test (below) is the protection instead.
- **yt-dlp fixes** reach desktop users as patch releases through auto-update, the existing practice ("merge the bump and cut a patch release"). The opt-in `YTDLP_AUTO_UPDATE` path stays Docker-only for now.

### The web UI on a desktop (my call)

`HORDE_RUNTIME` does not change what the server does, but the UI must not show Docker instructions to someone who has never seen Docker. The runtime is exposed to the UI with the existing system information, and the UI changes wording in the places that are wrong on a desktop. Known ones:

- Settings → Updates: where the watcher is missing it explains the cron job. On a desktop it says updates install by themselves, or on an unsigned Mac that a new version is downloaded from the release page.
- The update confirmation promises an automatic return to the current version. On a desktop it says what actually happens.
- AI setup says "Horde runs in Docker, so use host.docker.internal". On a desktop a local Ollama is at `localhost`.
- Bot-check errors point at the Compose `bgutil-pot` service.

Each gets a Playwright check. Layout and features stay the same.

### Differences between the three

Everything not in this table is identical.

| | Windows | macOS | Linux |
|---|---|---|---|
| Artifact | NSIS installer, per-user, no admin prompt | `.dmg` (and `.zip`, kept for auto-update later) | AppImage with the static runtime (no FUSE needed) |
| Architecture | x64 | arm64 | x64 |
| Tray | Notification area | Menu bar | Where the desktop has one; relaunching Horde always opens the window |
| Start at sign-in | Run key via Electron's login item API | Login item via the same API (LaunchAgent fallback while unsigned) | An XDG autostart `.desktop` file pointing at the AppImage |
| Auto-update unsigned | Yes | No, notice only | Yes |
| First open unsigned | SmartScreen: More info → Run anyway | System Settings → Privacy & Security → Open Anyway | Mark the file executable |
| Status | Supported | Preview until signed | Supported, Docker recommended |
| Uninstall | Apps list; asks whether to also delete Horde's data, never videos | Drag to Trash | Delete the file; the install guide says how to remove the menu entry |

On Linux the AppImage registers itself on first run (my call): it writes a `.desktop` entry and icon under `~/.local/share`, so Horde appears in the app grid and can be pinned, and rewrites the path at every start so a moved file keeps working (the autostart entry follows the same way).

The install guide shows the first-open step for each OS with screenshots. The per-OS code lives in one small module of the shell (`platform.ts`), so the differences are in one place.

### Release pipeline

```
tag vX.Y.Z
  └─ preflight   tag on main · CHANGELOG section · CI, Image and Desktop green on this commit
       └─ desktop   matrix: windows, macos, linux  → build, smoke, upload artifacts
            └─ image     build and push amd64 + arm64 (as today)
                 └─ publish   draft release → upload every asset → verify the list → publish
```

- **`desktop-build.yml`** is a reusable workflow that takes a version and produces one OS's artifact. The new **Desktop** workflow calls it on pull requests and `main` (a required check, like Image), and **Release** calls it on a tag. One definition, so what ships was tested.
- **Version.** The tag is the only source. The build passes it to electron-builder and to the server (`HORDE_VERSION`); nothing is committed. Outside a tag the version is `0.0.0-dev+<sha>`.
- **Fixed asset names**, without the version, so the docs can link to `releases/latest/download/<name>` and never change: `Horde-windows-x64-setup.exe`, `Horde-mac-arm64.dmg`, `Horde-mac-arm64.zip`, `Horde-linux-x64.AppImage`, the updater's `latest*.yml` and blockmaps, and `SHA256SUMS`.
- **All or nothing.** The release is created as a draft, every asset uploaded, the asset list compared with the expected list by a script, and only then published. The updater and the download links only ever see a complete release. If a desktop leg fails, the image is not pushed either; re-running the failed job on the same tag is safe.
- **Provenance.** Every artifact gets a GitHub build attestation.
- **Signing later.** Signing steps exist in `desktop-build.yml` and are skipped when their secrets are absent. Turning signing on is adding secrets and removing the "preview" wording.
- **Third-party bumps.** Electron and npm packages through Dependabot (grouped minor and patch merge automatically once Desktop is green; majors wait for review). `vendor.lock.json` is bumped by hand at first; `scripts/check.sh` gains a check that it agrees with the Dockerfile's deno pin.

The release process for the maintainer stays the same three steps: CHANGELOG, tag, push.

### What is tested where

- **`scripts/check.sh`** gains lint, format and type checks for `desktop/`. Packaging does not run locally.
- **Backend on three OSes.** The Desktop workflow runs the backend test suite on Windows and macOS as well as Linux. This is where most of the unknown work is (see Risks).
- **Packaged smoke test**, per OS, on the built artifact: the bundled Python starts the server on a temporary data folder; `/api/ping`, `/api/health`, `/` and `/wiki/` answer; bundled ffmpeg, ffprobe and deno run and report the pinned versions; then Playwright launches the packaged Electron app, sees the create-admin page, plays a few seconds of one seeded AV1, VP9 and H.264 file each, quits, and no server process is left behind.
- **Upgrade smoke test**, on release tags once a previous desktop release exists: the previous release's app creates a data folder, the new build starts on it and reports healthy.
- **Shell unit tests** for the pieces with logic: restart limits, port choice, update state mapping to the ADR 0011 files.

### Security

- The window has no Node access: context isolation and the sandbox on, no preload on Horde's pages. Navigation is limited to Horde's own address; any other link opens in the default browser, `http` and `https` only. Permission requests are denied except what the player needs (fullscreen, picture-in-picture, clipboard write).
- The first-run welcome step, if built as a page, is a local file with its own tiny preload, never shared with Horde's pages.
- The server listens on loopback unless the person turns sharing on, and sharing needs an existing admin account.
- Updates are fetched over HTTPS from the project's GitHub Releases and checked against the SHA-512 in the release's update file. Unsigned, that is the whole chain; signing later adds the publisher check. electron-builder 27 adds a signature on the update file that needs no paid certificate; moving to it once it is stable is a planned follow-up, not part of this work.
- Everything bundled is pinned by hash and attested.
- The shell change and the lifeline are reviewed independently before merge (new process control, an updater, and network exposure).

### Backend changes

Kept small, each with a test:

- `app/desktop_entry.py` (lifeline, in-process uvicorn).
- `below_playback`: Windows form.
- Whatever the Windows and macOS test runs show (paths, file locking, process groups). Fixes go in as their own commits.
- Hardware encoder detection on Windows and macOS is not extended now; without it Horde uses software encoding for compatibility copies, as on a Pi.
- `HORDE_RUNTIME=desktop` is reported by `/api/health` for signed-in admins beside the version, for bug reports. It does not switch behaviour.

### Docs and records

- New ADR: "Desktop apps: an Electron shell around the same server", listed in `docs/adr/index.md` and `mkdocs.yml`.
- New `docs/getting-started/install-desktop.md`; `other-platforms.md` points Windows and macOS readers to it first.
- `docs/development/release-process.md`, `docs/development/dependencies.md`, `docs/ops/security.md`, `docs/getting-started/updating.md`, `README.md`, `CHANGELOG.md`.
- `PRODUCT.md`: Platform and Operating Context gain the desktop app and its user (someone running Horde on their own computer).

## Phases

Each phase ends in something that works and is merged. Nothing reaches users until Phase 4.

The three platforms are independent from Phase 3 on (my call): each ships when its own checks are green, and one that fails its spike or its checks is left out of the matrix and the docs until it passes, without holding the others. Windows comes first. Phases 0 and 1 are planned in detail now; Phases 2 to 5 are planned in detail once the spikes report.

0. **Spikes** (throwaway, on a branch, to remove the unknowns before planning in detail): a packaged Electron app with the bundled Python playing AV1, VP9 and H.264 on Windows and macOS; the backend test suite on Windows and macOS, to size the fixes; an unsigned Windows update from a test release; what an unsigned, ad-hoc-signed Mac app shows on first open and whether start at sign-in works; whether the jellyfin-ffmpeg 7 portable archives exist for all three targets and include ffprobe; the YouTube helper run by the bundled deno; whether Cast works in the window.
1. **Server on three OSes.** Universal lock, backend tests green on Windows and macOS in CI, `desktop_entry`, low priority on Windows.
2. **The shell.** Window, tray, lifeline, single instance, first run, start at sign-in, logs, the minimal status file, local-only and Share on my home network, and the desktop wording in the web UI.
3. **Packaging.** `vendor.lock.json`, fetch and assemble scripts, electron-builder config, `desktop-build.yml`, the Desktop workflow with the packaged smoke test.
4. **Releases and updates.** Release workflow restructure, draft-then-publish, attestations, auto-update, "Update now", the failed-start screen, install docs, the ADR. First desktop build goes out on a pre-release tag (`-rc.1`), then with a stable release.
5. **Good citizen.** Tray status line, Pause background work, wait on battery, and the YouTube helper started by the shell with the bundled deno on a loopback port, if the spike worked.
6. **Signing**, when the owner decides: secrets, notarization, macOS auto-update, drop "preview".

## Risks

- **The server on Windows.** Never run under tests there. Long paths (`Channel/Year/Title [id].ext` can pass 260 characters), characters Windows forbids in names, deleting or renaming files that are open, and SQLite file locking are the likely sources. Phase 0 sizes this before any promise is made.
- **Unsigned first impressions.** The warnings will stop some people. The install page has to show the exact clicks. This is accepted for now.
- **Antivirus.** An unsigned installer carrying `python.exe`, `ffmpeg.exe` and `deno.exe` may be flagged. Mitigation is submitting false-positive reports per release until signing.
- **YouTube without the helper.** Until Phase 5, desktop installs behave like a Docker install without `bgutil-pot`. The UI already explains the bot-check error; the install page says so.
- **Electron upkeep.** A supported Electron major has to be kept. Dependabot and the packaged player smoke test make it a review, not a project.
- **Installer size**, roughly 300 MB. Updates on Windows fetch only changed blocks.
- **GNOME has no tray by default.** Relaunching opens the window, and the window's own menu has Quit, so nothing depends on the tray.

## Left to the builder

- The shell's internal module layout and the exact electron-builder configuration.
- Whether the welcome step is native dialogs or a local page.
- The exact form of the status file and pause commands (Phase 5), within the constraint above.
- How the upgrade smoke test obtains the previous release.
- Whether backend tests on Windows and macOS run the whole suite or mark a small, justified set as Linux-only (each with a reason; nothing skipped silently).
- Icon sizes and installer artwork, from the existing `horde-icon`.

## Decided by the owner

- **The window:** Electron.
- **Signing:** none for now; the pipeline is ready for it.
- **Bundled programs:** the GPL build of ffmpeg, the same flavour as the image, shipped as a separate unmodified program with its licence and a link to its source. The same holds for the GPL-3.0 YouTube helper in Phase 5.
- **Updates:** install by themselves when Horde is idle, as defined under Updates.
- **Hands-on testing:** the owner has a Windows PC, an Apple-silicon Mac and a Linux desktop. First-open steps, the tray, start at sign-in and the install-guide screenshots are checked by hand on each before that platform's first release; a short checklist for this goes in the release-process doc.

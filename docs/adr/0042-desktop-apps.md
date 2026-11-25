# 0042: Desktop apps: an Electron shell around the same server

Status: Accepted

## Context

Horde is installed with Docker, a terminal and a `.env` file. That keeps out people who would use it but have never seen Docker. They want to download one file, double-click it, and find "Horde" in the Start menu.

The server is one Python process with plain dependencies and already runs natively on Windows for development. What stood in the way:

- `backend/requirements.lock` was resolved for Linux only.
- Tests and CI ran on Linux only, so nothing proved the server on Windows or macOS.
- The Docker default listens on every network address, and the first visit creates the admin account. That is fine on a home server and a takeover risk on a laptop on shared Wi-Fi.
- "Update now" works through files in the data folder ([0011](0011-in-app-updates.md)) and a forgotten password is recovered from the server log ([0012](0012-password-reset-through-the-server-log.md)), so a desktop app has to take part in both.
- There is no signing budget, so installers are unsigned.

## Decision

- **An Electron shell around the same server.** `desktop/` is a small main-process program: a window, a tray icon, start at sign-in, starting and stopping the server, updates. It has no renderer code of its own. Everything else stays in the server and the existing web UI, so the desktop app and the Docker install are one product. Electron gives the same Chromium on Windows, macOS and Linux (the engine the Playwright suite already runs), so the player behaves the same everywhere, and one toolchain (electron-builder) produces an NSIS installer, a dmg and an AppImage and publishes updates to GitHub Releases.
- **A real Python, not a frozen one.** The installer carries a [python-build-standalone](https://github.com/astral-sh/python-build-standalone) 3.14 with `backend/requirements.lock` installed into it. The server runs the way it does in the image and in development: same interpreter, same lock, real tracebacks, Alembic and data files found by ordinary paths. `requirements.lock` is now a universal lock so one file resolves on all three systems; the image still installs it with `--require-hashes`.
- **A lifeline pipe.** The shell starts `app.desktop_entry` as a child and keeps its standard input open. When the pipe closes, for any reason including a crashed shell, the server shuts down gracefully. That is the stop signal on every system (a windowless Windows child has no SIGTERM) and it prevents an orphaned server. Quit closes the pipe, waits up to 40 seconds (what Compose gives the container), then ends the process tree. A server that crashes is restarted at most three times in five minutes, then the shell shows an error with "Open logs".
- **A status file and the files of 0011, not a new API.** The server writes what is running (downloads, ffmpeg jobs, AI work, live recordings, when a video was last served) to a file under the data folder. The shell reads it for the tray's status line, for the question before Quit, and to decide when Horde is idle. On Windows and Linux the shell plays the part of the host watcher of 0011: it stamps `watcher.env`, picks up `request.env`, installs the update and writes `status.env`, so "Update now" works unchanged. No new unauthenticated HTTP route exists.
- **Loopback by default.** The server binds `127.0.0.1` on port 8686. "Share on my home network" in the tray is off by default, needs an existing admin account, explains itself, restarts the server on `0.0.0.0` and shows the address.
- **The YouTube helper comes with it.** The Docker install runs `bgutil-ytdlp-pot-provider` as a second container. The desktop app carries the same helper at the same version, with its npm dependencies installed at build time, and the shell starts it with the bundled deno on a loopback port and passes the address to the server as `YTDLP_POT_BASE_URL`. It ends with the app through the same kind of lifeline as the server. If it will not start, Horde runs without it.
- **A pinned vendor manifest.** `desktop/vendor.lock.json` pins Python, jellyfin-ffmpeg 7 (the same flavour and major as the image), deno and the YouTube helper's source, each with a URL and SHA-256 for every target. The helper's version must equal its yt-dlp plugin's in `backend/requirements.txt`. `scripts/check_vendor_lock.py` is a gate: the file must be complete and its deno version must equal the Dockerfile's. Nothing bundled is fetched without a hash check.
- **One release workflow, a draft first.** `desktop-build.yml` is a reusable workflow that builds one system's installer and starts it. The Desktop workflow calls it on pull requests and `main`; Release calls it on a tag. Release runs `preflight → desktop → image → publish`. Publish creates a draft release, uploads every file, runs `scripts/check_release_assets.py` against the fixed list, attests the files and only then publishes. The image is not pushed unless every installer passed, and the updater and the download links only ever see a complete release. The version comes from the tag; nothing about it is committed.
- **Fixed asset names.** `Horde-windows-x64-setup.exe`, `Horde-mac-arm64.dmg`, `Horde-mac-arm64.zip` and `Horde-linux-x64.AppImage` carry no version, so the docs link to `releases/latest/download/<name>` and the links never change.
- **Unsigned for now.** Windows shows SmartScreen, macOS needs Open Anyway, Linux needs the file marked executable. Windows and Linux update themselves; unsigned macOS only says a new version exists, so it is labelled a preview. The macOS app and its bundled programs carry a free ad-hoc signature, which Apple silicon needs to run them at all. The signing steps are in `desktop-build.yml` and are skipped when their secrets are absent, so switching signing on later is adding secrets ([release process](../development/release-process.md#switching-on-signing-later)).
- **electron-builder stays on major 26.** Version 26 updates an unsigned Windows app on the SHA-512 in the release's update file. Version 27 refuses unsigned updates by default, so the move is made on purpose, not by Dependabot.

The builds are Windows x64 (a per-user installer, no administrator prompt), macOS Apple silicon and Linux x64 (an AppImage on the static runtime, so no FUSE is needed). How people install them is on the [install page](../getting-started/install-desktop.md).

## Rejected

- **A tray icon and the person's browser.** The least to maintain, and Chromecast would work. But the pinned icon opens a browser tab that gets lost, and playback depends on a browser nobody chose (Safari on most Macs).
- **A system webview (Tauri, pywebview).** A small download and a real window, but Safari's engine on a Mac and WebKitGTK on Linux run the player, which are its weakest playback paths, and keeping a bundled Python process alive and replaceable is a known problem there.
- **Freezing Python with PyInstaller.** It needs hooks per package, changes how imports and data files resolve, and is a usual source of antivirus false positives. A second way to run the server is a second way for it to break.
- **A separate desktop release workflow triggered by the tag.** The image and the installers could succeed or fail on their own, so half a release could ship, and what ships would not be what a pull request tested.
- **Automatic rollback of a failed desktop update.** It means reinstalling the old program and restoring the database unattended, the riskiest part of `update.sh`, with nothing like it in the desktop updater. The shell instead shows "Horde X could not start" with "Open logs" and a link to the previous version, and the server backs up the database before a migration as always. The guard is earlier: every build is started on a data folder made by the newest published release (`desktop/scripts/upgrade_smoke.py`) before it can be packaged.

## Consequences

- Horde can be installed by someone who has never opened a terminal, and "Horde" shows up in the Start menu, Launchpad or app grid.
- Electron has to be kept on a supported major, about one every eight weeks. Dependabot and the packaged-app test make that a review, not a project.
- The installer is about 300 MB because it carries Chromium, Python and ffmpeg. Windows updates fetch only the changed blocks.
- Until signing is set up, people see warnings on first open and some will stop there. The install page gives the exact clicks. Antivirus may flag an unsigned installer that contains `python.exe`, `ffmpeg.exe` and `deno.exe`; false-positive reports are the only remedy for now.
- The backend is now tested on three systems (the Desktop workflow runs the suite on Windows and macOS as well as Linux), which will find Windows-shaped problems (long paths, forbidden characters, open files) that Linux never showed.
- Releases take longer: the image waits for three installers to build and start. A failed desktop job stops the release and is fixed by re-running that job on the same tag.
- macOS is a preview: no automatic updates, and a manual Open Anyway step.
- Not built yet: the tray's "Pause background work", waiting on battery, code signing, automatic rollback, Intel Mac and Windows on ARM builds, moving the media folder from the app, and Chromecast inside the app window ("Open in browser" covers it).

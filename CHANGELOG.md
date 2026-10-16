# Changelog

All notable changes to Horde are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release steps are in
[docs/development/release-process.md](docs/development/release-process.md).

## [Unreleased]

This section summarizes the architecture and operations overhaul at a high
level. Detailed per-area entries are added by the maintainer at release time.

### Upgrade notes

- **Behind a reverse proxy or tunnel, list the public hostname in
  `HORDE_ALLOWED_HOSTS`.** Horde now only answers LAN-style `Host` names
  (`localhost`, private and Tailscale addresses, single-word names, `*.local`,
  `*.lan`, `*.home.arpa`, `*.internal`, `*.ts.net`). A name such as
  `horde.example.com` gets HTTP 400 `host_not_allowed` in the browser until you
  add it, for example `HORDE_ALLOWED_HOSTS=horde.example.com` in `.env`. With
  `HORDE_TRUST_PROXY=1` and no allowed hosts, Horde logs a warning at startup.
  See [docs/ops/security.md](docs/ops/security.md).
- **Scripts and direct API callers need a session and a header.** Every `/api`
  call now requires a signed-in session (the `horde_session` cookie from
  `POST /api/auth/login`), and every `POST`, `PUT`, `PATCH` and `DELETE` must send
  `X-Horde-Request: 1`. Anonymous calls get 401 `auth_required`; a missing header
  gets 403. Only `GET /api/ping`, `GET /api/ready`, `GET /api/auth/state` and
  `GET /api/health` (a bare status for anonymous callers, the full payload when
  signed in) stay open, plus the sign-in and first-run setup calls. See [docs/ops/authentication.md](docs/ops/authentication.md).

- **Horde now has accounts.** The first visit after upgrading asks you to create
  the administrator account; until you do, nothing else can be used. Your
  existing watch history, continue-watching positions, saved look and layout and
  AI chat history move to that account (the other server settings are
  unchanged). Add everyone else under *Settings → Users*; each person then has
  their own history, chats and preferences, while the library, playlists, tags,
  notes, AI summaries and downloads stay shared. Members can be given
  permissions (delete videos, download, save for offline, edit details, manage
  playlists, use AI); by default only admins can delete. Lost the password:
  `docker exec -it horde python -m app.cli reset-password <user>`. Behind an
  authenticating reverse proxy see `HORDE_AUTH_DISABLED` in
  [docs/ops/authentication.md](docs/ops/authentication.md). Migrations `0003_auth`
  and `0004_permissions_chat` run automatically (a database backup is taken
  first); they cannot be reversed, so keep that backup if you may roll back. The
  legacy `videos.last_position_sec` / `last_watched_at` columns remain in the
  database, unused, until a later cleanup.

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

- **API changes for anything calling the HTTP API directly** (the web UI is
  already updated): `GET /api/videos`, `GET /api/review` and
  `GET /api/review/groups` return `{items, next_cursor, total?}` pages instead of
  a bare list, and every error body is `{detail, code, ...}` with `detail` always a
  string (duplicate-download and link-reading errors no longer nest an object in
  `detail`; read `code` and `extra.error_kind`). See
  [docs/architecture/api-overview.md](docs/architecture/api-overview.md).

### Added

- Accounts: sign-in, an admin plus members with per-account permissions, per-user
  watch history, AI chat and UI preferences, signed media URLs for Chromecast and
  AirPlay, and a recovery CLI (`python -m app.cli`).
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
- Tests: a Playwright check loads every custom CSS sanitizer vector and 3000
  generated inputs, cleaned by both the web app's and the server's sanitizer,
  in Chromium and fails if any of them makes the browser contact another host
  (`frontend/e2e/custom-css-network.spec.ts`).

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

- Watch progress queued on a device while the server was unreachable no longer
  rewinds a video you have since watched further on another device: the save
  carries the time it was made (`watched_at` on `PATCH /api/videos/{id}/progress`)
  and the server keeps whichever position is newer.
- `docker-compose.yml` now passes every runtime setting `.env.example` documents
  into the container (the proxy and sign-in switches, `OPENROUTER_API_KEY`, the
  yt-dlp queue limits and `HORDE_TEMP_SWEEP_HOURS` were silently ignored); a test
  keeps the two in step.
- Rolling back to the pre-accounts release and upgrading again no longer leaves
  stray rows: every start checks foreign keys and repairs rows an older version
  orphaned (it deleted with foreign key enforcement off), drops the legacy
  `video_ai_chat` table it recreates, and the tag list only shows tags of
  existing videos. Migration `0006_video_tags_delete` adds a trigger that
  clears a deleted video's tags on any connection.
- That repair now backs the database up first
  (`DATA_DIR/backups/horde-pre-integrity-repair-*.db`) when the database is
  already at the latest schema and there is something to repair; before, only a
  pending migration took a copy. A clean start still writes nothing, and the
  five newest migration copies are kept by age rather than by name.
- Custom CSS saved before the sanitizer existed is now cleaned too: once at
  startup in `app_settings.json` (only rewritten when something changes) and
  when the first administrator adopts the old look, so an `@import` or remote
  `url()` from an old install is never applied.
- Security: the custom CSS sanitizer now reads `url(...)` the way browsers do.
  A quote, apostrophe or `/*` inside an unquoted `url()`, a carriage return or
  form feed inside a string, or a `var()`/`attr()` inside `image-set()` could
  hide a remote URL from it, so a saved stylesheet could still load
  `https://...` resources. Malformed `url()` values are now replaced by `none`.
- Security: sanitizing custom CSS twice now gives the same result as once.
  Removing an `@import` could join the text on either side into a new `url()`
  (`u@import "x";rl(https://...)` became `url(https://...)`), which the app
  then applied because it sanitizes only once when it starts. The removed rule
  now leaves an empty comment `/**/` where the two sides would otherwise merge.
- The startup clean-up of stored custom CSS no longer copies the old CSS into
  `app_settings.json.bak`, and cleans a `.bak` an earlier start left behind, so
  restoring a corrupt settings file from its backup cannot bring the CSS back.
- Unknown API paths spelled with a doubled slash or another case (`//api/x`,
  `/API/x`) now get the JSON 404 instead of the web app's page.
- The bare `/api` path, also when percent-encoded (`/%61pi`), now reaches the
  server's JSON 404 instead of the offline app shell.
- Progress saved offline is no longer recorded under the wrong account when
  another tab signs someone else in during the sync: the signed-in account is
  checked before every save is sent, the sync stops when it changes, and the
  new account's saves are then synced without waiting for the next trigger.
- One offline progress save that the server keeps rejecting no longer blocks the
  ones queued after it. A deleted video (404) or a save the server refuses
  (422) is dropped; a server error (5xx) keeps that save and carries on; a
  sign-in problem (401, 403) or no connection still stops the sync.
- Metadata sync logs one warning line per video when the source is unreachable
  (no network, proxy down) instead of a full traceback; the traceback is logged
  at DEBUG.
- Members no longer see the AI setup in `GET /api/ai/status` (provider type,
  schedule, workload profile, GPU tier and source, OpenRouter reachability) or
  the `openrouter` block of `GET /api/health`.
- Members no longer see server internals elsewhere either: video reads replace
  the raw embedding and H.264-copy errors (which quoted the provider URL or a
  file path) with a generic message and drop the summary model and cost;
  `GET /api/system/activity` drops each task's engine, detail and error;
  `GET /api/system/stats` drops the GPU name, VRAM and ffmpeg path; and
  `GET /api/health` drops the PO token provider address and the text, target and
  URL of the last failed YouTube extract. Administrators still get everything.
- Members no longer see more server internals: `GET /api/health` replaces the
  `storage_warning` (which named the data directory and its mount point) with a
  generic warning, `GET /api/channels/catalog/status` replaces a catalog's raw
  yt-dlp `last_error` with "Indexing failed", and a channel feed that cannot
  load answers every caller with a fixed message and the code
  `channel_feed_unavailable` instead of quoting the exception (the full error is
  logged). Administrators still see the catalog and storage text.
- The start-up integrity repair only backs up the database when it can repair
  something (an orphan under `ON DELETE CASCADE` or `SET NULL`, or the legacy
  table). A violation it leaves alone no longer writes a backup on every start
  and rotates the real pre-migration backups out.
- A search sorted by last watched now reflects what you just watched; that sort
  is no longer served from the two-minute ranking cache.
- `scripts/check.sh` and CI fail when `backend/requirements.lock` (what the
  image installs) no longer satisfies `backend/requirements.txt`, so a
  dependency bump cannot pass review without a regenerated lock.
- Known advisories in FastAPI/Starlette/python-multipart and in the frontend
  build toolchain.
- Documentation now states that `DATA_PATH` must be a local disk (SQLite WAL is
  unsafe on SMB/NFS) and warns about the TrueNAS example paths on other hosts.

### Removed

- The committed `backend/static` build output and the empty root
  `package-lock.json`.

[Unreleased]: https://github.com/jm-connell/horde/commits/main

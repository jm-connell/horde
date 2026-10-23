# Changelog

All notable changes to Horde are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release steps are in
[docs/development/release-process.md](docs/development/release-process.md).

## [Unreleased]

### Added

- **Max disk usage** in Settings → System → Storage: an optional limit (in GB)
  on the library's size, with a usage bar that turns amber from 90 %. Downloads,
  channel auto-downloads and playlist syncs wait while the library is at the
  limit or a video would not fit under it, and start again by themselves when
  space is freed or the limit is raised. A download that already started
  finishes, so the library can pass the limit by about one video per download
  slot. Offline (this device) downloads only check the free-space floor.
- Downloads also wait while the disk has less than `HORDE_MIN_FREE_GB` free
  (default 2 GB; `0` turns it off), whatever the limit says.
- Waiting downloads say why on their card ("Paused: library is at its 55 GB
  limit"), the Download page shows a banner above the queue, and
  `GET /api/health` reports `status: "warning"` with `downloads.held_reason`.
- **Trash.** Deleting a video (with its file) now moves it to a trash for 7 days
  instead of erasing it: it leaves the library, search and playlists at once,
  and can be restored with its tags, playlist places, watch progress and AI
  results, or erased early (one video or **Empty trash**). The API lists the
  trash with sizes and expiry (`/api/trash`), and the delete responses carry
  the entry id so a client can offer **Undo**. `HORDE_TRASH_DAYS` sets the
  number of days; `0` turns the trash off. Trashed videos still count toward
  the size limit. See [Library](docs/guides/library.md#trash).

### Changed

- A download that hits "no space left on device" now fails with its own kind
  (`disk_full`) and a clear message, stops trying other formats, and holds the
  queue instead of failing every following download the same way.
- `update.sh` accepts a `warning` health status, so an update is not rolled back
  because downloads are waiting for disk space.

### Fixed

- Channel auto-download no longer fetches a video again after you deleted it. It
  used to re-queue any channel upload that was not in the library, so a deleted
  video came back with the next channel update. Deleting a downloaded video now
  makes auto-download skip it for good; the video stays in the channel feed as
  "not downloaded" and downloading it by hand (or restoring it from the trash)
  lifts the skip.

### Upgrade notes

- Database migration `0010_trash` adds the `trash_entries` table. It only adds a
  table, so no existing data is touched; Horde backs the database up first, as
  for every migration. Rolling back to 1.0.x needs `update.sh --rollback` or a
  restored backup (the older version refuses a database it does not know).
- Deleting a video with its file no longer frees the disk straight away: the
  files wait in `downloads/.horde-trash` (and `data/trash`) for 7 days. Set
  `HORDE_TRASH_DAYS=0` to keep the old immediate behaviour.
- Keep `.horde-trash` on the same filesystem as the videos (it is, unless a
  channel folder is a separate mount): a video is moved there by renaming, never
  by copying, and a delete that would need a copy is refused with a clear error.

## [1.0.3] - 2026-10-21

### Changed

- Recommendations and category shelves are rebuilt on whole-video profiles
  (title/description plus a share of the captions) instead of a single best
  caption chunk, so one caption passage that happens to match no longer pulls
  in an unrelated video.
- **For you** is tuned to the viewer: seeded from the 30 most recent watches,
  weighted by recency and by how much of each was watched, mixing channels
  instead of filling the shelf from one, boosting followed channels, and
  moving already-watched videos to the end so infinite scroll still pages
  through the whole library.
- **Category shelves** are grounded in real examples: the chat model names
  sample videos for each category, unbacked proposals are dropped, and a
  video joins a shelf only when the category is among its best matches.
- **More like this** re-ranks one fixed nearest-neighbour pool on every page
  (pages continue a single ranking), nudged by same channel, shared tags
  (rare tags count more) and −0.05 for videos the viewer has watched.
- Tag enrichment reuses the library's most used tags with their exact
  spelling, so tag chips and the related-videos tag boost stay consistent.
- Embedding-profile matrices rebuild only changed videos' profiles.

### Security

- Pillow is now 13.0, which fixes out-of-bounds reads, decompression bomb
  bypasses and other flaws in its image decoders (CVE-2026-112395,
  CVE-2026-112397, CVE-2026-112400, CVE-2026-112404, CVE-2026-112895,
  CVE-2026-112896, CVE-2026-112897, CVE-2026-112899). Horde decodes uploaded
  backgrounds and avatars and downloaded thumbnails with Pillow.

## [1.0.2] - 2026-10-20

### Upgrade notes

- **Building from source now needs Python 3.14 and Node 24.** The image,
  CI and docs all moved from Python 3.12 and Node 22 to Python 3.14 and Node
  24 LTS. The Docker image needs no action: `docker compose pull && docker
  compose up -d` picks it up.
- The database gains a column for profile pictures (migration
  `0009_user_avatars`, a plain `ADD COLUMN`). It runs on its own at startup.
  Pictures are stored under `DATA_DIR/avatars/`.

### Added

- Profile pictures. Everyone can set a picture for their own account; it is
  shown next to their name.
- A "Forgot password?" link on the sign-in page. It writes a one-time code to
  the server log (`docker logs horde`); the code and a new password reset the
  account. Codes last 15 minutes and allow 5 wrong guesses. See
  [docs/ops/authentication.md](docs/ops/authentication.md).
- Videos that are not downloaded yet can be queued: "+ Queue" appears on the
  watch page's related videos and on channel feed and search cards.
- An opt-in setting, "Autoplay the next part", plays the channel's next upload
  when it clearly continues the series you just finished, downloaded or not.
- Channel pages show a live broadcast first, with a LIVE badge, and have a
  Videos / Live switch that lists the channel's past streams. Downloading a
  past stream longer than 2 hours asks first and shows the estimated size.
- Desktop users can resize the watch page panels, and the AI chat input grows
  from the box edge.

### Changed

- React 19. Menus, dialogs and the player behave the same; report anything
  that does not.
- Account settings moved to `/account`, and search moved into the navigation
  bar.
- In theater mode the video details sit centred under the player. On very
  wide screens with the related sidebar off, the AI panel and description sit
  side by side.
- The Recommended home tab hides the sort controls, and video cards and
  thumbnails fade in as pages load.
- The volume slider's level uses the accent colour, and the System tab's update
  banner is part of the Updates section.
- Opening the page of a YouTube channel you do not follow checks whether it is
  live: at most one YouTube `/live` page fetch per channel every 2 minutes,
  skipped when live checks are off or paused after a 429.

### Fixed

- Live streams that YouTube serves as separate audio and video (most
  broadcasts now) play again, with sound. They answered "This video is not
  live right now". Seeking back in the DVR window keeps audio and video in
  step.
- The Vite dev proxy keeps the browser's `Host` header, so the dev server no
  longer fails the CSRF origin check.

### Security

- YouTube URLs are matched by exact host (`youtube.com`, `*.youtube.com`,
  `youtu.be`), so hosts such as `notyoutube.com` or
  `youtube.com.evil.example` are no longer treated as YouTube.
- The Ollama and OpenRouter connection tests no longer return raw exception
  text, which could include internal URLs or upstream responses. They give a
  short reason and log the details.
- certifi is now 2026.10.19
  ([GHSA-6q48-6c7w-9gw2](https://github.com/advisories/GHSA-6q48-6c7w-9gw2)).

## [1.0.1] - 2026-10-18

### Changed

- The frontend is built with Tailwind CSS 4 through its Vite plugin; PostCSS
  and Autoprefixer are no longer used. The interface looks the same: colors,
  line heights, button cursors and spacing keep their Tailwind 3 values. Date
  and time fields are 2px shorter and now match the text fields beside them.
  The interface now needs Safari / iOS 16.4, Chrome or Edge 111, or Firefox 128
  or newer; older browsers draw translucent panels and overlays as solid fills.

### Fixed

- The H.264 compatibility copy of a YouTube video could be YouTube's default
  best stream (often 4K VP9 or AV1) instead of its 1080p H.264 stream, so
  devices that needed the copy, such as an M1 iPad with an AV1 video, still
  could not play it. Copies are now checked after download and encoded locally
  when they are not H.264. Bad copies saved earlier are removed at startup, so
  the player offers to make them again. The progress bar no longer runs to 99%
  twice while the copy downloads.

### Security

- React Router is now 7.18, which fixes open redirects through crafted
  navigation paths ([GHSA-jjmj-jmhj-qwj2](https://github.com/advisories/GHSA-jjmj-jmhj-qwj2),
  [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6)) and
  an SSR hydration flaw Horde was not exposed to
  ([GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg)).
- The frontend now builds with Tailwind CSS 4, which drops the build-time
  packages behind two advisories: postcss-selector-parser
  ([GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf))
  and braces through chokidar and micromatch
  ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
  no patched release). Both only read Horde's own source at build time.

## [1.0.0] - 2026-10-17

This section summarizes the architecture and operations overhaul at a high
level. Detailed per-area entries are added by the maintainer at release time.

### Upgrade notes

- **The bgutil POT sidecar is now 2.0.2**, which fixes a remote code execution
  flaw ([GHSA-qpv9-8xfj-xx9m](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/security/advisories/GHSA-qpv9-8xfj-xx9m)).
  `docker compose pull && docker compose up -d` picks it up. The bundled
  Compose setup needs no other change. If you run the provider natively on
  another machine (a custom `YTDLP_POT_BASE_URL`), it now binds to localhost by
  default: start it with `--host 0.0.0.0` so Horde can reach it.
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

- Followed channels and live streams. Users follow channels automatically
  when a download they queued finishes, or by hand, including channels with no
  videos on the server. A quiet **Live** list in the sidebar shows followed
  channels that are live, with title and game. Live streams play through a
  server-side HLS proxy that refreshes YouTube's URLs on its own, with
  scrub-back up to `HORDE_LIVE_DVR_HOURS` (default 4). Per-user toggle under
  **Settings → Library → Show live streams**; `HORDE_LIVE_POLL_SEC=0` turns
  the server's live checks off. Migration `0007_channel_follows`. See
  [docs/design/live-streams.md](docs/design/live-streams.md).
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
- Streamed (not downloaded) videos get the AI panel (summary, chat, AI
  chapters) and related videos that mix library and indexed-channel videos,
  marked downloaded or not. Their AI results are saved, move onto the video when
  it is downloaded, and are deleted after `HORDE_STREAM_AI_RETENTION_DAYS`
  (default 30) days unopened.

### Changed

- The playback compatibility panel (Settings → Library) is for administrators
  only. Members could see and click it, but the server kept the server-wide
  codec anyway; now the panel is hidden from them, the API answers a member's
  change to `download_video_codec` or `compat_copy_resolution` with 403
  `admin_required` (echoing the current value is still accepted), and
  `GET /api/compat/summary` requires an administrator.
- Members no longer see server-wide controls they cannot use: progress expiry
  and the metadata and catalog section (Settings → Library), background and
  font uploads, deletes and palette extraction (Settings → Appearance), the
  download queue's Pause all / Resume all, the bulk metadata resync and the
  AI category refresh. The download preferences need the `download`
  permission, and the bulk bar's playlist, note and save-for-offline actions
  follow their permissions. `GET /api/settings` gives members the defaults of
  the catalog and metadata-interval fields, and the metadata resync progress
  (`GET /api/videos/refresh-metadata/status`) requires an administrator. See
  "What members can and can't change" in docs/ops/authentication.md.
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

- Watching on a Chromecast now saves your progress as it plays; before, it was
  only saved when the cast session ended, so other devices resumed from where
  casting started.
- Resume points follow your account across devices more closely: a paused
  player catches up with progress you made on another device when its tab or
  window comes back to the front, and expanding the mini-player no longer jumps
  back to the position saved a few seconds earlier.
- A playing video no longer jumps back a few seconds every time its details
  refresh (while subtitles, a summary, sprites or chapters are still being
  made): the refreshed copy carried the position saved a moment earlier, and
  the player sought back to it.
- Pausing, seeking, hiding the tab or closing the page now saves where you
  stopped. Saves were throttled to one every 5 seconds with nothing sent at the
  end of the window, so another device could resume up to 5 seconds early, or
  from an older place after a seek.
- Videos saved for offline viewing resume per account. A shared device used to
  keep one position per saved video, so it resumed wherever whoever played it
  last had stopped, and could ignore newer progress made on another device.
  Each account now has its own place in a saved video on the device; online the
  server's position (or a newer one this device could not send yet) wins. The
  old device-wide position has no owner and is dropped on upgrade.
- Watch progress queued on a device while the server was unreachable no longer
  rewinds a video you have since watched further on another device: the save
  carries the time it was made (`watched_at` on `PATCH /api/videos/{id}/progress`)
  and the server keeps whichever position is newer.
- A member promoted to administrator (or an admin demoted) in another browser
  now gets the new view in place: the page re-reads its data for the new role
  instead of showing the trimmed member copy of the settings (a promoted admin
  could see an empty Ollama address and save over the real one), an
  admin-only tab that is no longer allowed closes, and a refused request
  re-checks the account at once.
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

[Unreleased]: https://github.com/jm-connell/horde/compare/v1.0.3...main
[1.0.3]: https://github.com/jm-connell/horde/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/jm-connell/horde/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jm-connell/horde/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jm-connell/horde/commits/v1.0.0

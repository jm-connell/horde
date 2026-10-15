# Horde — Architecture & Production-Readiness Review

Date: 2026-10-15. Scope: whole repo at `main` (a3aa8c4). The review was read-only. Most findings were checked against code. Findings marked **[V]** were also reproduced against a running instance or by executing the code.

## Overall verdict

Horde is large: about 31k lines of backend Python and 45k lines of TypeScript, with real features. It is better built in the small than most AI-generated codebases:
- Strict TypeScript with zero `any`.
- Real crash recovery for download jobs.
- Same-directory atomic renames for media.
- Good SQLite WAL defaults.
- A thoughtful service worker.
- 436 backend tests and decent docs.

The problems are systemic rather than local:

1. **Security model.** The "trusted LAN, no auth" model is broken by the browser. Any web page the user visits can call the API, read from it and wipe it.
2. **No architectural spine.** There are five ad-hoc job systems, about 60 module-level mutable singletons, two 400-line functions with radon complexity scores of 87, and 2,700-line UI components.
3. **No guardrails.** There is no linter, type-check or ESLint gate, logging is never configured, and there are no releases, rollback, published image or dependency bot.
4. **History.** About 92k lines landed in one "update wiki" commit, and 31 of 54 commits are a bot. History is effectively absent, so the codebase can't be bisected or blamed.

Every item below is fixable incrementally. Nothing requires a rewrite.

---

## P0: fix before anything else

### 1. Any website can wipe the library (Critical) [V]
Three behaviours chain together:
- `main.py:127` sets `CORSMiddleware(allow_origins=["*"])`. That header is attached to POST responses too.
- FastAPI 0.115.6 parses a JSON body when no `Content-Type` header is present. A cross-site `fetch(url,{method:'POST', body:new Blob([...])})` sends no Content-Type, so it is a CORS "simple request" and gets no preflight.
- There is no Host-header validation, so DNS rebinding also works.

Result: `POST /api/setup/reset {"erase_media":true}` runs `rmtree` on `DOWNLOADS_DIR` when called from any origin. This was verified. `bulk-delete`, `compat/convert-library` (in-place re-encode), download enqueue and the AI endpoints (spending OpenRouter credit) are equally reachable. Every GET is readable cross-origin, so any page can read the full library, watch history and download history.

**Fix (one middleware PR):**
- Add `TrustedHostMiddleware`, with `HORDE_ALLOWED_HOSTS` defaulting to private IPs and `*.local`.
- Reject non-GET requests unless `Content-Type: application/json` or a custom `X-Horde` header is present.
- Reject `Sec-Fetch-Site: cross-site` on non-GET requests.
- Scope CORS `*` to only the media and subtitle routes that Chromecast needs.
- Add CSP `frame-ancestors 'self'` and `nosniff`.
- Make factory reset require a typed confirmation token.

Longer term: add optional auth, either a single admin password or a trusted reverse-proxy header. "Do not port-forward" is not a security control.

### 2. Filename bug can delete unrelated videos (High) [V]
`services/downloader.py:234`, `_video_stem`, does `stem.rsplit(".f", 1)[0]` whenever `.f` appears anywhere in a title. For example, `Learn.fast tricks [id]` becomes `Learn`.

`_cleanup_download_artifacts(remove_final=True)` (line 1327) then deletes **every video in the folder whose name starts with that prefix** when a download fails the playability check. `_find_merged_video` can also pick another video as the result.

**Fix:** `re.sub(r"\.f\d+$", "", stem)`, and match on the exact `[id]` token. Add a regression test.

### 3. Settings can silently reset to factory defaults (High)
`services/app_settings.py`:
- `_write` uses `write_text`, which truncates the file and then writes it, so it is not atomic.
- `load()` is unlocked, polled constantly by workers and `/health`, and catches every exception by returning defaults with `setup_completed=False`.
- A read that lands mid-write sees defaults, and the UI drops the user into the Setup wizard.
- A crash mid-write corrupts the file, and the next `save()` persists defaults over it, losing the OpenRouter key.

**Fix:** write to a temp file, `fsync`, then `os.replace`; `chmod 600`; keep a `.bak`; and log loudly instead of falling back silently. Longer term: typed settings (pydantic-settings) stored in the DB.

### 4. Event loop blocked by yt-dlp (High)
`api/preview.py:353,470,499,527` and `api/review.py:65` are `async def` but call synchronous yt-dlp extraction. That extraction sits behind a global single-slot gate whose `waiter.wait()` has no timeout. It also calls ffprobe, PIL and the synchronous Session. One slow extraction stalls every request, including video streaming and SSE.

**Fix:** make them plain `def`, or use `anyio.to_thread`. Add timeouts to the gate.

### 5. Referential integrity is fictional (High)
- `PRAGMA foreign_keys=ON` is never set (`database.py:42`), so every `foreign_key=` is decorative.
- Deleting a video leaves orphan playlist items, embeddings, AI meta, chat history and AI jobs.
- IDs are not AUTOINCREMENT, so SQLite reuses the max id, and **orphans re-attach to the next new video**: wrong summary, wrong chat history, wrong playlist membership.

**Fix:**
- Turn on the pragma.
- Add `ondelete=CASCADE` or an explicit `delete_video_cascade()`.
- Add `sqlite_autoincrement`.
- Add a one-time orphan-cleanup migration.

### 6. Dependency CVEs on the request path
`python-multipart 0.0.20` has 6 advisories and `starlette 0.41.3` has 7 (pip-audit). Starlette is capped by `fastapi==0.115.6`, so FastAPI and uvicorn must be bumped together. Newer FastAPI also adds strict content-type checking, which helps with #1.

---

## Architecture themes (backend)

| Theme | Evidence | Recommendation |
|---|---|---|
| **God modules** | `downloader.py` is 2,726 lines with ~10 responsibilities. `_run_download` and `_complete_download` have complexity 87 each and maintainability index 0. 49 functions grade D or worse. 7 modules have MI 0.00. | Split into a `downloads/` package: `queue`, `runner`, `postprocess`, `finalize`, `jobs`, `playlist_import`, `progress`, `fsutil`. Replace 12-positional-arg handoffs with a dataclass. Cover each piece with characterization tests *before* moving it. |
| **Five bespoke job systems** | DB-backed (downloads, AI, catalog). In-memory only (job_metadata, compat, ffmpeg queue; lost on restart, and job_metadata is never rehydrated). Thread-per-item (sprites: thousands of blocked threads on bulk import). `while True` pollers. `_worker_loop` exists four times. | One `BackgroundWorker` base (stop/wake events, join, recover hook) and one DB-backed `jobs` table with a common state machine. A stuck-`downloading` reaper. Alternatively, adopt a light library (e.g. `huey` with the SQLite backend). |
| **No lifecycle management** | The lifespan never stops the download queue, metadata sync (`Event().wait(3600)` on a fresh Event is uninterruptible) or the scanner poller. Several `stop_*` set a flag and never join. Infinite SSE loops likely block uvicorn shutdown, so teardown never runs and work is SIGKILLed mid-write. Startup does a full synchronous library scan before serving. | A shutdown registry in the lifespan. An app-level shutdown event observed by SSE. `--timeout-graceful-shutdown`. Move the initial scan to the background. |
| **Global state and import-time config** | ~62 module-level mutable containers and 32 `global` statements. `engine` and paths are frozen at import, with 113 `Session(engine)` call sites. `conftest.py` must reflectively patch every module, which is why one sprite test is order-dependent and fails in the full run. | An `AppContext` built in the lifespan (settings, engine, paths, queues) and exposed via FastAPI `Depends` and accessor functions. Remove e2e branches from production code paths. |
| **Hand-rolled migrations** | Add-column only. Indexes declared after a table exists are never created on upgraded DBs, so fresh and upgraded schemas differ. No down migrations, no schema version, no guard against older code on a newer DB. Timestamps are stored as VARCHAR. | Adopt Alembic (`render_as_batch=True`) with a baseline at the current schema. First revision: missing indexes (`download_jobs.status`, `videos.source_url`, unique `(playlist_id, video_id)`), FKs, AUTOINCREMENT. |
| **Data modelling** | Tags, subtitles and chapters are stored as JSON in VARCHAR. Tag filtering uses `ilike('%"tag"%')`, which is unindexable and not LIKE-escaped. YouTube-id lookups fall back to a full-table Python scan on every enqueue. Embedding search is pure-Python cosine over all vectors. | A `video_tags` table. FTS5 for keyword search. A `youtube_id` column with an index. `sqlite-vec` or numpy for vectors once libraries pass a few thousand items. |
| **Transactions across I/O** | `_complete_download` holds a write transaction across ffprobe and file deletes. The replace path deletes the old media *before* commit, and `rename_video_file` moves files before commit. | Do I/O first, then a short transaction. Order deletes after a successful commit, or use staging and rename. |
| **Filesystem paths** | No byte-length truncation (`ENAMETOOLONG` with 4-byte UTF-8 titles plus suffixes). SMB-illegal trailing dots, spaces and reserved names are not handled. The folder uses `uploader` while the DB uses `channel_override`, so they drift. | `%(title).150B`, `windowsfilenames=True` for SMB users, and a staging dir with an atomic move into the library. |
| **API surface** | 128 operations, 47 without a response model. Three different error shapes. No pagination on `/api/videos`, `/review` or `/playlists`, and N+1 queries plus filesystem stats in `to_read`. State-changing GETs: the Safari `/stream` path re-encodes and deletes the original file. Duplicate routes exist. | Response models everywhere and one `{code, message, details}` error envelope. Cursor pagination. Batch-load AI meta. Move side effects to POST or background jobs. Optionally `/api/v1`. |
| **SSRF and input validation** | `thumbnail_url` fetches any URL, follows redirects and stores the raw body, which can be read back with CORS `*`. [V] `source_url` accepts `javascript:` and renders it into an `<a href>` (stored XSS). [V] yt-dlp preview endpoints accept internal URLs. | A shared URL validator (http(s) only, block private, loopback and link-local ranges after DNS resolution, re-check on each redirect). Re-encode uploaded images with PIL. Stream uploads with size caps. |

## Frontend

| Area | Finding | Recommendation |
|---|---|---|
| Resilience | There is no `ErrorBoundary`, so any render exception white-screens the app. There is no 404 route after setup. | Add both now (a few hours). |
| Data layer | Hand-rolled `fetch` + `useEffect`, with no cache. 18 `setInterval` pollers (1–30 s), most of which don't pause in background tabs. AI status is polled in two places. Downloads are polled even though an SSE stream exists. Only 7 files use AbortController, so stale responses can overwrite fresh ones. | TanStack Query, migrated page by page starting with the Settings pollers. SSE writes into the query cache. |
| API contract | `types.ts` (735 lines) is hand-maintained against `schemas.py`, so drift is guaranteed over time. 422 errors are shown as raw JSON. | `openapi-typescript` + `openapi-fetch` generated from `/openapi.json`, with a CI drift check. |
| Component size | `VideoPlayer` is 2,699 lines (31 useState, 29 useEffect, 35 useRef). `Library` has 51 useState. `Settings` keeps all tabs' state and 6 pollers in the parent, so every tick re-renders every tab. The `PlaybackContext` value is not memoized, so all consumers re-render on every change. | Extract `usePlayerKeyboard`, `ControlBar`, `useChapters`, `MiniPlayerFrame` and `useLibraryQuery`. Push tab state into each tab. Split playback state and actions contexts. |
| Tooling | **No ESLint or Prettier at all.** The 15 `eslint-disable exhaustive-deps` comments reference a rule that never runs. | ESLint (typescript-eslint, react-hooks as error, jsx-a11y) plus Prettier or Biome, enforced in CI. Fix the suppressions properly. |
| Performance | One 831 kB JS chunk. No `React.lazy` anywhere. No list virtualization. Only 5 of 18 `<img>` are lazy. | Lazy-load routes (Settings, Download, Import, AI panels). `@tanstack/react-virtual` for the grid. `loading="lazy"` with width and height on thumbnails. |
| Accessibility | Toasts have no `aria-live`. `ConfirmDialog` has no focus trap. `MenuFlyout` has no keyboard support. Player shortcuts are global character keys with no opt-out (WCAG 2.1.4). 263 `text-gray-500/600` usages on dark backgrounds, which is likely below AA contrast. | Use a headless primitive library (Radix or React Aria) for dialogs and menus. Add `@axe-core/playwright` to the e2e tests. |
| PWA | The new service worker calls `skipWaiting` and `claim` mid-session with no "update available" prompt. Old asset caches are deleted, so a long-lived tab that lazy-loads a chunk will 404. This becomes urgent once code-splitting lands. No quota-error handling. | An update toast plus `SKIP_WAITING` on user consent, or `vite-plugin-pwa`/Workbox. |
| Local storage | 21 keys across 18 files, with no versioning and hand-repeated try/catch. | One versioned `storage.ts` wrapper with validated reads and a migration list. |
| Tests | 303 unit tests, all on pure utilities. 10.6% line coverage, and no DOM or component tests. 23 Playwright tests, Chromium desktop only. | jsdom, Testing Library and MSW, backfilled as components are extracted. Add a mobile Playwright project. |

## Ops, release and supply chain

| Area | Finding | Recommendation |
|---|---|---|
| Releases | No tags, semver or changelog. The update checker compares against `commits/main`, and the clone-stats bot commits to `main` daily, so **every install reports "update available" every day** and users rebuild for a JSON change. | Tag semver releases, and have the checker and `update.sh` track the latest release. Move clone stats out of `main` (fetch at Pages build time, or use a separate branch). Turn on branch protection. |
| Distribution | Every user builds from source on a NAS. Base images are floating tags (`node:20-alpine`, `python:3.12-slim`, `ollama:latest`). The Dockerfile uses `npm install`, not `npm ci`. There is no Python lockfile and transitive dependencies float. jellyfin-ffmpeg silently falls back to Debian ffmpeg. | Publish multi-arch `ghcr.io/…/horde:vX.Y.Z` images from CI. Pin base images by digest. Use `npm ci`. Add a `pip-compile --generate-hashes` lockfile. Fail the build or report the ffmpeg flavour in `/health`. |
| Rollback | `update.sh` pulls, rebuilds `:latest` in place and doesn't revert on a failed health check. It doesn't back up the DB. | Tag images `horde:<sha>`, take a `VACUUM INTO` backup before `up`, roll back automatically on a failed health check, and add `--rollback`. |
| yt-dlp | Pinned, with no runtime update path. YouTube breakage means waiting on the maintainer and a full rebuild. | An opt-in runtime updater into a persisted volume, plus Renovate auto-PRs with smoke tests. |
| Container | No `HEALTHCHECK`. No resource limits or `no-new-privileges`. A recursive `chown` on every start. | Healthcheck on `/api/ping`, `mem_limit`/`pids_limit`, `cap_drop`, and `depends_on: service_healthy`. |
| Health and logging | `/api/health` claims to be cheap but forks `yt-dlp --version` and pings the POT sidecar on every call (polled every 2 s by `update.sh` and the UI). **Logging is never configured**: all app `INFO`/`DEBUG` output is dropped, and 195 `except Exception` blocks (about 50 of them bare `pass`) hide failures. There are no request or job correlation IDs. | Cache the version and POT status. Configure logging from a `HORDE_LOG_LEVEL` env var. Bind request and job IDs with contextvars. Replace silent passes with `logger.warning(exc_info=True)`. Optionally add Prometheus `/metrics`. |
| Durability | No warning that WAL on SMB/NFS is unsafe. No automated backup. | Check the filesystem type at startup and warn, and add a nightly `VACUUM INTO`. |
| CI gaps | No ruff, mypy, ESLint, pip-audit/npm audit, image scan, Dependabot/Renovate, image smoke test, or pip/buildx cache. Node is 20 in the Dockerfile but 22 in CI. Actions are pinned to tags, not SHAs. | Add all of these. Gate on *new* violations using a baseline so legacy debt doesn't block work. |
| Hygiene | A stale built bundle is committed in `backend/static`. There is an empty root `package-lock.json`. `ollama/` is missing from `.gitignore` and `.dockerignore`, so a multi-GB build context is possible. `tsconfig.tsbuildinfo` is tracked. | Clean these up. |

## Measured baseline

| Metric | Value |
|---|---|
| Backend tests | 435/436 pass. `test_sprites::…concurrent_update` fails only in the full suite (order-dependent) |
| Backend coverage | 57%. `ai/chat.py` 0%, `api/preview.py` 15%, `stream_preview.py` 21%, `downloader.py` 41% |
| Frontend tests | 303/303 pass. 10.6% line coverage, with no component tests |
| mypy | 194 errors in 33 files |
| ruff | 1,441 findings on defaults (1,251 auto-fixable); 492 on E/F/B/S/SIM/C90 |
| Complexity | 49 functions graded D or worse. Top: `channel_feed` 89, `_run_download` 87, `_complete_download` 87 |
| Bundle | 831 kB main chunk (245 kB gzip) + 468 kB Shaka |
| CVEs | Backend: 13 advisories (python-multipart, starlette). Frontend: 2 moderate in prod (react-router), 17 dev-only |
| Size | 30.8k lines backend, 44.8k lines frontend. Test-to-source ratio 0.30 backend, 0.10 frontend. 15 files over 1,000 lines |

## Roadmap

**Week 1: stop the bleeding (all small, high value)**
1. Security middleware (Host allowlist, content-type or custom-header requirement, origin check, scoped CORS, security headers). URL validation for `source_url`, `thumbnail_url` and Ollama `base_url`.
2. Fix `_video_stem` and the atomic settings write, each with a regression test.
3. Move blocking `async def` endpoints to `def`. Add timeouts to the extract gate.
4. Bump FastAPI, Starlette, uvicorn and python-multipart.
5. Frontend `ErrorBoundary`, 404 route and `aria-live` toasts.
6. Configure logging. Make `/health` cheap.

**Weeks 2–4: guardrails**
- ruff (with a baseline), mypy (with a baseline, ratcheting down), ESLint, Prettier, pip-audit, npm audit and Trivy in CI. Renovate. Align Node versions.
- Semver tags and a GHCR image. `update.sh` gets a DB backup and rollback. Move clone stats off `main`. Branch protection with required checks.
- Alembic baseline plus a first revision for FKs, cascades, AUTOINCREMENT, missing indexes and orphan cleanup.
- Fix the order-dependent sprite test by isolating global state.

**Months 2–3: structural**
- An `AppContext` / dependency container, a `BackgroundWorker` abstraction and a unified job table. A shutdown registry and a stuck-job reaper.
- Decompose `downloader.py` behind characterization tests.
- TanStack Query and generated OpenAPI client. Decompose `VideoPlayer`, `Library` and `Settings`. Route code-splitting with a PWA update prompt.
- Pagination, a tags table, FTS5 and vector indexing as the library grows.
- Optional authentication.

**Process:** small PRs with descriptive history. A `CONTRIBUTING`/`ARCHITECTURE.md` with ADRs for the job system, DB migrations and the security model. Because the code is largely AI-authored, the lint, type and test gates *are* the code review. Make them mandatory before adding more features.

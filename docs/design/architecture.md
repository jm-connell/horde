# Architecture map

One page that connects the pieces. Each section ends with a pointer to the page that has the detail; the reasoning behind the big choices is in the [decision records](../adr/index.md).

!!! note "Two changes still on their way"
    This page describes the code as it will be once two in-flight changes land: the download pipeline moved out of `services/downloader.py` into the `services/downloads/` package ([ADR 0006](../adr/0006-downloader-package-split.md)), and the SQL-side search indexes plus the incremental vector index ([ADR 0007](../adr/0007-fts5-triggers-and-vector-index.md)). Where a statement depends on one of them it says so.

## Process model

Horde is **one OS process**: a uvicorn server running one FastAPI app. There is no Celery, Redis or second service ([ADR 0002](../adr/0002-single-process-worker-threads.md)). The container runs `uvicorn app.main:app` with a single worker and `--timeout-graceful-shutdown 10`.

```text
                  +--------------------- one process ----------------------+
 browser  ------> |  uvicorn -> middleware stack -> routers (thin)          |
 (SPA + SW)       |                                  |                      |
                  |                               services/  <---+         |
                  |                                  |           |         |
                  |   daemon worker threads  <-------+   WorkerRegistry    |
                  |   (scanner, downloads, AI, catalog, ...)  app.state.workers
                  +-------+---------------+----------------+---------------+
                          |               |                |
                   SQLite (WAL)     DOWNLOADS_DIR      yt-dlp / ffmpeg
                   DATA_DIR/horde.db  (media)          (child processes)
                          optional: bgutil POT, Ollama, OpenRouter (HTTP)
```

- **Request threads.** Sync route handlers run in uvicorn's thread pool and open their own SQLModel `Session` per request. Middleware that touches the database (sign-in) hops to a worker thread so the event loop stays free.
- **Worker threads.** Every long-lived loop is a `BackgroundWorker` (or implements the `ManagedWorker` protocol: `start`, `signal_stop`, `stop`, `is_alive`, `healthy`) from `services/workers.py`. They are daemon threads. Short-lived threads started by a request (bulk metadata sync, playlist sync) are not registered.
- **Child processes.** yt-dlp runs in-process as a library; ffmpeg and ffprobe are child processes. Every long ffmpeg goes through `run_ffmpeg`, which makes it cancellable and killable at shutdown.
- **State lives on objects, not modules, in new code.** `lifespan` creates the `WorkerRegistry` (`app.state.workers`) and the shutdown event (`app.state.shutdown_event`); `install_security` creates the auth runtime, the yt-dlp extraction gate and request slots, request stats and the thumbnail-grab limit on `app.state`. Older singletons (`download_queue`, `sprite_pool`, the AI wake event) are still module-level; new code does not add more.

### The WorkerRegistry

`lifespan` builds one `WorkerRegistry` and starts every worker through it. The registry:

- keeps workers in start order and **stops them in reverse**, so what others depend on starts first and stops last;
- signals **all** workers before joining any, then joins each with its own timeout (5 s default, 10 s for the download and ffmpeg queues) inside a 20 s overall budget, logging a worker that does not stop by name at `ERROR`;
- reports health: `GET /api/ready` returns `503` if any worker `healthy` is false (a worker that finished its job on purpose, such as the codec probe backfill, counts as healthy) and `/api/metrics` exposes `horde_worker_up`.

| Worker (registry name) | Role |
|---|---|
| `ffmpeg-children` | Terminates ffmpeg processes still running at shutdown (started first, stops last) |
| `pot-probe` | Pings the bgutil PO-token sidecar, only when `YTDLP_POT_BASE_URL` is set |
| `download-queue`, `ffmpeg-queue`, `download-reaper` | yt-dlp slots, the postprocess pool, the stuck-job reaper |
| `sprites` | Bounded pool for seek-preview sprite sheets |
| `scanner-watchdog`, `scanner-poller` | Filesystem events plus a periodic walk of `DOWNLOADS_DIR` |
| `metadata-sync` | Refresh stale source metadata and subscribed playlists |
| `horde-ai-worker`, `horde-ai-timer` | Single-flight AI job runner and its scheduler |
| `horde-channel-catalog` | One channel index at a time |
| `autodownload-poller`, `subtitle-retry`, `job-metadata`, `codec-probe-backfill`, `nightly-backup` | The remaining loops |

Details per worker: [Background workers](../architecture/workers.md).

### Startup order

`lifespan` in `app/main.py`:

1. `ensure_dirs()`, then `init_db()`: Alembic upgrade (refuses to start on a database from a newer Horde). Log a loud warning if `HORDE_AUTH_DISABLED` is set.
2. Create the shutdown event and the registry; wrap SIGINT/SIGTERM so SSE streams end the moment the signal lands.
3. Under `HORDE_E2E` the app seeds test data and **skips everything below**.
4. Storage warning (network filesystem under `DATA_DIR`), `cleanup_orphans()`, load yt-dlp plugins, create the preview HTTP client.
5. `_start_workers`: ffmpeg-children, POT probe, download queue, ffmpeg queue, reaper, then **recovery** (`download_queue.recover()` turns `downloading` into `queued`, orphaned device dirs and temp files are swept, `recover_ai_jobs()` turns `running` into `queued`, `recover_catalog_jobs()` turns `indexing` into `queued`), then sprites, scanner, metadata sync, AI, catalog, autodownload, subtitle retry, job metadata, codec probe backfill, nightly backup.

Recovery runs before the loops that would claim jobs, so a crash cannot strand work.

### Shutdown order

1. Uvicorn stops accepting connections and drains for up to 10 s. SSE streams watch `shutdown_event` and finish at once; `/api/ready` answers `503 shutting down`.
2. `lifespan` sets the event and calls `registry.stop_all()` in a thread (so a worker mid-write cannot block the event loop that is still closing connections): signal everyone, join newest first.
3. In-flight downloads and encodes are requeued, not cancelled; ffmpeg gets `SIGTERM`, then `SIGKILL` after 3 s.
4. The preview client is closed and the original signal handlers restored.

Worst case is about 30 s; Compose sets `stop_grace_period: 40s`. If startup fails part way, the `finally` still stops the workers that started.

## A request's path

The middleware list is defined in exactly one place, `build_stack()` in `app/security.py`; the first entry is outermost.

```text
request
  |  SecurityHeadersMiddleware   CSP, nosniff, referrer, framing (wraps rejections too)
  |  RequestIdMiddleware         X-Request-ID in/out, log context, request counters
  |  HostAllowlistMiddleware     400 for an unexpected Host (DNS rebinding)
  |  BodyLimitMiddleware         413 above the route's cap, before parsing
  |  MediaCorsMiddleware         CORS headers on stream/subtitle/thumbnail routes only
  |  CsrfMiddleware              non-GET/HEAD/OPTIONS: X-Horde-Request, Sec-Fetch-Site, Origin
  |  AuthMiddleware              /api deny by default; sets request.state.user
  v
FastAPI router -> dependencies -> handler -> service -> Session -> response_model
                  current_user / require_admin / require_permission("...")
errors anywhere -> install_error_handlers -> one JSON envelope
```

- **Auth** resolves the caller from the `horde_session` cookie, else (only for GET/HEAD on stream, subtitle and thumbnail URLs) a signed `?mt=` token, else, when `HORDE_AUTH_DISABLED` is set, the proxy-vouched identity. Only the exact `PUBLIC_ROUTES` list is open; `/api`, `/docs`, `/redoc` and `/openapi.json` are protected. Reasoning: [ADR 0003](../adr/0003-auth-model.md), [ADR 0004](../adr/0004-csrf-header-policy.md).
- **Authorisation** is per route: `Depends(require_admin)` for server-wide changes, `Depends(require_permission("..."))` for what a member needs a grant for, `Depends(current_user)` to read the caller. `tests/test_permissions.py` fails when a mutating route is not classified.
- **Routers stay thin** (`app/api/`, one per area); logic lives in `app/services/`. New endpoints declare a `response_model` (`schemas.py`, `response_schemas.py`) or, for bytes and streams, a media type in `openapi_responses.py`.
- **Errors** always have the shape `{detail, code, fields?, extra?, request_id?}` ([ADR 0005](../adr/0005-error-envelope-and-cursors.md)). An unexpected exception becomes a generic `500` carrying only the request id; the traceback goes to the log.
- **Lists** (`/api/videos`, `/api/review`, tags) return `{items, next_cursor, total?}` and are walked with opaque cursors.
- **Static files**: after the API routers, `mount_frontend` serves `/assets` (immutable), `/wiki` and the SPA fallback. Unknown `/api/...` paths and `sw.js` return a JSON 404, never `index.html`.

Detail: [Security](../ops/security.md), [Accounts and sign-in](../ops/authentication.md), [API overview](../architecture/api-overview.md).

## Data model and ownership

SQLite at `DATA_DIR/horde.db` ([ADR 0001](../adr/0001-sqlite-wal-alembic.md)). Settings are not rows: server settings are JSON in `DATA_DIR/app_settings.json`, per-user UI preferences are a JSON column ([Settings split](settings-split.md)).

| Area | Tables | Owner |
|---|---|---|
| Library | `videos` (`youtube_id` after WP-M), `playlists`, `playlist_items` | **Shared** by everyone |
| Downloads | `download_jobs` | **Shared** (no user column) |
| Channels | `channel_catalogs`, `channel_catalog_videos`, `channel_catalog_skips`, `channel_catalog_embeddings`, `channel_autodownloads` | **Shared** |
| AI (derived from the library) | `video_embeddings`, `video_ai_meta`, `ai_categories`, `ai_jobs`, `openrouter_usage` | **Shared** |
| Search (after WP-M) | `video_tags` and the `videos_fts` index | **Shared**, derived by SQLite triggers |
| Accounts | `users`, `user_sessions` | The person |
| History | `user_video_state` (position and last watched, per user per video) | **Per user** |
| Preferences | `user_settings` (UI JSON) | **Per user** |
| AI chat | `video_ai_chat_messages` (has `user_id`) | **Per user** |

Rules that follow from this:

- **Watch history is per user.** Read and write `user_video_state` through `services/user_state.py`; pass `user_id` to `library.query_videos` and `video_serialize.to_read`. The legacy `videos.last_position_sec` / `last_watched_at` columns are never touched; they only exist so the first admin can adopt old history.
- **Deletes go through `services/video_delete.delete_video_cascade`**: dependent rows explicitly, commit, then files, restricted to paths inside `DOWNLOADS_DIR` or `DATA_DIR`. Foreign keys are enforced and each declares `ON DELETE`.
- **Derived data is derived in the database** where an omitted write would silently desynchronise it (the tag table and the FTS index are trigger-maintained; see ADR 0007).
- **Files on disk** (media, thumbnails, sprites, subtitles, H.264 sidecars) are referenced by path; the scanner reconciles disk and rows.

Detail: [Data model](../architecture/data-model.md), [SQLite and migrations](sqlite-and-migrations.md).

## Download pipeline

```text
URL --> url_clean --> enqueue DownloadJob (cheap; no yt-dlp call)
                         |             \
                         |              job-metadata worker fills title / presets
                         v
              download-queue   (MAX_DOWNLOAD_CONCURRENCY slots)
                runner: yt-dlp attempt loop -> staged file
                         |
                         v
              ffmpeg-queue     (MAX_FFMPEG_CONCURRENCY slots)
                postprocess: remux / convert / loudnorm / quality check
                         |
                         v
              finalize: promote from staging -> Channel/Year/Title [id].ext
                one short DB transaction -> Video row visible
                         |
          +--------------+----------------------+
          v              v                      v
   thumbnail + sprites   subtitles (retry)   AI jobs, catalog sync, H.264 sidecar
```

- **Stages are separate pools** so a slow encode does not hold a yt-dlp slot. Everything slow happens before the single short transaction that makes a video visible.
- **Staging**: a job writes under `DOWNLOADS_DIR/.horde-staging/<job id>/` (device downloads under `_device/<job id>`, never reaching the library) and is promoted only after postprocessing, so the scanner never sees half-built files.
- **Crash safety**: the runner body is total (any failure ends the job in `error` with a typed `error_kind`), database writes retry "database is locked", the reaper requeues stuck `downloading` jobs, and boot recovery requeues the rest.
- **Progress** is an in-memory store (`progress_store`) read by one multiplexed SSE stream (`GET /api/downloads/events`) plus per-job streams for Watch.
- **Code layout** after WP-J1: the `services/downloads/` package (`queue`, `runner`, `ffmpeg_queue`, `postprocess`, `finalize`, `jobs`, `playlist_import`, `playlist_attach`, `progress`, `staging`, `artifacts`, `lifecycle`, `errors`, `dbwrite`, `spec`, `infodict`, `subtitles`). `services/downloader.py` stays as a re-exporting facade for one release. New code imports the package modules ([ADR 0006](../adr/0006-downloader-package-split.md)). yt-dlp helpers live in `ytdlp_extract.py`, `ytdlp_formats.py` and `ytdlp_common.py`.

Detail: [Download pipeline](../architecture/downloads-pipeline.md).

## AI pipeline

```text
event (download finished, user action, timer sweep)
   --> ai_jobs row (queued; dedup while active)
   --> one runner thread, one job at a time ("single-flight")
         dispatch by kind:
           embed_video / embed_catalog_video --> video_embeddings / channel_catalog_embeddings
           enrich_tags --> video_ai_meta (+ videos.tags)
           summarize, chapters --> video_ai_meta
           refresh_categories --> ai_categories
   --> retry up to 3 attempts, backoff 2 x attempts minutes; soft skips become cancelled
reads:  hybrid search = keyword hits + embedding neighbours, merged
        related / recommendations / category chips = similarity over stored vectors
        chat = per-user messages, context from retrieved caption chunks (streamed over SSE)
```

- **Providers**: Ollama (local) and/or OpenRouter (cloud), chosen from settings and environment; embeddings, chat and tagging can route differently. Provider calls that cost money are recorded in `openrouter_usage` on a separate session, so jobs commit before the HTTP call; a hard budget pauses the worker.
- **Single-flight** because homelab GPUs thrash under parallel model calls ([design note](single-flight-ai.md)). Queue state is in SQLite, so a restart recovers it (`running` becomes `queued`).
- **Vector search** scores every stored chunk with one matrix product. After WP-M the normalised `float32` matrix lives in `services/ai/vector_index.py`, on the engine object, and is updated incrementally from a cheap per-video fingerprint instead of being rebuilt on every change ([ADR 0007](../adr/0007-fts5-triggers-and-vector-index.md)). It needs `numpy` and about `chunks x dim x 4` bytes.
- **Per-user vs shared**: summaries, tags, chapters and embeddings are shared library data; chat is per user; "For you" is seeded from the signed-in user's history. Members need `use_ai`.

Detail: [AI pipeline](../architecture/ai-pipeline.md).

## Channel catalog

A catalog is a local index of a YouTube channel's uploads, so the Library can browse, search and preview videos that are not downloaded yet, and so autodownload can decide what is new.

- **Indexing** (`services/channel_catalog/`: `runtime`, `index`, `query`, `skips`, `documents`): one catalog at a time on `horde-channel-catalog`. Phases `flat` (paged upload list), `descriptions` (newest window), `embed` (queues `embed_catalog_video` jobs for the AI worker), then `ready`. Members-only, age-restricted and private ids go to `channel_catalog_skips`. A catalog left `indexing` at a crash is requeued at boot.
- **Feed-head sync** (`sync_feed_head`) fetches only the newest uploads and is what keeps a catalog fresh and what autodownload uses.
- **Autodownload** (`channel_autodownload.py`, policy rows in `channel_autodownloads`): every 15 minutes the `autodownload-poller` syncs the head of each enabled channel and enqueues matching videos as ordinary download jobs built from catalog metadata (no per-video extract).
- **Search**: `search_catalog` fuses keyword and semantic hits; catalog fetches share the global yt-dlp extract gate with previews (one call at a time, spaced, interactive requests first) so browsing never stampedes YouTube.

Detail: [Channels](../guides/channels.md), [Background workers](../architecture/workers.md#catalog-worker).

## Frontend

React 18 + TypeScript + Vite + Tailwind under `frontend/src/`, built into `backend/static` (served by FastAPI) and shipped in the same image.

| Path | What belongs there |
|---|---|
| `pages/` | One component per route (Library, Watch, Download, Import, Playlists, History, Settings, Setup, Offline, Login, CreateAdmin). Heavy pages are lazy-loaded (`pages/lazy.ts`). Page-specific helpers sit beside the page |
| `components/` | Reusable UI; `components/auth/` for account UI and `RequirePermission` |
| `context/` | Cross-cutting state providers: Toast, Confirm, Auth, Download, Search, Playback |
| `hooks/` | Data and behaviour hooks (settings hydrate, casting, card preview, ...) |
| `api.ts`, `apiErrors.ts` | The only HTTP client. Adds `X-Horde-Request` to every request (`withCsrf`), parses the error envelope into `ApiError`, follows cursors |
| `types.ts`, `types/` | Wire types mirroring `backend/openapi.json` |
| `utils/`, `utils.ts` | Pure helpers (`safeHref` for any link rendered from stored data) |
| `offline/` | Service worker, IndexedDB, offline downloads |
| `effects/` | Canvas background effects |

Provider nesting in `App.tsx`, outer to inner: `ErrorBoundary`, `ToastProvider`, `ConfirmProvider`, `AuthProvider`, `AuthGate` (shows sign-in or create-admin instead of the app), `DownloadProvider`, `SearchProvider`, `PlaybackProvider`. Until the setup wizard has completed only `/setup` is routed. Routes that need a grant are wrapped in `RequirePermission`, which only hides UI; the server enforces.

**Offline / PWA.** `offline/sw.ts` is bundled by a small Vite plugin into `dist/sw.js` with the build's precache list. It serves the app shell cache-first, so the installed app launches without the network, and answers `/api/videos/{id}/stream` from Cache Storage with HTTP Range support when the video was saved for offline. Saved videos are stored as 4 MiB chunks (so an interrupted download resumes), their metadata in IndexedDB (`horde-offline`), and thumbnails and subtitles under their real API URLs. Everything else under `/api` goes to the network. Because cache entries are keyed by the literal API URLs, the URL scheme is a compatibility surface ([ADR 0005](../adr/0005-error-envelope-and-cursors.md)). `sw.js`, `index.html` and `manifest.json` are served `no-cache` so updates are noticed.

**Where to put new code**

- A new screen: a `pages/` component, a lazy entry in `pages/lazy.ts`, a route in `App.tsx` (with `RequirePermission` if a grant is needed).
- A new API call: a typed function in `api.ts` (never a bare `fetch`; a mutating `fetch` or `XMLHttpRequest` outside it must use `withCsrf()` / `CSRF_HEADER`), types in `types.ts`.
- Shared state used by several pages: a context; state used by one page: a hook beside it.
- A link built from stored data: `safeHref()`.
- Offline behaviour: `offline/`, and bump the cache version names in `offline/db.ts` if a stored shape changes.
- Backend: a route in `app/api/<area>.py` (thin, with `response_model` and the right `Depends`), logic in `app/services/`, tables in `models.py` plus an Alembic revision, background loops as a `BackgroundWorker` registered in `_start_workers`, request/response models in `schemas.py`.

Detail: [Frontend](../architecture/frontend.md), [Player architecture](player-architecture.md).

## Related

- [Decision records](../adr/index.md)
- [Architecture overview](../architecture/overview.md)
- [Testing and the quality gate](../getting-started/testing.md)

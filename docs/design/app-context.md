# Application context

One running Horde instance is described by an `AppContext` (`backend/app/context.py`).
It holds the things that used to be import-time constants and singletons:

| Field | What it is |
|-------|------------|
| `paths` | `Paths`: `downloads`, `data` and the directories under `data` (`thumbnails`, `sprites`, `backgrounds`, `fonts`, `db_path`) |
| `engine` | The SQLite engine (WAL, busy timeout, foreign keys) |
| `download_queue`, `ffmpeg_queue` | The download scheduler and the postprocess queue |
| `workers`, `shutdown_event` | The `WorkerRegistry` and the event that ends long-lived streams |
| `notifier` | The outgoing-notification queue and its delivery worker ([Notifications](../ops/notifications.md)) |
| `sidecars` | The queue of library-wide jobs for the optional Jellyfin / Kodi / Plex files and its worker ([Media servers](../guides/media-servers.md)) |
| `auth` | The app's `AuthRuntime` (copied from `app.state.auth`) |
| `ai` | `AiRuntimeState`: the AI worker's wake event and "blocked" reason |
| `caches` | Request-path caches (`search_cache`, `duplicate_groups`), built by `install_caches`; `app.state` aliases them for the routers |
| `e2e` | True only in the Playwright process (`HORDE_E2E`) |

## How code reaches it

- **Request handlers**: `ctx: AppContext = Depends(get_ctx)` and `session: Session = Depends(get_session)`.
  `lifespan` builds the context and stores it on `app.state.ctx` (`install_context`).
  `app.state.workers` and `app.state.shutdown_event` are kept as aliases of the context's
  objects, because the readiness probe, metrics and the event streams read them there.
- **Services and threads** have no request. They call `get_paths()`, `get_engine()` or
  `new_session()`, which read the *active* context. `lifespan` activates the context
  it built and puts the previous one back on shutdown.
- **Scripts** (`python -m app.cli`, Alembic) never run `lifespan`; the first call builds a
  context from `DOWNLOADS_DIR` / `DATA_DIR`.

Exactly one context is active per process: activation is a single global slot, not
per app or per thread. Two apps or lifespans in one process share it, so they must
exit in the reverse order they started (each restores what it replaced). Tests rely on
this: the fixture activates, the test runs, the fixture restores. Outside tests a
call with nothing active builds a context from the environment (CLI, scripts); under
pytest that fallback raises instead.

`ctx.download_queue` and `ctx.ffmpeg_queue` are the module-level singletons, not
per-context instances (see the table at the end).

Do not import a directory or the engine at module level (`from ..config import DOWNLOADS_DIR`
no longer exists). Call the accessor where the path is used, so a test or a second
instance sees its own.

## Tests

The `tmp_dirs` fixture (and `init_db`, `app`, `client` built on it) builds a fresh
`AppContext` over a temp directory, activates it, and disposes the engine afterwards.
Nothing is patched module by module. A test that needs a different engine or flag sets
it on `app.state.ctx`.

## Browser tests

`HORDE_E2E=1` is read once, in `main.py`. It mounts `/api/e2e/reset` and makes the
context `e2e`; below that, code asks `ctx.e2e`. In an e2e context `lifespan` seeds the
library through `e2e_seed.prepare(ctx, mode)` and starts no worker, the download queue
does not dispatch (`DownloadQueue.dispatch_enabled`), `/api/updates` stays offline and
the download preview returns a canned answer. `DownloadQueue.reset()` is what the reset
route uses to clear the queue's in-memory state.

## Download queue wiring

The queue does not know how a job runs. `build_context` binds `download_queue.runner`
to `services.downloads.runner.run_download`, so importing the pipeline has no side
effects and tests get the same wiring from the fixture.

## Module-level state that remains

None of this holds a path or an engine. Each item is process-wide because it is either a
cache of a fact about the host or an external service, bookkeeping for a child process,
or a lock that has to be shared by every thread. They are candidates to move onto the
context one at a time; the ones tests rely on are reset by the fixtures in
`tests/conftest.py`.

| Where | State | Why it is still module-level |
|-------|-------|------------------------------|
| `services/downloads/queue.py`, `ffmpeg_queue.py`, `progress.py` | `download_queue`, `ffmpeg_queue`, `progress_store` | Imported by name by ~50 call sites and tests. `AppContext` holds the same objects (`ctx.download_queue`); `reset()` clears them |
| `services/downloads/jobs.py`, `playlist_attach.py` | `job_mutate_lock`, `playlist_attach_lock` | Locks that serialise DB read-modify-write across worker threads |
| `services/sprites.py` | `sprite_pool` | One ffmpeg pool for the process; the test fixture stops and reopens it |
| `services/ffmpeg_progress.py` | `children` | Registry of live ffmpeg children, terminated on shutdown |
| `services/ytdlp_common.py`, `ytdlp_extract.py` | extract gate, cookie-required marks, info and feed caches, last failure | Caches of yt-dlp answers keyed by URL; the extraction gate must be shared by all threads |
| `services/ai/provider.py` | resolved Ollama URL, model cache, last error, pulling set | Cache of the external service's state |
| `services/channel_catalog/runtime.py`, `index.py` | stop/wake events, head-sync in-flight set | Catalog worker control; one catalog job runs at a time |
| `services/scanner.py` | scan lock, suspend event, active-download sets | Coordinates the scanner with downloads in the same process |
| `services/compat_rendition.py`, `stream_preview.py`, `activity.py`, `job_metadata.py`, `subtitle_retry.py`, `metadata_sync.py` | in-flight job tables, pending queues, cooldowns | Progress bookkeeping for background work |
| `services/encode_probe.py`, `updates.py`, `feed_meta_cache.py`, `app_settings.py` | probe result, update-check cache, JSON stores | Cached reads of the host or of a file; keyed by path where relevant |
| `api/preview.py` | the shared HTTP client for stream previews | Opened and closed by `lifespan` |

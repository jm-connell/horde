# WP-F: Runtime, lifecycle, logging, observability

Read the review file's "No lifecycle management", "Global state" and health/logging rows. The security package moved Safari remux to a POST, added `security.py`, `limits.py` (extraction gate), `url_safety.py` and `uploads.py`. The downloader package added a stuck-job reaper, a boot temp sweep, ProgressStore and staging. Build on those; don't duplicate them.

## Items
1. **Event-loop blocking.** Audit EVERY `async def` route in `backend/app/api/` (and `main.py`). Any route that does sync DB, filesystem, subprocess, PIL, yt-dlp or a blocking httpx call on the loop must either become a plain `def` (FastAPI runs those in the threadpool) or wrap the blocking parts in `anyio.to_thread.run_sync`. Streaming/SSE routes that must stay async must not do blocking work between yields.
   - Add a test guard that fails if an `async def` route calls known-blocking functions. A pragmatic approach: an AST scan of `api/*.py` for `async def` bodies containing `Session(`, `subprocess`, `open(`, `.extract_info`, `time.sleep`, `httpx.get/post` (sync), with an explicit allowlist. Or a runtime test that sets a slow fake extractor and asserts `/api/ping` stays fast during a concurrent preview request.
   - Add timeouts to every blocking wait on the global extract gate in `ytdlp_common` (`waiter.wait()` with no timeout). The waiter gives up with a clear error after N seconds (configurable).
2. **A dedicated bounded thread pool for yt-dlp-bound request handlers**, so 40 default threadpool slots can't all be consumed by extractions. Size it from config and use it via `anyio.to_thread.run_sync(..., limiter=...)`, or via the `limits.py` gate if it already bounds this. Document how the two interact.
3. **Lifecycle.**
   - Introduce a small `BackgroundWorker` base or protocol (`start()`, `stop(timeout)`, a stop Event, a wake Event, an `is_alive` property) and a `WorkerRegistry` created in `lifespan` and stored on `app.state`. Every worker registers. Shutdown stops them in reverse order with per-worker join timeouts and logs any that didn't stop.
   - Migrate the existing ad-hoc workers onto it without changing their behaviour:
     - metadata sync (currently uninterruptible: `Event().wait(3600)` on a fresh Event)
     - scanner poller (`while True` with no stop)
     - AI worker and timer (flag only, no join)
     - catalog worker
     - autodownload
     - subtitle retry
     - job metadata
     - probe backfill
     - the download reaper
     - the download queue dispatcher and the ffmpeg queue (signal cancel events for in-flight downloads on shutdown, and give ffmpeg children a graceful terminate then kill, using `start_new_session` so the whole process group dies)
     - sprites: replace thread-per-video blocked on a semaphore with ONE bounded worker pool fed by a queue, so a bulk import doesn't spawn thousands of threads
   - If an exception happens mid-startup, already-started workers are stopped (the try/finally must wrap the starts).
   - SSE generators observe an app-level shutdown event and end promptly.
   - Add `--timeout-graceful-shutdown 10` to the uvicorn command (Dockerfile CMD and dev scripts).
   - Move the synchronous startup `scan_once()` off the critical path: start serving, then run the initial scan in the scanner worker.
   - Tests: start the app with TestClient (lifespan) using fast fake workers, then shut down and assert every worker thread has exited within the timeout and no ffmpeg/yt-dlp child processes remain (use a fake long-running subprocess).
4. **Logging.**
   - Add one `app/logging_config.py` applied at import of `main` and by the uvicorn `--log-config`/dictConfig:
     - Level from `HORDE_LOG_LEVEL` (default INFO). Format with timestamp, level, logger, thread name, plus `request_id`/`job_id` when present.
     - Optional JSON format via `HORDE_LOG_FORMAT=json` (no new dependency; a small JSON formatter).
     - Make uvicorn's access log use the same format.
   - Correlation IDs: a middleware sets a `request_id` contextvar (use the incoming `X-Request-ID` if it's sane, otherwise generate one) and echoes it in the response header. Download/AI/catalog workers set a `job_id` contextvar around job execution. A logging Filter injects both.
   - Silent excepts: convert every remaining `except ...: pass` / bare-return broad except carrying the `noqa: S110`/`SIM105`/`BLE001` markers to log with `logger.debug/warning(..., exc_info=True)` at an appropriate level. Narrow the exception type where the intent is clear. Remove the noqa markers you resolve.
     - Add a test that greps `backend/app` and fails if any `noqa: S110` remains, or keep a tiny explicit allowlist with justifications.
     - Add ruff `S110` and `BLE001` without blanket per-file ignores, so new silent excepts fail lint.
   - Modules without a logger that do I/O (scanner, library, metadata, activity, api/videos, api/channels, api/playlists) get one where they handle errors.
5. **Health and readiness.**
   - `/api/health` must be cheap. Cache the yt-dlp version once at startup (`yt_dlp.version.__version__` in-process, no subprocess). Cache the POT sidecar ping with a 30s TTL in a background refresh or a lazy TTL cache. Keep the 3 COUNT queries (fine). Never block more than ~50ms.
   - Add `GET /api/ready` (DB reachable plus migrations at head plus workers alive) as a distinct readiness probe. Keep `/api/ping` as liveness.
   - Report the ffmpeg flavor/version from `/app/BUILD_INFO` (written by the Dockerfile) if present.
   - Note: the auth package (coming next) will reduce the unauthenticated health payload. Keep the payload construction in one function so that's easy.
6. **Storage safety.** At startup, detect whether DATA_DIR is on a network filesystem (Linux: parse `/proc/self/mountinfo` for the mount containing DATA_DIR; nfs, nfs4, cifs, smb3, 9p, fuse.sshfs). If it is, log an ERROR explaining SQLite WAL is unsafe there and surface `storage_warning` in `/api/health` (authenticated payload).
7. **Nightly backups.** A worker that runs `VACUUM INTO` (or the sqlite3 backup API) to `DATA_DIR/backups/horde-nightly-YYYYMMDD.db` once a day at a configurable local hour (`HORDE_BACKUP_HOUR`, default 4; `HORDE_BACKUP_KEEP` default 7; disable with 0). The migration runner already writes `horde-pre-*.db` into the same dir; make the pruning only touch nightly files. Document it in backup-restore.md.
8. **Metrics (optional but preferred).** `GET /api/metrics` in Prometheus text format, hand-rolled with no new dependency: queue depths, active downloads, AI queue, catalog queue, worker alive flags, DB size, disk free, request counts by status class. Keep it cheap and protected the same as other API routes.

## Constraints
- Behaviour visible to users must not change except: faster health, graceful shutdown, logs.
- Keep each item its own commit (or a few).
- Prefer API- and lifespan-level tests that exercise real behaviour.

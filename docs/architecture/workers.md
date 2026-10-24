# Background workers

Horde runs several daemon threads alongside the API. None require a separate process manager inside the container.

## Lifecycle { #lifecycle }

Every worker is a `BackgroundWorker` (or implements the same `ManagedWorker` protocol: `start()`, `signal_stop()`, `stop(timeout)`, `is_alive`, `healthy`) from `services/workers.py`. `lifespan` creates one `WorkerRegistry`, keeps it on `app.state.workers` and starts every worker through it.

On shutdown (SIGTERM from `docker stop`, Ctrl+C):

1. Uvicorn stops accepting connections and drains open ones for up to `--timeout-graceful-shutdown` (10 s). The SSE streams (`/api/downloads/events`, `/api/downloads/{id}/events`) watch `app.state.shutdown_event`, which is set the moment the signal arrives, so they end immediately instead of using up the grace period.
2. `lifespan` shutdown logs `stopping N background workers`, signals **every** worker first, then joins them one by one, newest first, each with its own timeout (5 s by default, 10 s for the download and ffmpeg queues) and an overall budget of 20 s. Each result is logged at `INFO`; a worker that does not stop is logged by name at `ERROR`. Because everything is signalled before anything is joined, independent workers wind down in parallel.
3. In-flight downloads and postprocess encodes are cancelled and **requeued** (status `queued`, not `cancelled`), so the next boot resumes them. ffmpeg children get `SIGTERM`, then `SIGKILL` after 3 s; each runs in its own session so helper processes die with it. A registry entry (`ffmpeg-children`) ends anything still running last. Every long ffmpeg goes through `run_ffmpeg` (download postprocess, H.264 copies, transcodes, sprite sheets, thumbnail frames), so all of them are cancellable this way; only short ffprobe-style probes (30 s or less) use plain `subprocess.run`.

**Worst-case stop time** is the 10 s drain plus the 20 s join budget, so 30 s; a normal stop takes 1-3 s. The Compose file allows 40 s (`stop_grace_period`). With plain `docker run` the default is only 10 s, so pass `--stop-timeout 40` (or more), or Docker kills the process before the workers finish.

If startup fails part way, the `finally` still stops the workers that already started.

The registry also feeds [`GET /api/ready`](../ops/monitoring.md#ready) and the `horde_worker_up` gauge on [`GET /api/metrics`](../ops/monitoring.md#metrics).

| Worker (registry name) | Notes |
|------------------------|-------|
| `ffmpeg-children` | Terminates ffmpeg processes still running at shutdown. |
| `download-queue`, `ffmpeg-queue`, `download-reaper` | Download threads (bounded by `MAX_DOWNLOAD_CONCURRENCY`), the postprocess pool and the stuck-job reaper (which also re-checks held downloads every 30 s). |
| `sprites` | One bounded pool of `SPRITE_CONCURRENCY` threads fed from a queue; a bulk import queues entries, not threads. Stopping the pool cancels the running ffmpeg. |
| `scanner-watchdog`, `scanner-poller` | File watcher and the polling walk. |
| `metadata-sync`, `horde-ai-worker`, `horde-ai-timer`, `horde-channel-catalog`, `autodownload-poller`, `subtitle-retry`, `stream-ai`, `job-metadata`, `trash-purge`, `channel-retention`, `notifications`, `media-sidecars`, `codec-probe-backfill`, `pot-probe`, `nightly-backup` | The loops described below. |

Short-lived threads started by a request (bulk metadata sync, playlist sync, H.264 copies) are not registered; they are daemon threads and every database write they make is transactional.

## Scanner

**Start:** `create_scanner_workers()` after DB init. The first full walk runs on the poller thread, not during startup, so the API answers while a large library is scanned.

| Mode | Behavior |
|------|----------|
| **Watchdog** | Recursive observer on `DOWNLOADS_DIR` for create/move events |
| **Poll** | Full tree walk every `SCAN_INTERVAL_SEC` (default **60**) as a fallback |

Discovers importable video extensions, ignores intermediate `.part` / `.fNNN` / `.norm` files, and coordinates with orphan cleanup. New files may enter the library or the review queue depending on path and settings.

## Download queue

**Recover:** `download_queue.recover()` on startup — jobs left `downloading` become `queued`. Jobs interrupted by a clean shutdown are requeued the same way before the process exits. Global pause is restored from app settings key `download_queue_paused` so Pause survives process restart.

- FIFO queue with `MAX_DOWNLOAD_CONCURRENCY` **download** workers (default **2**) plus a separate ffmpeg pool (`MAX_FFMPEG_CONCURRENCY`, default 1 or 2 with GPU).
- **Disk limits:** before dispatching a library job the queue asks `SpaceGate` (`services/downloads/space.py`) whether the library is under `max_library_bytes` (the number from `services/library_usage.py`, cached for 5 s) and the volume has at least `HORDE_MIN_FREE_GB` free. A job that does not fit stays `queued` and is remembered in memory with a reason (`library_full`, `would_exceed`, `low_disk`, `disk_full`); later jobs that fit may still start. `GET /api/downloads/queue/status`, the job list and the progress snapshots carry `held_reason`. The reaper tick re-checks held jobs every 30 s, and deletes and settings changes call `library_changed()`. After the metadata fetch the runner compares the preset's estimated size with the limit and returns the job to the queue (`DownloadHeld`) when it would not fit. An out-of-space write is classified as `disk_full` and makes the queue hold for five minutes.
- One multiplex SSE stream (`GET /api/downloads/events`); per-job streams remain for Watch.
- Per-job cancel/pause events; pause does not kill an in-flight encode. Progress snapshots for SSE (includes typed `error_kind` on failure and `stage` during post-download work).
- Metadata extracts share the yt-dlp extract gate with preview/feed (1 + 1.25s spacing; interactive preview jumps background fills).
- See [Download pipeline](downloads-pipeline.md) and [Troubleshooting](../ops/troubleshooting.md#download-error_kind-values).

## H.264 copies { #compat-jobs }

`compat_rendition.py` owns a small thread pool for `compat` (sidecar) and `convert` (in-place) jobs. It shares the ffmpeg cap (`MAX_FFMPEG_CONCURRENCY`, else **2** with a GPU H.264 encoder, otherwise **1**). Jobs are idempotent per video, queued in memory, and only their outcome is persisted (`compat_path`, `compat_size`, `compat_source`, `compat_error` on `videos`). A viewer-requested copy jumps ahead of a bulk backfill. Queued jobs are lost on restart; **Create N copies** in Settings → Library re-queues whatever is still missing. Cancel drops queued jobs and signals running ones. Details: [H.264 sidecar](downloads-pipeline.md#h264-sidecar).

### Codec probe backfill

**Start:** `create_probe_backfill_worker()` in the app lifespan. After a 10 s delay it ffprobes `ready` videos whose `media_probed_at` is empty, 25 at a time with a short pause, and stores the codec columns. It exits when nothing is left; unreadable files (NAS offline, mid-move) are skipped until the next boot.

## Job metadata

**Start:** `job_metadata.create_worker()` after subtitle retry.

Cheap URL/bulk enqueue does not wait on yt-dlp. This worker fills title, channel, thumbnail, and `available_presets` (and resolves `best` to a concrete height). YouTube Shorts discovered after enqueue are dropped (`skipped` / shorts), not shown as cancelled.

## Metadata sync

**Start:** `create_sync_worker(interval_hours=…)` from settings (default often 24h).

Each cycle:

1. Select videos due for resync (`metadata_synced_at` older than interval).
2. Process a **batch of 20** stale videos.
3. Refresh stale channel catalogs when enabled.
4. Rescan **subscribed YouTube playlists** (flat extract; download missing ids; attach existing library matches; keep YouTube order).
5. Sleep until the next interval (interval re-read from settings so UI changes apply without restart).

The loop itself ticks about hourly; playlist membership is cheap compared to per-video metadata refresh. Use **Sync now** on a subscribed playlist if a new part just dropped.

## AI worker

**Recover:** `recover_ai_jobs()` on startup — any `AiJob` left `running` → `queued` (then wake).

**Start:** `ai.worker.create_workers()` (the job runner and its scheduler) — **single-flight** (one job at a time).

| Behavior | Detail |
|----------|--------|
| Kinds | `embed_video`, `enrich_tags`, `refresh_categories`, `embed_catalog_video`, `summarize`, `chapters` |
| Retries | Up to **3** attempts; backoff `run_after` ≈ **2 × attempts** minutes |
| Pause | Settings `ai.paused` or the AI weekly budget hard stop |
| Schedule | `on_download` enqueue (plus idle catch-up of missing search indexes) vs timed sweeps |

Design note: [Single-flight AI](../design/single-flight-ai.md).

## Catalog worker

**Recover:** `recover_catalog_jobs()` on startup — catalogs left `indexing` → `queued` (then wake).

**Start:** `create_catalog_worker()` — **one catalog at a time** (implementation: `services/channel_catalog/` package — `runtime`, `index`, `query`, `skips`).

Phases per catalog:

```text
flat  →  descriptions  →  embed  →  ready
```

1. **flat** — paginated channel upload list  
2. **descriptions** — fill descriptions for newest window  
3. **embed** — enqueue `embed_catalog_video` jobs for the AI worker  

Members-only, age-restricted, and private IDs go to `channel_catalog_skips`. Runtime status (current channel, phase, counts, last skip/error) is exposed for the Settings/Channels UI.

## Autodownload poller

**Start:** `channel_autodownload.create_worker()` after the catalog worker.

Every **15 minutes** (first pass ~60s after startup), for each channel with autodownload enabled, run a feed-head sync of the newest uploads and enqueue matching videos into the download queue. Enabling autodownload from a channel page also syncs immediately. Jobs are created from catalog metadata (no per-video preview extract). See [Channels](../guides/channels.md#autodownload).

## Subtitle retry

**Start:** `subtitle_retry.create_worker()` after autodownload.

English captions are fetched after the file is watchable. A timedtext **HTTP 429** (or other retryable miss) leaves `subtitles_pending` set and stores `subtitles_retry_after` / `subtitles_fetch_attempts` instead of treating empty VTT as final.

| Control | Value | Purpose |
|---------|-------|---------|
| Backoff | **5m → 10m → 20m → 40m → 1h** | Per-video wait after each retryable miss |
| Global cooldown | same delay (max wins) | Do not immediately hit timedtext for the next pending video |
| Poll | **15 s** | Pick one due video (newest download first) |
| Spacing | **15 s** between fetches | Avoid a caption stampede after the cooldown lifts |

Videos added in the last **48 hours** that never got a metadata sync and still have empty captions are re-queued on worker start. Watch keeps showing “Subtitles loading” while `subtitles_pending` is true. Library **Resync** uses the same helper and skips timedtext while backoff is active.

## Stream AI

**Start:** `stream_ai.create_worker()` after subtitle retry. Once an hour it moves the saved AI results of streamed videos (`stream_ai_state`) onto library videos with the same YouTube id (download finalize does this immediately; the sweep covers imports) and deletes results nobody opened for `HORDE_STREAM_AI_RETENTION_DAYS` (default 30). See [ADR 0010](../adr/0010-stream-ai-retention.md).

## Trash purge

**Start:** `trash.create_worker()` after job metadata (`trash-purge`). Two minutes after start and then every hour it erases trash entries older than `HORDE_TRASH_DAYS` (default 7; with `0` entries still expire after 7 days), skipping entries whose trash folder cannot be seen (an unmounted share). It also looks at trash folders no entry owns that are over an hour old: it moves their files back when their video is still in the library and otherwise leaves them, never deleting them. It wakes the download queue when disk space was freed. See [ADR 0013](../adr/0013-trash-tombstones.md).

## Channel retention

**Start:** `channel_retention.create_worker()` after trash purge (`channel-retention`). Two minutes after start, then every hour (and at once when a rule is saved), it applies every enabled `channel_retention` rule: the videos a rule selects (and that no exception keeps) go through `trash.trash_video` with no user and a reason such as "Retention: keep latest 20". A video that cannot be moved is logged and skipped; the rest still go. It does nothing while the trash is off, and it does not wake the download queue: trashed bytes still count against the disk cap. See [Cleaning up old videos](../guides/channels.md#retention).

## Notifications

**Start:** `ctx.notifier.create_worker()` after channel retention (`notifications`). Emitters (`notifications.emit`, called from the download pipeline, the queue's disk hold and the live poller) only append to a bounded queue on `ctx.notifier`; the worker pops it, folds bursts per target and sends with a 10 s timeout and three attempts. Every five minutes it also looks at things nobody emits: the outcome of "Update now" and a new release (the latter only when a target wants it, through the cached update check). See [Notifications](../ops/notifications.md).

## Media-server files

**Start:** `ctx.sidecars.create_worker()` after the notifier (`media-sidecars`). It runs the library-wide jobs of the optional [Jellyfin / Kodi / Plex files](../guides/media-servers.md), one at a time, from a small queue on `ctx.sidecars` (`SidecarJobs` in `services/media_sidecars.py`): the backfill when the setting is turned on, a rewrite of a renamed channel's videos, and the removal of every file. It writes only when the bytes differ, pauses briefly after each video it wrote, stops when the setting is switched off mid-run, and reports done/total under System → Background activity (kind `sidecars`). Single-video changes (a download finishing, an edit, a thumbnail change, a metadata resync, AI tagging) do not use the queue: they call `media_sidecars.refresh(video_id)` in the thread that made the change, which logs and swallows its own failures.

## Nightly backup

**Start:** `backup.create_backup_worker()` unless `HORDE_BACKUP_ENABLED=0`. Checks every minute; once the configured local hour has passed and today's `horde-nightly-YYYYMMDD.db` does not exist, it writes it with `VACUUM INTO` and prunes older nightly files. A failed attempt (disk full, volume gone) is logged and retried an hour later. See [Backup & restore](../ops/backup-restore.md#nightly).

## Related

- [Maintenance](../ops/maintenance.md)
- [Overview](overview.md)
- [AI pipeline](ai-pipeline.md)


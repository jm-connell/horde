# Background workers

Horde runs several daemon threads alongside the API. None require a separate process manager inside the container.

## Scanner

**Start:** `start_scanner()` after DB init.

| Mode | Behavior |
|------|----------|
| **Watchdog** | Recursive observer on `DOWNLOADS_DIR` for create/move events |
| **Poll** | Full tree walk every `SCAN_INTERVAL_SEC` (default **60**) as a fallback |

Discovers importable video extensions, ignores intermediate `.part` / `.fNNN` / `.norm` files, and coordinates with orphan cleanup. New files may enter the library or the review queue depending on path and settings.

## Download queue

**Recover:** `download_queue.recover()` on startup — jobs left `downloading` become `queued` (restart from scratch; partials are not resumed). Global pause is restored from app settings key `download_queue_paused` so Pause survives process restart.

- FIFO queue with `MAX_DOWNLOAD_CONCURRENCY` workers (default **2**).
- Per-job cancel/pause events; progress snapshots for SSE (includes typed `error_kind` on failure and `stage` during post-download work).
- Metadata extracts share the yt-dlp extract gate with preview/feed (1 + 1.25s spacing).
- See [Download pipeline](downloads-pipeline.md) and [Troubleshooting](../ops/troubleshooting.md#download-error_kind-values).

## Metadata sync

**Start:** `start_sync_worker(interval_hours=…)` from settings (default often 24h).

Each cycle:

1. Select videos due for resync (`metadata_synced_at` older than interval).
2. Process a **batch of 20** stale videos.
3. Refresh stale channel catalogs when enabled.
4. Rescan **subscribed YouTube playlists** (flat extract; download missing ids; attach existing library matches; keep YouTube order).
5. Sleep until the next interval (interval re-read from settings so UI changes apply without restart).

The loop itself ticks about hourly; playlist membership is cheap compared to per-video metadata refresh. Use **Sync now** on a subscribed playlist if a new part just dropped.

## AI worker

**Recover:** `recover_ai_jobs()` on startup — any `AiJob` left `running` → `queued` (then wake).

**Start:** `start_ai_worker()` — **single-flight** (one job at a time).

| Behavior | Detail |
|----------|--------|
| Kinds | `embed_video`, `enrich_tags`, `refresh_categories`, `embed_catalog_video`, `summarize`, `chapters` |
| Retries | Up to **3** attempts; backoff `run_after` ≈ **2 × attempts** minutes |
| Pause | Settings `ai.paused` or OpenRouter hard budget stop |
| Schedule | `on_download` enqueue (plus idle catch-up of missing search indexes) vs timed sweeps |

Design note: [Single-flight AI](../design/single-flight-ai.md).

## Catalog worker

**Recover:** `recover_catalog_jobs()` on startup — catalogs left `indexing` → `queued` (then wake).

**Start:** `start_catalog_worker()` — **one catalog at a time** (implementation: `services/channel_catalog/` package — `runtime`, `index`, `query`, `skips`).

Phases per catalog:

```text
flat  →  descriptions  →  embed  →  ready
```

1. **flat** — paginated channel upload list  
2. **descriptions** — fill descriptions for newest window  
3. **embed** — enqueue `embed_catalog_video` jobs for the AI worker  

Members-only, age-restricted, and private IDs go to `channel_catalog_skips`. Runtime status (current channel, phase, counts, last skip/error) is exposed for the Settings/Channels UI.

## Autodownload poller

**Start:** `start_autodownload_worker()` after the catalog worker.

Every **15 minutes** (first pass ~60s after startup), for each channel with autodownload enabled, run a feed-head sync of the newest uploads and enqueue matching videos into the download queue. Enabling autodownload from a channel page also syncs immediately. Jobs are created from catalog metadata (no per-video preview extract). See [Channels](../guides/channels.md#autodownload).

## Subtitle retry

**Start:** `start_subtitle_retry_worker()` after autodownload.

English captions are fetched after the file is watchable. A timedtext **HTTP 429** (or other retryable miss) leaves `subtitles_pending` set and stores `subtitles_retry_after` / `subtitles_fetch_attempts` instead of treating empty VTT as final.

| Control | Value | Purpose |
|---------|-------|---------|
| Backoff | **5m → 10m → 20m → 40m → 1h** | Per-video wait after each retryable miss |
| Global cooldown | same delay (max wins) | Do not immediately hit timedtext for the next pending video |
| Poll | **15 s** | Pick one due video (newest download first) |
| Spacing | **15 s** between fetches | Avoid a caption stampede after the cooldown lifts |

Videos added in the last **48 hours** that never got a metadata sync and still have empty captions are re-queued on worker start. Watch keeps showing “Subtitles loading” while `subtitles_pending` is true. Library **Resync** uses the same helper and skips timedtext while backoff is active.

## Related

- [Maintenance](../ops/maintenance.md)
- [Overview](overview.md)
- [AI pipeline](ai-pipeline.md)

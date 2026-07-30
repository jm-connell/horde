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
- Per-job cancel/pause events; progress snapshots for SSE (includes typed `error_kind` on failure).
- Metadata extracts share the yt-dlp extract gate with preview/feed (1 + 1.25s spacing).
- See [Download pipeline](downloads-pipeline.md) and [Troubleshooting](../ops/troubleshooting.md#download-error_kind-values).

## Metadata sync

**Start:** `start_sync_worker(interval_hours=…)` from settings (default often 24h).

Each cycle:

1. Select videos due for resync (`metadata_synced_at` older than interval).
2. Process a **batch of 20** stale videos.
3. Refresh stale channel catalogs when enabled.
4. Sleep until the next interval (interval re-read from settings so UI changes apply without restart).

## AI worker

**Recover:** `recover_ai_jobs()` on startup — any `AiJob` left `running` → `queued` (then wake).

**Start:** `start_ai_worker()` — **single-flight** (one job at a time).

| Behavior | Detail |
|----------|--------|
| Kinds | `embed_video`, `enrich_tags`, `refresh_categories`, `embed_catalog_video` |
| Retries | Up to **3** attempts; backoff `run_after` ≈ **2 × attempts** minutes |
| Pause | Settings `ai.paused` or OpenRouter hard budget stop |
| Schedule | `on_download` enqueue vs timed sweeps |

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

Members-only IDs go to `channel_catalog_skips`. Runtime status (current channel, phase, counts) is exposed for the Settings/Channels UI.

## Related

- [Maintenance](../ops/maintenance.md)
- [Overview](overview.md)
- [AI pipeline](ai-pipeline.md)

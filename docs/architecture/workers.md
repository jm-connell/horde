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

**Recover:** `download_queue.recover()` on startup (interrupted jobs).

- FIFO queue with `MAX_DOWNLOAD_CONCURRENCY` workers (default **2**).
- Per-job cancel/pause events; progress snapshots for SSE.
- See [Download pipeline](downloads-pipeline.md).

## Metadata sync

**Start:** `start_sync_worker(interval_hours=…)` from settings (default often 24h).

Each cycle:

1. Select videos due for resync (`metadata_synced_at` older than interval).
2. Process a **batch of 20** stale videos.
3. Refresh stale channel catalogs when enabled.
4. Sleep until the next interval (interval re-read from settings so UI changes apply without restart).

## AI worker

**Start:** `start_ai_worker()` — **single-flight** (one job at a time).

| Behavior | Detail |
|----------|--------|
| Kinds | `embed_video`, `enrich_tags`, `refresh_categories`, `embed_catalog_video`, `score_duplicates` (no-op) |
| Retries | Up to **3** attempts; backoff `run_after` ≈ **2 × attempts** minutes |
| Pause | Settings `ai.paused` or OpenRouter hard budget stop |
| Schedule | `on_download` enqueue vs timed sweeps |

Design note: [Single-flight AI](../design/single-flight-ai.md).

## Catalog worker

**Start:** `start_catalog_worker()` — **one catalog at a time**.

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

# Architecture overview

For one page that connects the process model, the request path, ownership of data and the pipelines, start with the [architecture map](../design/architecture.md); the reasoning behind the big choices is in the [decision records](../adr/index.md).

Horde is a **single-container** app: FastAPI serves the JSON API, streams media, and hosts the built React SPA (plus the MkDocs wiki in image builds). Optional sidecars (bgutil POT, Ollama) sit beside it in Compose.

```text
                    +------------------ host:8686 ------------------+
                    |              container :8080                   |
  Browser --------->|  FastAPI  +  static UI  +  /wiki (optional)   |
                    |     |                                         |
                    |     +-- SQLite (DATA_DIR/horde.db)            |
                    |     +-- media   (DOWNLOADS_DIR)               |
                    +-------------------+---------------------------+
                                        |
              +-------------------------+-------------------------+
              |                         |                         |
        bgutil-pot:4416           ollama:11434              OpenRouter
         (POT tokens)           (profile: ai)               (cloud API)
```

## Lifespan (startup)

On process start, `lifespan` in `main.py` runs roughly:

```text
build AppContext + ensure dirs
    -> init_db (Alembic upgrade head)
    -> cleanup_orphans
    -> ensure yt-dlp plugins loaded
    -> init preview HTTP client
    -> register download/ffmpeg queues + reaper, then download_queue.recover()   # downloading→queued; restore pause flag
    -> recover_ai_jobs()          # running→queued
    -> recover_catalog_jobs()     # indexing→queued
    -> sprite pool, scanner (the first scan runs on its poller thread)
    -> metadata sync, AI, catalog, autodownload, subtitle retry, job metadata, probe backfill, nightly backup
```

Stuck mid-flight download / AI / catalog work is requeued **before** workers start so a crash cannot leave jobs stranded forever. Download queue pause is restored from `download_queue_paused` in app settings.

Shutdown signals every registered worker and joins them in reverse start order with a per-worker timeout; in-flight downloads are requeued and ffmpeg children are terminated. See [Workers](workers.md#lifecycle).

## Major moving parts

| Piece | Role |
|-------|------|
| **API routers** | Videos, downloads, preview, review, playlists, channels, settings, AI, system, setup, auth, users, backgrounds, fonts, compat |
| **Scanner** | Discovers files dropped into downloads; orphan awareness |
| **Download queue** | Concurrent yt-dlp jobs, ffmpeg postprocess pool, multiplex SSE |
| **Job metadata** | Background title/preset fill for cheap-enqueued downloads |
| **Metadata sync** | Periodic refresh of source metadata |
| **AI worker** | Single-flight embed/tag/category jobs |
| **Catalog worker** | One-at-a-time channel index phases |
| **Autodownload poller** | Periodic feed-head sync for channels with autodownload enabled |
| **React SPA** | Library, player, settings; providers for download/playback/search/toast |

!!! warning "Trust boundary"
    Sign-in is required, but the network is still assumed to be trusted: do not expose Horde to the internet. See [Security model](../design/no-auth.md) and [Single container](../design/single-container.md).

## Related

- [Backend](backend.md)
- [Frontend](frontend.md)
- [Workers](workers.md)
- [API overview](api-overview.md)

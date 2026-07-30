# Architecture overview

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
ensure_dirs
    -> init_db (create_all + ALTER migrations + verify_schema)
    -> cleanup_orphans
    -> ensure yt-dlp plugins loaded
    -> init preview HTTP client
    -> download_queue.recover()
    -> start_scanner()          # watchdog + poll
    -> start_sync_worker()      # metadata / catalog freshness
    -> start_ai_worker()
    -> start_catalog_worker()
```

Shutdown stops catalog and AI workers, joins the scanner observer, and closes the preview client.

## Major moving parts

| Piece | Role |
|-------|------|
| **API routers** | Videos, downloads, preview, review, playlists, settings, AI, system, backgrounds, fonts |
| **Scanner** | Discovers files dropped into downloads; orphan awareness |
| **Download queue** | Concurrent yt-dlp jobs, SSE progress |
| **Metadata sync** | Periodic refresh of source metadata |
| **AI worker** | Single-flight embed/tag/category jobs |
| **Catalog worker** | One-at-a-time channel index phases |
| **React SPA** | Library, player, settings; providers for download/playback/search/toast |

!!! warning "Trust boundary"
    No authentication — treat the network as the security boundary. See [No authentication](../design/no-auth.md) and [Single container](../design/single-container.md).

## Related

- [Backend](backend.md)
- [Frontend](frontend.md)
- [Workers](workers.md)
- [API overview](api-overview.md)

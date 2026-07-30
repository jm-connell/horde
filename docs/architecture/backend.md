# Backend

Python package under `backend/app/`. FastAPI app entry: `main.py`.

## Module map

### `api/`

| Module | Responsibility |
|--------|----------------|
| `videos.py` | Library CRUD, streaming (Range), sprites, subtitles, AI chat/tags on videos |
| `channels.py` | Channel list/rename/search, catalog index/status/search, channel feed |
| `video_serialize.py` | Shared `VideoRead` serialization + media path resolution |
| `downloads.py` | Queue jobs, presets, progress SSE, pause/resume |
| `preview.py` | Watch-before-download / DASH proxy (uses `stream_preview`) |
| `review.py` | Import queue, approve/reject, duplicate groups (on-demand AI score) |
| `playlists.py` | User + imported playlists |
| `app_settings.py` | GET/PATCH settings |
| `ai.py` | Status, chat stream, recommend, maintenance enqueue, OpenRouter costs |
| `system.py` | Disk/system stats surfaces for Settings |
| `backgrounds.py` | Custom background uploads |
| `fonts.py` | Custom UI font uploads |

Top-level routes on the app (not under a router module): `GET /api/health`, `GET /api/updates`.

### `services/`

| Area | Modules | Role |
|------|---------|------|
| Downloads | `downloader.py`, `ytdlp_extract.py`, `ytdlp_formats.py`, `stream_preview.py`, `url_clean.py`, `ytdlp_common.py` | Queue/finalize; metadata extract & feed; format presets; in-app DASH/progressive preview; URL clean; POT/cookies/extract gate |
| Library disk | `scanner.py`, `paths.py`, `library.py`, `metadata.py`, `sprites.py` | Scan, paths, probes, sprites |
| Sync / feeds | `metadata_sync.py`, `feed_meta_cache.py`, `channel_catalog/` (package), `return_youtube_dislike.py` | Stale metadata, catalog worker/index/query/skips, caches |
| Settings / updates | `app_settings.py`, `updates.py` | JSON settings, GitHub SHA compare |
| AI | `ai/` (`worker`, `tasks`, `embeddings`, `provider`, `workload`, `chat`, `search`, `recommend`, `duplicates`, `cost_ledger`, `text`) | Queue, providers, RAG, costs |

`channel_catalog/` is a package with façade re-exports: `skips` (members-only leaf), `runtime` (worker), `index`, `query`, `documents` (embedding text).

### Other

| Module | Role |
|--------|------|
| `config.py` | Env-derived paths and constants |
| `database.py` | Engine, `create_all`, `schema_migrations` ledger, additive `ALTER` columns, `verify_schema` |
| `models.py` | SQLModel tables |

## Lifespan order

From `main.py` `lifespan`:

1. `ensure_dirs()` — create downloads + data subdirs  
2. `init_db()` — `create_all`, versioned migration steps + additive columns, `verify_schema()`  
3. `cleanup_orphans()` — drop library rows for missing files  
4. `ensure_plugins_loaded()` — load yt-dlp plugins once before workers  
5. `preview.init_preview_client()`  
6. `downloader.download_queue.recover()` — `downloading` → `queued`; restore `download_queue_paused`  
7. `recover_ai_jobs()` — AI jobs left `running` → `queued`  
8. `recover_catalog_jobs()` — catalogs left `indexing` → `queued`  
9. `start_scanner()` — watchdog + `SCAN_INTERVAL_SEC` poller  
10. `start_sync_worker(interval_hours=…)` — from settings  
11. `start_ai_worker()`  
12. `start_catalog_worker()`  

On shutdown (reverse concerns): stop catalog → stop AI → stop observer → close preview client.

## Related

- [Overview](overview.md)
- [Data model](data-model.md)
- [Workers](workers.md)
- [Download pipeline](downloads-pipeline.md)
- [AI pipeline](ai-pipeline.md)

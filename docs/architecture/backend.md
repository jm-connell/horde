# Backend

Python package under `backend/app/`. FastAPI app entry: `main.py`.

## Module map

### `api/`

| Module | Responsibility |
|--------|----------------|
| `videos.py` | Library list, tags, storage stats, get/edit/delete (to the trash), bulk edit and delete, watch progress, redownload, metadata refresh |
| `video_ai.py` | Per-video AI: tags, summary, chapters, chat |
| `video_media.py` | Thumbnails (upload, candidates), sprites, subtitles, Range streaming, signed media token, file download |
| `channels.py` | Channel list/rename/search, catalog index/status/search, channel feed |
| `video_serialize.py` | Shared `VideoRead` serialization + media path resolution |
| `downloads.py` | Queue jobs, presets, progress SSE, pause/resume |
| `preview.py` | Watch-before-download / DASH proxy (uses `stream_preview`) |
| `review.py` | Import queue, folder scan, approve/reject, duplicate groups (on-demand AI score) |
| `playlists.py` | User, imported, and subscribed YouTube playlists (covers, list order); who sees and edits which one is `services/playlists.py` |
| `app_settings.py` | GET/PATCH settings |
| `ai.py` | Status, chat stream, recommend, maintenance enqueue, OpenRouter costs |
| `system.py` | Disk/system stats surfaces for Settings |
| `backgrounds.py` | Custom background uploads |
| `fonts.py` | Custom UI font uploads |

Top-level routes on the app (not under a router module): `GET /api/health`, `GET /api/updates`.

### `services/`

| Area | Modules | Role |
|------|---------|------|
| Downloads | `downloads/` (package: queue, runner, postprocess, finalize, jobs, playlist import), `job_metadata.py`, `ffmpeg_progress.py`, `ytdlp_extract.py`, `ytdlp_formats.py`, `stream_preview.py`, `url_clean.py`, `ytdlp_common.py` | Queue/finalize; cheap-enqueue metadata fill; ffmpeg progress; metadata extract & feed; format presets; in-app DASH/progressive preview; URL clean; POT/cookies/extract gate |
| Library disk | `scanner.py`, `paths.py`, `library.py`, `metadata.py`, `sprites.py` | Scan, paths, probes, sprites |
| Sync / feeds | `metadata_sync.py`, `subtitle_retry.py`, `playlist_sync.py`, `feed_meta_cache.py`, `channel_catalog/` (package), `return_youtube_dislike.py` | Stale metadata, delayed caption retry, subscribed playlist rescan, catalog worker/index/query/skips, caches |
| Settings / updates | `app_settings.py`, `updates.py` | JSON settings, GitHub SHA compare |
| AI | `ai/` (`worker`, `tasks`, `embeddings`, `provider`, `workload`, `chat`, `search`, `recommend`, `duplicates`, `cost_ledger`, `text`) | Queue, providers, RAG, costs |

`channel_catalog/` is a package with façade re-exports: `skips` (members-only leaf), `runtime` (worker), `index`, `query`, `documents` (embedding text).

### Other

| Module | Role |
|--------|------|
| `config.py` | Env-derived constants and tunables |
| `context.py` | `AppContext`, `Paths`, the active-context accessors and the `get_ctx` / `get_session` dependencies (see [Application context](../design/app-context.md)) |
| `database.py` | Engine factory (WAL, busy timeout, foreign keys), `init_db()` |
| `migrations/` | Alembic environment, runner and revisions |
| `legacy_migrations.py` | Frozen pre-Alembic additive migrator, used once to adopt old installs |
| `models.py` | SQLModel tables |

## Lifespan order

From `main.py` `lifespan`:

1. Build an `AppContext` (paths, engine, queues, worker registry), store it on `app.state.ctx`, make it the active context, and create the downloads + data subdirs  
2. `init_db()` — Alembic `upgrade head` (adopting pre-Alembic databases first); refuses a database from a newer version  
3. The context's `WorkerRegistry` and shutdown event are published on `app.state`  
4. Network-filesystem check of `DATA_DIR` (logs an `ERROR` and sets `storage_warning` on `/api/health`)  
5. `cleanup_orphans()` — drop library rows for missing files  
6. `ensure_plugins_loaded()` — load yt-dlp plugins once before workers  
7. `preview.init_preview_client()`  
8. `_start_workers()`: the download queue, ffmpeg queue and reaper are registered, then `download_queue.recover()` (`downloading` → `queued`; restore `download_queue_paused`), `recover_ai_jobs()`, `recover_catalog_jobs()`, then the sprite pool, scanner (watchdog + poller, which runs the first library scan), metadata sync, AI, catalog, autodownload, subtitle retry, job metadata, probe backfill, nightly backup  

On shutdown the shutdown event is set (streams end), every worker is signalled and then joined newest first, and the preview client is closed. See [Workers](workers.md#lifecycle).

## Related

- [Overview](overview.md)
- [Data model](data-model.md)
- [Workers](workers.md)
- [Download pipeline](downloads-pipeline.md)
- [AI pipeline](ai-pipeline.md)

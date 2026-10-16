# Data model

SQLite database at **`DATA_DIR/horde.db`** (`sqlite:///{DB_PATH}`). ORM: SQLModel. The schema is managed with **Alembic** (revisions in `backend/app/migrations/versions`, applied by `init_db()` at startup); foreign keys are enforced. See [SQLite & migrations](../design/sqlite-and-migrations.md).

## Tables

### Library & downloads

| Table | Purpose |
|-------|---------|
| `videos` | Library items: path (unique, relative to downloads), metadata, watch position, review flag, custom title/description flags, yt-dlp `source_chapters`, caption retry (`subtitles_pending`, `subtitles_retry_after`, `subtitles_fetch_attempts`), `youtube_id` (indexed, derived), probed media info (`vcodec`, `acodec`, `codec_string` RFC 6381, `bit_depth`, `is_hdr`, `media_probed_at`), H.264 sidecar (`compat_path`, `compat_size`, `compat_source` = `youtube`\|`transcode`, `compat_error`) |
| `download_jobs` | Queue rows: URL, quality, `video_codec` (playback mode), probed `height_px`, progress, pause, loudnorm, optional replace target, `error` + typed `error_kind` |
| `playlists` | User, imported, or subscribed YouTube playlists (`subscribed`, `quality_preset`, `last_synced_at`, `sync_error`, list `position`, optional `cover_video_id` / `cover_path`) |
| `playlist_items` | Ordered video membership |

### Channel catalogs

| Table | Purpose |
|-------|---------|
| `channel_catalogs` | Per-channel index status, phase, caps, completeness |
| `channel_catalog_videos` | Flat (+ described) upload rows (`catalog_id` + `yt_id` unique) |
| `channel_catalog_skips` | Permanent skips (e.g. members-only) |
| `channel_catalog_embeddings` | Embeddings for catalog videos (recommend / hybrid catalog search) |

### AI

| Table | Purpose |
|-------|---------|
| `video_tags` | Derived tag index (`video_id`, `tag`, `source` = `user`\|`ai`\|`source`), trigger-maintained from `videos.tags` and `video_ai_meta`; see [SQLite and migrations](../design/sqlite-and-migrations.md) |
| `video_embeddings` | Per-video vectors; `chunk_index` **-1** = metadata doc, **0+** = caption chunks |
| `video_ai_meta` | Embed status, summary, AI/user tags, locks, LLM chapters |
| `video_ai_chat` | One chat thread per video |
| `video_ai_chat_messages` | User/assistant turns (+ optional OpenRouter cost/model) |
| `openrouter_usage` | Append-only cost ledger |
| `ai_categories` | Recommendation category chips (name, blurb, embedding) |
| `ai_jobs` | Background job queue (`embed_video`, `enrich_tags`, `refresh_categories`, `embed_catalog_video`, `summarize`, `chapters`) |
| `alembic_version` | Current Alembic revision (`version_num`) |
| `schema_migrations` | Legacy ledger from before Alembic (adopted installs only; unused) |

## Schema lifecycle

```text
init_db():
  fresh database                 -> alembic upgrade head
  tables, no alembic_version     -> legacy additive migrator, then upgrade head
  unknown alembic revision       -> refuse to start (newer app ran here)
  otherwise                      -> backup, then upgrade head if behind
```

Revisions live in `backend/app/migrations/versions/` and are forward-only; a pre-migration copy of `horde.db` is written to `DATA_DIR/backups/`. The legacy `schema_migrations` table is only kept on installs that predate Alembic. Details and the "how to add a migration" recipe: [SQLite & migrations](../design/sqlite-and-migrations.md).

!!! danger "Startup migration errors"
    Do not ignore them. A failed migration rolls back and leaves the database as it was; restore from `DATA_DIR/backups/` or your own backup if needed.

## Related

- [Storage layout](../ops/storage-layout.md)
- [AI pipeline](ai-pipeline.md)
- [Backend](backend.md)

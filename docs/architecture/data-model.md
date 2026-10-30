# Data model

SQLite database at **`DATA_DIR/horde.db`** (`sqlite:///{DB_PATH}`). ORM: SQLModel. The schema is managed with **Alembic** (revisions in `backend/app/migrations/versions`, applied by `init_db()` at startup); foreign keys are enforced. See [SQLite & migrations](../design/sqlite-and-migrations.md).

## Tables

### Library & downloads

| Table | Purpose |
|-------|---------|
| `videos` | Library items: path (unique, relative to downloads), metadata, watch position, review flag, custom title/description flags, yt-dlp `source_chapters`, caption retry (`subtitles_pending`, `subtitles_retry_after`, `subtitles_fetch_attempts`), `youtube_id` (indexed, derived), probed media info (`vcodec`, `acodec`, `codec_string` RFC 6381, `bit_depth`, `is_hdr`, `media_probed_at`), H.264 sidecar (`compat_path`, `compat_size`, `compat_source` = `youtube`\|`transcode`, `compat_error`) |
| `download_jobs` | Queue rows: URL, quality, `video_codec` (playback mode), probed `height_px`, progress, pause, loudnorm, optional replace target, `error` + typed `error_kind` |
| `playlists` | User, imported, or subscribed YouTube playlists (`owner_user_id`, `visibility` public or private, `subscribed`, `quality_preset`, `last_synced_at`, `sync_error`, list `position`, optional `cover_video_id` / `cover_path`) |
| `playlist_items` | Ordered video membership |

### Channel catalogs

| Table | Purpose |
|-------|---------|
| `channel_catalogs` | Per-channel index status, phase, caps, completeness |
| `channel_catalog_videos` | Flat (+ described) upload rows (`catalog_id` + `yt_id` unique) |
| `channel_autodownloads` | Per-channel automatic download policy (enabled, how many earlier uploads, quality preset) |
| `channel_catalog_skips` | Permanent skips: unplayable videos (members-only, age-restricted; hidden from the feed) and videos a user deleted (`reason = deleted`; still listed, only auto-download skips them) |
| `channel_catalog_embeddings` | Embeddings for catalog videos (recommend / hybrid catalog search) |

### AI

| Table | Purpose |
|-------|---------|
| `video_tags` | Derived tag index (`video_id`, `tag`, `source` = `user`\|`ai`\|`source`), trigger-maintained from `videos.tags` and `video_ai_meta`; see [SQLite and migrations](../design/sqlite-and-migrations.md) |
| `video_embeddings` | Per-video vectors; `chunk_index` **-1** = metadata doc, **0+** = caption chunks |
| `video_ai_meta` | Embed status, summary, AI/user tags, locks, LLM chapters |
| `video_ai_chat_messages` | User/assistant turns of one person's chat about a video (`user_id`; + optional OpenRouter cost/model) |
| `openrouter_usage` | Append-only cost ledger |
| `ai_categories` | Recommendation category chips (name, blurb, embedding) |
| `discovery_videos` | YouTube videos the Recommended+ gatherer found outside the library and catalogs (metadata + its own vector); deleted when no hit or stream watch points at them |
| `discovery_hits` | Why a found video is a candidate for one user: `source` (`search`/`related`), `seed` (query or seed YouTube id), `seed_title`, `era` (`recent`/`throwback`), `rank`; forgotten after 21 days |
| `discovery_state` | Per user: when they last opened Recommended+, when the gatherer last ran and was asked to, and what it asked (`asked_json`, for cooldowns) |
| `trash_entries` | One tombstone per deleted video waiting in the [trash](../guides/library.md#trash): the `folder` token its files sit under, the original `video_id`, `youtube_id`, title, relative path, bytes, `trashed_at`, `trashed_by_user_id`, the moved files (`files_json`) and a snapshot of the rows a restore re-inserts (`snapshot_json`). Not tied to `videos` by a foreign key |
| `ai_jobs` | Background job queue (`embed_video`, `enrich_tags`, `refresh_categories`, `embed_catalog_video`, `summarize`, `chapters`) |
| `alembic_version` | Current Alembic revision (`version_num`) |
| `schema_migrations` | Legacy ledger from before Alembic (adopted installs only; unused) |

### Accounts and per-user data

| Table | Purpose |
|-------|---------|
| `users` | Accounts: `username_norm` (unique), scrypt `password_hash`, `is_admin`, `disabled`, `permissions` (JSON list of granted names; admins implicitly have all) |
| `user_stream_state` | Videos a user streamed without downloading (by YouTube id): furthest point, duration, finished; recommendations read it as history |
| `rec_feedback` | What a user told recommendations to leave out: `video`, `channel` or dismissed channel `suggestion` |
| `rec_impressions` | How many separate visits a recommendation was shown on without being watched |
| `user_sessions` | One row per signed-in browser: SHA-256 of the cookie token, `expires_at` (30 days from last use), user agent, address |
| `user_video_state` | **Per-user** watch position and last-watched time, keyed `(user_id, video_id)`. Read and written only through `services/user_state.py` |
| `user_settings` | **Per-user** UI preferences (`ui_json`); server-wide settings stay in `app_settings.json` |
| `youtube_watch_events` | **Per-user** YouTube views imported from Google Takeout: `yt_id`, `watched_at`, title and channel as exported; unique `(user_id, yt_id, watched_at)` so re-imports add only new views. Never part of History ([YouTube history](../guides/youtube-history.md), [ADR 0020](../adr/0020-youtube-history-from-takeout.md)) |

`user_sessions`, `user_video_state`, `user_settings`, `youtube_watch_events` and `video_ai_chat_messages.user_id` reference `users` with `ON DELETE CASCADE`, so deleting a person removes their sessions, history, preferences and chats and leaves the videos. The legacy `videos.last_position_sec` / `last_watched_at` columns are unused; the first admin adopts them. Which data is shared and which is per user is summarised in the [architecture map](../design/architecture.md#data-model-and-ownership).

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

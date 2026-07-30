# Data model

SQLite database at **`DATA_DIR/horde.db`** (`sqlite:///{DB_PATH}`). ORM: SQLModel. There is **no Alembic** — schema evolves via `create_all` plus additive `ALTER TABLE` migrations and a startup `verify_schema()` check. See [SQLite & migrations](../design/sqlite-and-migrations.md).

## Tables

### Library & downloads

| Table | Purpose |
|-------|---------|
| `videos` | Library items: path (unique, relative to downloads), metadata, watch position, review flag, custom title/description flags |
| `download_jobs` | Queue rows: URL, quality, progress, pause, loudnorm, optional replace target |
| `playlists` | User or YouTube-imported playlists |
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
| `video_embeddings` | Per-video vectors; `chunk_index` **-1** = metadata doc, **0+** = caption chunks |
| `video_ai_meta` | Embed status, summary, AI/user tags, locks |
| `video_ai_chat` | One chat thread per video |
| `video_ai_chat_messages` | User/assistant turns (+ optional OpenRouter cost/model) |
| `openrouter_usage` | Append-only cost ledger |
| `ai_categories` | Recommendation category chips (name, blurb, embedding) |
| `ai_jobs` | Background job queue (`embed_video`, `enrich_tags`, …) |

## Schema lifecycle

```text
init_db():
  import models
  SQLModel.metadata.create_all(engine)   # new tables
  _migrate_columns()                     # ALTER TABLE ADD COLUMN if missing
  verify_schema()                        # fail fast if still incomplete
```

Migrations are **additive only** (new nullable/defaulted columns). Destructive changes require manual DB surgery or a fresh `horde.db`.

!!! danger "Missing columns"
    If `verify_schema` raises, fix the DB (or delete `data/horde.db` to start empty) and restart. Do not ignore startup migration errors.

## Related

- [Storage layout](../ops/storage-layout.md)
- [AI pipeline](ai-pipeline.md)
- [Backend](backend.md)

# SQLite and migrations

Horde uses **SQLite** as its only application database (typically `data/horde.db`). The schema is managed with **Alembic** (batch mode for SQLite), applied automatically at startup. There is no Alembic CLI step in production: `init_db()` calls it programmatically.

## Why SQLite

The product is a [small-group](no-auth.md), single-instance homelab app:

- One writer process (the FastAPI / worker container)
- Modest library sizes compared to multi-tenant SaaS
- Zero external database to provision on TrueNAS / Dockge
- Easy backup: copy the data volume (see [Backup & restore](../ops/backup-restore.md))

Postgres or MySQL would add operational surface area without matching the threat or scale model.

!!! warning "One instance per database file"
    Do not point multiple Horde containers at the same SQLite file over NFS. Stick to one runtime and a local or properly locked volume.

## WAL, foreign keys and concurrency

Every connection sets `journal_mode=WAL`, `synchronous=NORMAL`, a **15s busy timeout** and **`foreign_keys=ON`**. WAL lets the API, scanner, downloads, and the single-flight AI worker overlap reads with a writer.

Nested Sessions still cannot hold two uncommitted **writes** at once. OpenRouter usage is recorded on its own Session after each API call, so job runners commit (or avoid flushing deletes) **before** that HTTP call. Otherwise SQLite raises `database is locked` on `INSERT INTO openrouter_usage` and the AI job fails even though the model call succeeded.

WAL also creates `horde.db-wal` / `horde.db-shm` beside `horde.db`. Copy the whole `DATA_PATH` directory — not just `horde.db` — when backing up a running instance.

## Integrity rules

Foreign keys are enforced, and each one declares its `ON DELETE` behaviour in `backend/app/models.py`:

| Behaviour | Tables |
|-----------|--------|
| `CASCADE` | `playlist_items`, `video_embeddings`, `video_ai_meta`, `video_ai_chat`, `video_ai_chat_messages`, `ai_jobs` (both FKs) → `videos` / `playlists`; `channel_catalog_videos`, `channel_catalog_skips` → `channel_catalogs`; `channel_catalog_embeddings` → `channel_catalog_videos` |
| `SET NULL` | `download_jobs.video_id` / `replace_video_id` / `playlist_id`, `openrouter_usage.video_id`, `playlists.cover_video_id` (history and soft pointers outlive their target) |

Tables whose ids are referenced elsewhere (`videos`, `playlists`, `download_jobs`, `channel_catalogs`, `channel_catalog_videos`, `ai_jobs`) use `AUTOINCREMENT`, so a deleted id is never reissued to an unrelated row. `playlist_items` has a unique `(playlist_id, video_id)`.

Video deletion goes through one service, `services/video_delete.delete_video_cascade`. It deletes dependent rows explicitly (in addition to the FK cascades), commits, and only then removes thumbnails, sprites, the compat sidecar, subtitles and (when requested) the media file. File removal is restricted to paths that resolve inside `DOWNLOADS_DIR` or `DATA_DIR`. A delete the user asks for with the file goes through `services/trash.trash_video` instead, which moves those files into the trash, writes a `trash_entries` tombstone and then runs this same cascade ([ADR 0013](../adr/0013-trash-tombstones.md)).

## Startup algorithm

`init_db()` → `app/migrations/runner.py::upgrade_database()`:

1. **Fresh database** (no tables): `alembic upgrade head`.
2. **Existing install without `alembic_version`** (everything created before Alembic): a pre-migration backup is written, the frozen legacy additive migrator (`app/legacy_migrations.py`) runs, then `upgrade head`. The baseline revision skips tables that already exist, which adopts the legacy schema as `0001_baseline`.
3. **`alembic_version` names a revision this code does not know** (a newer Horde migrated the database and the app was then rolled back): startup **refuses** with `SchemaTooNewError`. The message tells you to update Horde again, or to roll back with `update.sh --rollback` / restore a database backup.
4. **Otherwise**: if the database is behind, a backup is taken and `upgrade head` runs; if it is at head nothing happens.

After every branch, including "already at head", an **integrity check** runs `PRAGMA foreign_key_check`. Code that never turns `foreign_keys` on (an older Horde after a rollback, the `sqlite3` shell) can delete a video and leave its children behind. Those rows are repaired the way `ON DELETE` would have done it (CASCADE children deleted, SET NULL pointers cleared), with a warning per table and count, and the legacy `video_ai_chat` table such code recreates is dropped again. A database that is behind head gets the same row repair before its revisions run, because the migration refuses to commit over violations.

The whole migration runs in one transaction with `PRAGMA foreign_keys=OFF` for its duration (SQLite batch operations rebuild tables, and a `DROP TABLE` with FKs on would cascade into child rows). `PRAGMA foreign_key_check` runs before commit and aborts the migration on any violation. A failing revision rolls back and leaves the database exactly as it was.

### Backups

Before any pending migration on a non-empty database, `DATA_DIR/backups/horde-pre-<from>-to-<to>-<timestamp>.db` is written with SQLite's online backup API, and `horde-pre-integrity-repair-<timestamp>.db` before a start at head repairs foreign key orphans or drops the legacy `video_ai_chat` table (a clean start writes nothing). The newest five of these copies are kept, whatever their label. Migrations are **forward-only**: `downgrade()` raises. To go back, stop Horde, restore `horde.db` from one of these copies (or your own backup) and start the older version. Keep your own off-box backups too; see [Backup & restore](../ops/backup-restore.md).

## Adding a migration

```bash
cd backend
export DATA_DIR=$(mktemp -d) DOWNLOADS_DIR=$(mktemp -d)
alembic upgrade head                              # scratch DB at the current head
# edit app/models.py
alembic revision --autogenerate -m "add widget table" --rev-id 0003_widgets
```

Then review and edit `backend/app/migrations/versions/0003_widgets.py`:

- Use a descriptive, ordered `--rev-id` (`0003_widgets`); the filename is the id.
- Autogenerate misses data fixes, renames and server defaults: write those by hand.
- Prefer `op.batch_alter_table(...)` for anything that changes an existing table (SQLite rebuilds it). Name foreign keys explicitly and declare `ondelete`.
- Create indexes with `if_not_exists=True` when an older install may already have them.
- Repair existing rows first (delete orphans, backfill NULLs) when a new constraint could reject them.
- Do not import application models into a revision; a migration describes the schema as it was then.

`tests/test_database_migrate.py` asserts that `upgrade head` on an empty database has **zero differences** from `SQLModel.metadata` (alembic `compare_metadata`). If you change `models.py` without a revision, CI fails and prints the missing operations. It also upgrades a pre-Alembic database snapshot (`tests/fixtures/pre_alembic_schema.sql`) with old-style rows and checks that the data survives.

## Revisions

| Revision | What it does |
|----------|--------------|
| `0001_baseline` | The schema as it stood when Alembic was adopted (tables only created if missing) |
| `0002_integrity` | Foreign keys with `ON DELETE`, `AUTOINCREMENT`, unique playlist items, all declared indexes (`IF NOT EXISTS`), orphan repair |
| `0003_auth` | `users`, `user_sessions`, `user_video_state`, `user_settings` (accounts and per-user history; no rows, the first admin is created at runtime) |
| `0004_permissions_chat` | Member permissions; chat messages belong to a user |
| `0005_tags_search` | `video_tags`, the `videos_fts` full-text index, `videos.youtube_id` (all backfilled from existing rows) |
| `0006_video_tags_delete` | `AFTER DELETE ON videos` trigger that clears the video's `video_tags` rows even on a connection without `foreign_keys` |
| `0007_channel_follows` | `channel_follows` table (per-user followed channels, with unfollow tombstones) and `download_requesters` (who queued a download job) |
| `0008_stream_ai` | `stream_ai_state` and `stream_ai_chat_messages`: AI results of streamed videos, kept per YouTube id until downloaded or expired ([ADR 0010](../adr/0010-stream-ai-retention.md)) |
| `0010_trash` | `trash_entries`: one tombstone per video a user deleted, with the rows a restore needs, the list of files moved to the trash and the random `folder` token they sit under ([ADR 0013](../adr/0013-trash-tombstones.md)). A new table only; `videos` is not rebuilt |
| `0011_playlist_owner` | `playlists.owner_user_id` (FK `users`, CASCADE) and `playlists.visibility` (`public` / `private`). Existing playlists become public and the first enabled administrator's (NULL when there is none yet; that administrator adopts them when created). `playlists` is rebuilt, which is safe because the runner has `foreign_keys` off ([ADR 0014](../adr/0014-playlist-ownership-and-visibility.md)) |

The legacy `schema_migrations` ledger table is left in place on adopted installs and ignored by Alembic.

## Derived tables and indexes

Three things exist so reads do not scan the whole `videos` table. All are derived from columns the application already writes, so no writer has to remember them.

- **`video_tags(video_id, tag, source)`** with `ON DELETE CASCADE` and an index on `tag` (case-insensitive). `videos.tags` (a JSON list) stays the column the application reads and writes, because it keeps order and exact spelling and is what the API returns. SQLite triggers rebuild a video's rows whenever `videos.tags` or `video_ai_meta.ai_tags` / `user_tags` change, or the metadata row is deleted (its tags become `source` again), and `trg_videos_tags_delete` (revision `0006`) clears a deleted video's rows even when the deleting connection has foreign keys off. Nine triggers exist at head (`trg_videos_tags_*`, `trg_ai_meta_tags_*`, `trg_videos_fts_*`); a test pins the exact set. `source` is `user` when the tag is in `user_tags`, `ai` when it is in `ai_tags`, otherwise `source` (collected from the platform). The tag filter, `all_tags`, `tag_stats` and the related-videos tag overlap query this table. A malformed or non-list `tags` value yields no rows instead of failing the write. Tags that differ only in case (`Cats` / `cats`) are one tag in `all_tags` and `tag_stats`.
- **`videos_fts`**, an FTS5 table over `title`, `description`, `notes`, `channel` and a flattened `tags` (rowid = `videos.id`), also trigger-maintained. Query words are runs of Unicode letters and digits, and FTS5 folds diacritics, so `cafe` finds `Café`. Keyword search sends each query token, with its light inflections, as quoted FTS5 terms joined by `AND`, so user input is never interpreted as FTS5 syntax. A query with no word characters (`%`) and a SQLite build without FTS5 (the revision then skips the index) use the REGEXP scan, which escapes the query, so `%` and `_` are never wildcards.
- **`videos.youtube_id`** (indexed), derived from `source_url` or the `[id]` token in `file_path` by a mapper listener whenever a `Video` row is inserted or updated. `find_video_by_youtube_id` and `youtube_library_map` use it.

!!! warning "Restoring onto a SQLite without FTS5"
    The `videos` triggers write to `videos_fts`. A database created with FTS5 and then restored onto a SQLite build that lacks the module fails every write to `videos` ("no such module: fts5"). Use the same container image, or one whose SQLite has FTS5 (all official images do), to restore.

!!! warning "Revisions that rebuild `videos`"
    The triggers belong to the `videos` and `video_ai_meta` tables. A later revision that rebuilds one of them with `batch_alter_table` (drop and rename) drops its triggers and must recreate them, and `videos_fts` must be refilled. The FTS5 shadow tables (`videos_fts_*`) are ignored by the drift test.

`UtcDateTime` (`app/db_types.py`) is the column type for new timestamp columns: timezone-aware UTC in Python, stored exactly like `DateTime`. The existing `DateTime` columns are not converted yet; readers keep using `as_utc()`.

## Settings file durability

Server settings are JSON (`DATA_DIR/app_settings.json`), not SQL rows — see [Settings split](settings-split.md). The file is written atomically (temp file in the same directory, `fsync`, `os.replace`, directory `fsync`, mode `0600`) and the previous good version is kept as `app_settings.json.bak`. A file that fails to parse is logged at ERROR, preserved as `app_settings.json.corrupt-<timestamp>` and restored from the `.bak`; if there is no usable backup, saving is refused (instead of overwriting the file with defaults) until the file is fixed or removed.

## What is not in the DB

- Media binaries live under `DOWNLOADS_DIR`
- Thumbnails and similar assets live under the data directory beside the DB

## Related

- [Data model](../architecture/data-model.md)
- [Backup & restore](../ops/backup-restore.md)
- [Single container](single-container.md)

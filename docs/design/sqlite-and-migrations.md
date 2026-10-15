# SQLite and migrations

Horde uses **SQLite** as its only application database (typically `data/horde.db`). The schema is managed with **Alembic** (batch mode for SQLite), applied automatically at startup. There is no Alembic CLI step in production: `init_db()` calls it programmatically.

## Why SQLite

The product is a [single-admin](no-auth.md), single-instance homelab app:

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

Video deletion goes through one service, `services/video_delete.delete_video_cascade`. It deletes dependent rows explicitly (in addition to the FK cascades), commits, and only then removes thumbnails, sprites, the compat sidecar, subtitles and (when requested) the media file. File removal is restricted to paths that resolve inside `DOWNLOADS_DIR` or `DATA_DIR`.

## Startup algorithm

`init_db()` → `app/migrations/runner.py::upgrade_database()`:

1. **Fresh database** (no tables): `alembic upgrade head`.
2. **Existing install without `alembic_version`** (everything created before Alembic): a pre-migration backup is written, the frozen legacy additive migrator (`app/legacy_migrations.py`) runs, then `upgrade head`. The baseline revision skips tables that already exist, which adopts the legacy schema as `0001_baseline`.
3. **`alembic_version` names a revision this code does not know** (a newer Horde migrated the database and the app was then rolled back): startup **refuses** with `SchemaTooNewError`. The message tells you to update Horde again, or to roll back with `update.sh --rollback` / restore a database backup.
4. **Otherwise**: if the database is behind, a backup is taken and `upgrade head` runs; if it is at head nothing happens.

The whole migration runs in one transaction with `PRAGMA foreign_keys=OFF` for its duration (SQLite batch operations rebuild tables, and a `DROP TABLE` with FKs on would cascade into child rows). `PRAGMA foreign_key_check` runs before commit and aborts the migration on any violation. A failing revision rolls back and leaves the database exactly as it was.

### Backups

Before any pending migration on a non-empty database, `DATA_DIR/backups/horde-pre-<from>-to-<to>-<timestamp>.db` is written with SQLite's online backup API (the newest five are kept). Migrations are **forward-only**: `downgrade()` raises. To go back, stop Horde, restore `horde.db` from one of these copies (or your own backup) and start the older version. Keep your own off-box backups too; see [Backup & restore](../ops/backup-restore.md).

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

The legacy `schema_migrations` ledger table is left in place on adopted installs and ignored by Alembic.

## Settings file durability

Server settings are JSON (`DATA_DIR/app_settings.json`), not SQL rows — see [Settings split](settings-split.md). The file is written atomically (temp file in the same directory, `fsync`, `os.replace`, directory `fsync`, mode `0600`) and the previous good version is kept as `app_settings.json.bak`. A file that fails to parse is logged at ERROR, preserved as `app_settings.json.corrupt-<timestamp>` and restored from the `.bak`; if there is no usable backup, saving is refused (instead of overwriting the file with defaults) until the file is fixed or removed.

## What is not in the DB

- Media binaries live under `DOWNLOADS_DIR`
- Thumbnails and similar assets live under the data directory beside the DB

## Related

- [Data model](../architecture/data-model.md)
- [Backup & restore](../ops/backup-restore.md)
- [Single container](single-container.md)

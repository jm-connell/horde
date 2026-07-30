# SQLite and migrations

Horde uses **SQLite** as its only application database (typically `data/horde.db`). There is **no Alembic** (or other migration runner). Schema evolution is additive and verified at startup.

## Why SQLite

The product is a [single-admin](no-auth.md), single-instance homelab app:

- One writer process (the FastAPI / worker container)
- Modest library sizes compared to multi-tenant SaaS
- Zero external database to provision on TrueNAS / Dockge
- Easy backup: copy the data volume (see [Backup & restore](../ops/backup-restore.md))

Postgres or MySQL would add operational surface area without matching the threat or scale model.

!!! warning "One instance per database file"
    Do not point multiple Horde containers at the same SQLite file over NFS. Stick to one runtime and a local or properly locked volume.

## Additive `ALTER TABLE`

On startup, `init_db()`:

1. Imports models and runs `SQLModel.metadata.create_all` (new tables)
2. Ensures a **`schema_migrations`** ledger table exists
3. Runs any **pending versioned steps** from `MIGRATION_STEPS` in [`backend/app/database.py`](../../backend/app/database.py)
4. Re-applies the idempotent **extra column** lists (safe `ALTER TABLE … ADD COLUMN` for any still-missing fields)
5. Calls `verify_schema()`

Columns added after the initial schema live in lists such as `_VIDEO_COLUMNS`, `_DOWNLOAD_JOB_COLUMNS`, AI meta/chat/job columns, and so on inside `backend/app/database.py`. New additive features usually append to those lists; the ledger step `2026_07_additive_columns` records that the additive pass exists, and the lists themselves remain the source of truth for *which* columns to add.

There is no automated path for **renaming**, **dropping**, or **type-changing** columns via ALTER alone. For a future breaking change, add a new numbered entry to `MIGRATION_STEPS` whose Python function copies/transforms data, then records the step id — still manual and reviewed, but no longer “ALTER forever with no ledger.”

## `schema_migrations` ledger

| Column | Role |
|--------|------|
| `id` | Stable step id (e.g. `2026_07_additive_columns`) |
| `applied_at` | UTC ISO timestamp when the step first ran |

`applied_migrations()` returns ledger ids in order for tests and diagnostics. Do **not** introduce Alembic for this single-admin SQLite app.

## `verify_schema`

After migrations, `verify_schema()` inspects each tracked table and **raises at startup** if any expected added column is still missing. That fails fast instead of serving a half-migrated app that crashes on the first query using a new field.

If verification fails, the usual recovery is: fix permissions / disk, restart so migrations can run, or restore from backup / start fresh with an empty `horde.db` (you will lose library metadata — media files on the downloads volume are separate).

## What is not in the DB

- Media binaries live under `DOWNLOADS_DIR`
- Thumbnails and similar assets live under the data directory beside the DB
- Server settings (UI blob + AI keys) are JSON in app settings storage, not scattered SQL rows for every preference — see [Settings split](settings-split.md)

## Related

- [Data model](../architecture/data-model.md)
- [Backup & restore](../ops/backup-restore.md)
- [Single container](single-container.md)

# 0001. SQLite with WAL, Alembic, batch mode and a frozen legacy migrator

Status: Accepted

## Context

Horde is a self-hosted app for one household, deployed as a single container on a NAS ([single container](../design/single-container.md)). A separate database server is operational surface the audience does not want, and backup should be "copy a folder". Early versions created tables with `create_all` plus a hand-written additive migrator, so there was no record of which schema a database had, no way to express a data fix or a constraint change, and no protection against an older build opening a newer database. Real databases with years of data already existed.

SQLite cannot alter most constraints in place; changing a column or a foreign key means rebuilding the table.

## Decision

- **SQLite is the only application database**, one file at `DATA_DIR/horde.db`. Every connection sets `journal_mode=WAL`, `synchronous=NORMAL`, a 15 second busy timeout and `foreign_keys=ON` (`app/database.py`). WAL lets the API, scanner, downloads and the AI worker read while one writes. The data directory must be a local disk, never SMB or NFS.
- **Alembic owns the schema.** Revisions live in `backend/app/migrations/versions/` and `init_db()` upgrades to head at startup, programmatically; there is no CLI step in production. Revisions run in **batch mode** (`op.batch_alter_table`) so SQLite can rebuild tables, with `foreign_keys` off for the duration of the migration, a `foreign_key_check` before commit, and one transaction so a failing revision leaves the database untouched.
- **Existing installs are adopted, not rebuilt.** A database with tables but no `alembic_version` is first brought to the old shape by the **frozen** `app/legacy_migrations.py` (never edited again), then `upgrade head` runs; its `0001_baseline` revision only creates tables that are missing, which adopts the legacy schema.
- **Startup refuses a database from the future.** If `alembic_version` names a revision this code does not know, startup raises `SchemaTooNewError` instead of running against a schema it does not understand.
- **Forward-only.** `downgrade()` raises. Before any pending migration on a non-empty database a copy is written to `DATA_DIR/backups/` with SQLite's online backup API (the newest five are kept); going back means restoring one of those ([ADR 0008](0008-releases-and-rollback.md) automates it for `update.sh`).
- **Drift is a test failure.** `tests/test_database_migrate.py` compares `upgrade head` on an empty database with `SQLModel.metadata` and fails on any difference, and upgrades a pre-Alembic snapshot with data in it.

## Consequences

- One writer at a time: write transactions must be short, nested sessions must not both hold uncommitted writes (the OpenRouter ledger commits on its own session after the HTTP call), and a process is the unit of deployment. This matches [ADR 0002](0002-single-process-worker-threads.md).
- Backup is a copy of `DATA_DIR`, including `-wal` and `-shm`; the pre-migration copy and the `update.sh` backup use SQLite's online backup API and the nightly backup uses `VACUUM INTO`, so all of them are consistent while Horde runs.
- Every schema change costs an Alembic revision, reviewed by hand (autogenerate misses data fixes and defaults). An existing revision is never edited.
- Rolling the application back across a migration is not possible without restoring a database backup. That is deliberate: a silent downgrade of a schema is worse than a refusal.
- Derived structures built with raw SQL (triggers, FTS5 virtual tables) are invisible to autogenerate and need explicit handling; see [ADR 0007](0007-fts5-triggers-and-vector-index.md).
- Moving to a server database would be a rewrite of the deployment story, not a config switch. The scale model (one library, a handful of users) does not call for it.

Detail: [SQLite and migrations](../design/sqlite-and-migrations.md).

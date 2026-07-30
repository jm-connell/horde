# Backup & restore

!!! tip "In the app"
    **Settings → System → Backup** summarizes what to back up and links this page at `/wiki/ops/backup-restore/` when the wiki is bundled.

## What to back up

Back up both volume roots used by Compose (or your local dirs):

| Host path | In-container | Contents |
|-----------|--------------|----------|
| `DOWNLOADS_PATH` | `DOWNLOADS_DIR` (`/downloads`) | Media library, imports, subtitle sidecars |
| `DATA_PATH` | `DATA_DIR` (`/app/data`) | `horde.db`, settings, caches, user fonts/backgrounds |

A consistent snapshot of **both** keeps file paths and DB rows aligned. Backing up only the DB without media leaves broken library entries; media without the DB loses titles, tags, progress, playlists, and AI meta.

!!! tip "Stop or quiesce"
    Prefer stopping Horde (or at least pausing downloads/AI) briefly so SQLite and in-flight `.part` files are quiet. For ZFS/TrueNAS, a dataset snapshot of both mounts is ideal.

## Regenerable (safe to omit or delete)

These can be rebuilt after restore:

| Data | How it comes back |
|------|-------------------|
| **Thumbnails** (`data/thumbnails/`) | Regenerated from media / source metadata |
| **Sprites** (`data/sprites/`) | Regenerated for seek previews |
| **Embeddings** (rows in `horde.db`) | AI **reindex** / embed jobs after providers are online |

Also regenerable: `feed_meta_cache.json` (refills as you browse channel feeds).

Not regenerable without re-download or re-entry: video files, custom titles/notes, playlists, watch history, OpenRouter usage ledger, uploaded fonts/backgrounds.

## Restore checklist

1. Restore `DATA_PATH` and `DOWNLOADS_PATH` to the mounts Compose expects.
2. Confirm `PUID`/`PGID` can read/write both trees ([permissions](troubleshooting.md)).
3. Start Horde; orphan cleanup runs on startup for missing files.
4. If you wiped embeddings or changed models, run AI maintenance reindex ([Maintenance](maintenance.md)).
5. Confirm `/api/health` and open the library.

## Related

- [Storage layout](storage-layout.md)
- [Environment variables](environment.md)
- [Maintenance](maintenance.md)

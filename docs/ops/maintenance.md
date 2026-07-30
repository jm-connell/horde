# Maintenance

Routine upkeep lives mostly under **Settings → AI** (jobs) and **Settings → System**, plus automatic work on startup.

## AI jobs

Use the AI process / queue controls to:

| Action | Effect |
|--------|--------|
| **Rebuild / reindex embeds** | Queue `embed_video` for missing, stale, or wrong-model indexes (e.g. after embed model change) |
| **Re-tag** | Queue `enrich_tags` for videos that still need AI tags |
| **Refresh categories** | Queue `refresh_categories` to rebuild recommendation category shelves |

The AI worker is [single-flight](../design/single-flight-ai.md): one job at a time, up to 3 attempts with backoff. Pause the queue before heavy maintenance if you need the GPU for something else.

!!! note "Duplicate scoring"
    Library duplicate **LLM** scoring is on-demand from the Import/review API — not the queued `score_duplicates` job (that kind is a no-op placeholder). See [AI pipeline](../architecture/ai-pipeline.md).

## Metadata resync

A background sync worker refreshes stale source metadata (titles, descriptions, view counts, etc.) for videos that still have a `source_url`.

- Interval comes from Settings (`metadata_sync_interval_hours`, default often 24h).
- Each wake processes a **batch of 20** stale rows, then sleeps until the next interval.
- Custom titles/descriptions (`title_is_custom` / `description_is_custom`) are respected so user edits are not overwritten.

You can trigger related catalog freshness via channel catalog settings; the sync loop also refreshes stale catalogs when enabled.

## Catalog reindex

Channel catalogs index YouTube channels in phases (`flat` → `descriptions` → `embed`), one catalog at a time. From Settings / Channels UI you can re-queue a catalog if the index is incomplete, errored, or you raised the max-video cap.

See [Channels](../guides/channels.md) and [Workers](../architecture/workers.md).

## Orphan cleanup (startup)

On every boot, after `init_db()`, Horde runs **orphan cleanup**: library rows whose files no longer exist under `DOWNLOADS_DIR` are removed (or reconciled) so the UI does not show dead cards.

The downloads-tree [scanner](../architecture/workers.md) continues to pick up new files and may flag orphans during poll cycles as well.

## Related

- [AI setup](ai-setup.md)
- [Troubleshooting](troubleshooting.md)
- [Backup & restore](backup-restore.md)

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
    Library duplicate **LLM** scoring is on-demand from the Import/review API. See [AI pipeline](../architecture/ai-pipeline.md).

## Metadata resync

A background sync worker refreshes stale source metadata (titles, descriptions, view counts, etc.) for videos that still have a `source_url`.

- Interval comes from Settings (`metadata_sync_interval_hours`, default often 24h).
- Each wake processes a **batch of 20** stale rows, then sleeps until the next interval.
- Custom titles/descriptions (`title_is_custom` / `description_is_custom`) are respected so user edits are not overwritten.
- Redownload / replace-in-place also preserves custom title, description, notes, and locked tags while refreshing `source_title` / `source_description`.

You can trigger related catalog freshness via channel catalog settings; the sync loop also refreshes stale catalogs when enabled.

## Catalog reindex

Channel catalogs index YouTube channels in phases (`flat` → `descriptions` → `embed`), one catalog at a time. From Settings / Channels UI you can re-queue a catalog if the index is incomplete, errored, or you raised the max-video cap.

See [Channels](../guides/channels.md) and [Workers](../architecture/workers.md).

## Orphan cleanup (startup)

On every boot, after `init_db()`, Horde runs **orphan cleanup**: library rows whose files no longer exist under `DOWNLOADS_DIR` are removed (or reconciled) so the UI does not show dead cards.

The downloads-tree [scanner](../architecture/workers.md) continues to pick up new files and may flag orphans during poll cycles as well.

## Bumping yt-dlp

Horde pins an exact yt-dlp version in `backend/requirements.txt` (for example `yt-dlp==2026.8.19`). The Docker image installs that pin at build time — the container does **not** auto-upgrade yt-dlp on start.

When YouTube breaks extractors (format errors, bot checks that a newer yt-dlp already fixed, etc.):

1. Edit the `yt-dlp==…` pin in `backend/requirements.txt` to the version you want (check [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases)).
2. Keep `bgutil-ytdlp-pot-provider` aligned with the Compose `bgutil-pot` image tag when that plugin needs a matching bump ([YouTube access](youtube-access.md)).
3. Rebuild and recreate via [`update.sh`](../getting-started/updating.md) (or Compose with `HORDE_GIT_SHA`).
4. Smoke-test: Settings → System (or `GET /api/health`) shows the new `yt_dlp_version`, then paste a short URL and download.

Mention the bump in the commit or PR message when extractors were the reason (“bump yt-dlp for YouTube extractor fix”). For day-to-day app updates, a normal rebuild already picks up whatever pin is in the tree.

Local development: reinstall the venv deps after changing the pin (`pip install -r backend/requirements.txt`), or let `./start.sh` reinstall when `requirements.txt` is newer than its stamp.

## Related

- [Updating](../getting-started/updating.md)
- [YouTube access](youtube-access.md)
- [AI setup](ai-setup.md)
- [Troubleshooting](troubleshooting.md)
- [Backup & restore](backup-restore.md)

# System

Controls under **Settings → System** (`?tab=system`). This tab is mostly **status and actions** — it does not own many persisted preference keys (catalog/AI pause reuse settings from [Library](library.md) and [AI](ai.md)).

## Update notice

When GitHub reports a newer commit than this install:

- Banner shows current → latest short SHAs
- **How to update** — TrueNAS/Dockge `bash update.sh` guidance, hard-refresh tip, link to the latest commit
- **Check again** / **Dismiss** — dismiss stores the SHA in `localStorage` (`horde.settings.updateDismissedSha`) so the same version stays quiet

See also [Updating](../getting-started/updating.md).

## Documentation

When the wiki is bundled (`health.wiki_available`):

| Link | URL | Contents |
|------|-----|----------|
| Open wiki | `/wiki/` on this Horde host | This MkDocs site (product docs) |
| API (Swagger) | `/docs` on this Horde host | Interactive OpenAPI / Swagger UI |

!!! note "Two different `/docs`"
    In the running app, **`/docs`** is the FastAPI Swagger UI. The product wiki is **`/wiki/`**. This markdown tree is what MkDocs builds into `/wiki/`.

## Status

Health snapshot from `GET /api/health`:

| Row | Source |
|-----|--------|
| Horde | `horde_version` (+ update available / up to date when the update check succeeds) |
| yt-dlp | `yt_dlp_version` |
| PO token provider | Connected / version, or error detail |
| Ollama | Disabled / Ready / Connected / Offline — shows `ollama.last_error` when not Ready |
| OpenRouter | Disabled / Configured / No API key |
| Cookies | Configured / Not configured (`youtube.cookies_configured`) |
| Library | Video count and library size (same figures as Storage above) |
| Pending import | Review queue depth |
| Active downloads | Count + **paused** when the download queue is paused |
| AI queue | Depth (+ running / failed counts, blocked reason) from `workers` |
| Catalog queue | Depth (+ indexing) from `workers` |
| Last extract failure | Kind + message from `youtube.last_extract_failure` (when set) |
| Disk free | Free / total bytes on the media volume |

See [Troubleshooting](../ops/troubleshooting.md) for `error_kind` values and restart recovery.

## Storage

Library footprint: total bytes used by videos + video count.

## Backup

Guidance for host volumes (not an in-app dump):

- Back up **DATA** (`horde.db`, settings, caches) and **DOWNLOADS** (media) together
- Prefer stopping Horde briefly or a ZFS/TrueNAS snapshot of both mounts
- Thumbnails, sprites, and embeddings are regenerable after restore

Deep link from Settings: `/wiki/ops/backup-restore/` when the wiki is bundled. Full checklist: [Backup & restore](../ops/backup-restore.md).

## Resources

Horde **host** CPU, RAM, and GPU (NVIDIA / AMD / Intel when detectable).

!!! tip
    AI workload sizing uses the **Ollama** machine instead — configure VRAM under [AI → Providers](ai.md#local-ollama).

## Background activity

Live and recent jobs (ffmpeg, downloads, AI, catalog indexing, folder scans). **Recent activity** keeps about eight rows visible and scrolls through the last 50 finished jobs.

Also shown:

1. **Channel catalog** — queue depth, current channel/phase, errors. Actions:
    - **Refresh catalogs** — incremental: new channels + new uploads on ready catalogs
    - **Full reindex…** — re-walk every channel up to `channel_catalog_max_videos` (can take a long time)
2. **AI** — compact queue status with pause/resume (`ai.paused`). **Index missing** appears when search-index coverage is incomplete and the queue is idle. **Ollama GPU** (and Horde host GPU util/temp) only appear when local Ollama is actually in use. When OpenRouter is the active backend, those rows are replaced by **OpenRouter** (model + LLM vs all-tasks) and **Spend** (24h / 7-day totals, weekly budget if set, 24h call count).
3. **Metadata sync** — shown while a Library resync is running (done/failed/total + current title)

Catalog indexing only appears when `channel_catalog_enabled` is on ([Library](library.md#channel-catalog)).

## See also

- [Settings overview](index.md)
- [Library](library.md) — metadata resync, catalog caps
- [AI](ai.md) — providers and jobs
- [Troubleshooting](../ops/troubleshooting.md)
- [All settings](all-settings.md)

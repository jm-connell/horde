# Troubleshooting

## Bot checks / YouTube blocks

**Symptoms:** downloads fail with bot, PO token, or “sign in” style errors; previews hang; feed cards never load metadata. Download cards may show a typed label such as **Bot check**, **PO token**, or **Cookies / login** (`error_kind` on the job).

**Checks:**

1. Is `bgutil-pot` running? Health → `pot_provider` should be `ok` (`GET /api/health`).
2. `YTDLP_POT_BASE_URL` reachable from the Horde container (`http://bgutil-pot:4416` in Compose).
3. Add [cookies](youtube-access.md) if POT alone is not enough — Status also shows whether cookies are configured.
4. Reduce bursty browsing — extracts are already serialized (1.25s spacing); avoid restarting jobs in a tight loop.
5. Update the image / yt-dlp — extractor breakage is common when YouTube changes. Horde pins yt-dlp in `backend/requirements.txt`; see [Bumping yt-dlp](maintenance.md#bumping-yt-dlp).
6. Settings → System → Status → **Last extract failure** shows the most recent classified extract error (`youtube.last_extract_failure` on `/api/health`).

### Download `error_kind` values

| Kind | Meaning |
|------|---------|
| `bot` | YouTube bot check |
| `pot` | PO token / player challenge |
| `cookies` | Login / age gate / private needing cookies |
| `members` | Members-only |
| `rate_limit` | HTTP 429 / temporary block |
| `unavailable` | Removed, geo, no formats |
| `postprocess` | Merge / subtitles / ffmpeg salvage failed |
| `cancelled` | User cancel |
| `unknown` | Unclassified yt-dlp message |

## Restart recovery

On process start Horde:

1. Requeues download jobs left in `downloading` (from scratch; partials are not resumed).
2. Restores **download queue pause** from `download_queue_paused` in app settings (pause survives restart).
3. Requeues AI jobs left in `running` and channel catalogs left in `indexing`.

A cancel that crashes before the DB write can requeue once — rare and acceptable.

## Files not appearing in the library

1. Confirm the file is under `DOWNLOADS_DIR` with a supported extension (`.mp4`, `.mkv`, `.webm`).
2. Intermediate names (`.part`, `.fNNN.`, `.norm.`, `.compat.`) are ignored until the final merge exists.
3. Wait for the watchdog or the poll interval (`SCAN_INTERVAL_SEC`, default 60s).
4. Imports may sit in **needs review** — open [Import](../guides/import-review.md).
5. Permissions: the process UID must read the file ([PUID/PGID](#permissions-puid-pgid)).

## Permissions (`PUID` / `PGID`)

Docker entrypoint runs Horde as `PUID`:`PGID` (defaults `1000:1000`) and chowns `DATA_DIR`. The downloads mount is **not** recursively chowned (host owns the media dataset).

**Symptoms:** cannot write downloads; empty library; “permission denied” in logs; SMB cannot read new files.

**Fix:** set `PUID`/`PGID` to the owner of your media dataset, recreate the container, ensure the mount is writable by that user.

## Ollama offline

**Symptoms:** AI status Offline / Blocked; embeds/tags show **waiting** (not progressing); `/api/health` shows `ollama.reachable: false` and may include `workers.ai_blocked_reason`. Settings → System / AI → Jobs shows the blocked reason.

**Waiting vs failed:**

| State | Meaning |
|-------|---------|
| **Waiting** | Jobs stay `queued`, attempts stay `0`, provider missing/unreachable. Resume when Ollama (or OpenRouter) is back — no Retry needed. |
| **Deferred** | Job failed once/twice and has a future `run_after` backoff. |
| **Failed** | Terminal after 3 attempts — use **Retry** / **Retry all** under Settings → AI → Jobs. |

**Checks:**

1. If using Compose AI profile: `docker compose --profile ai up -d` and wait for Ollama to listen on 11434.
2. Set `OLLAMA_BASE_URL` explicitly if auto-discover fails (especially remote GPUs).
3. From inside the Horde container, curl the candidate URLs in [AI setup](ai-setup.md) order.
4. OpenRouter-only setups can run without Ollama when scope covers the tasks you need (embeddings may still want Ollama unless scope is **all** or cloud embeds are configured).
5. After Ollama returns, jobs should claim without restarting Horde (dead URL cache is invalidated on provider errors).

## DASH / stream preview issues

In-app watch-before-download preview resolves progressive or adaptive formats via yt-dlp. Failures often share root causes with [bot checks](#bot-checks-youtube-blocks) or expired CDN URLs.

- Retry after POT/cookies are healthy.
- Preview refresh uses `force=True` on extract to bust the 180s info cache when refreshing media URLs.
- Some sources simply lack a usable progressive format under the preview height cap.
- Preview API errors include a structured `error_kind` when classification succeeds.

**Preview plays ~40–60s then Shaka error 1001 / “Compatibility-mode preview failed”, and downloads say “Download produced no file”:** YouTube started rejecting `android_vr` googlevideo URLs after the first minute of Range requests (`Upstream returned 403`). Horde no longer forces that client; yt-dlp 2026.8.19+ uses `visionos` instead. Rebuild so the yt-dlp pin updates (`yt_dlp_version` on Settings → System / `/api/health` should be `2026.08.19` or newer), then retry. If 403s continue, treat it as a [bot check / POT](#bot-checks-youtube-blocks) problem.

## Library playback fails on iPhone

Desktop Chrome can play VP9 and Opus remuxed into MP4; **Safari on iPhone cannot** (VP9 is unsupported; Opus-in-MP4 is rejected as corrupt). Horde archives **AV1 + AAC** in MP4 with `faststart`. A17 Pro (iPhone 15 Pro) can decode that AV1; older iPhones may still fail AV1.

**Fix:** re-download with **Change resolution** so the new selectors run. Existing files are not rewritten in place. Do not use Chrome DevTools device mode as a phone stand-in.

## Stale UI after update

After pulling a new image or rebuilding the frontend, browsers may keep old hashed assets incorrectly, or service workers/cache may serve a previous shell.

**Fix:** hard reload — +++ctrl+shift+r+++ (Windows/Linux) or +++cmd+shift+r+++ (macOS).

If Settings → System still shows an old version, confirm the container actually restarted on the new image (`horde_version` / `horde_sha` on `/api/health`).

## Settings or library empty after update

**Symptoms:** theme/AI/catalog settings back to defaults, library looks empty, or downloads land in a different folder after `bash update.sh`.

That happens when the recreated container bind-mounts **different host paths** than before. `app_settings.json` and `horde.db` live on `DATA_PATH`; media lives on `DOWNLOADS_PATH`. Pointing those at empty defaults (`/opt/dockge/horde/data`, `/mnt/tank/media/youtube_archive`) looks like a reset.

Typical causes:

1. Volume paths were edited in **Dockge / `docker-compose.yml`** instead of `.env`. `git pull` refreshes the tracked compose file and interpolation falls back to those defaults.
2. `git reset --hard` (or discarding local compose edits) to make `git pull` succeed.
3. Clicking **Deploy** in Dockge after `update.sh` with an older compose still in the editor.

**Fix:**

1. Do not recreate again until paths are correct.
2. Confirm `.env` has the directories that actually hold `horde.db` / `app_settings.json` and your media.
3. Run `bash update.sh` from the host stack folder (current versions snapshot live mounts into `.env` before pulling).
4. Hard-refresh the browser. Appearance may still be in `localStorage`; AI/library settings only return if the original `DATA_PATH` is mounted again.

If the old data directory still exists on disk, set `DATA_PATH` / `DOWNLOADS_PATH` back to it — files were not deleted, only unmounted.

## Wiki missing in local development

The MkDocs wiki is built in the Docker image and served at `/wiki/`. Local `uvicorn` without a wiki build reports:

```json
"wiki_available": false
```

on `/api/health`.

**Fix:** run `./start.sh` (or `scripts/dev.sh` / `scripts/dev.ps1`) — it installs `mkdocs-material` from `requirements-dev.txt` and builds into `backend/static/wiki/` when missing or stale. Use `SKIP_WIKI=1` only if you intentionally want to skip that step. Manual rebuild: `mkdocs build -d backend/static/wiki --strict` from the repo root. See [Local development](../getting-started/local-dev.md).

## Related

- [YouTube access](youtube-access.md)
- [Ports & networking](ports-networking.md)
- [Remote access](remote-access.md)
- [Updating](../getting-started/updating.md)
- [Local development](../getting-started/local-dev.md)

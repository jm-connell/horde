# Troubleshooting

## Bot checks / YouTube blocks

**Symptoms:** downloads fail with bot, PO token, or “sign in” style errors; previews hang; feed cards never load metadata.

**Checks:**

1. Is `bgutil-pot` running? Health → `pot_provider` should be `ok` (`GET /api/health`).
2. `YTDLP_POT_BASE_URL` reachable from the Horde container (`http://bgutil-pot:4416` in Compose).
3. Add [cookies](youtube-access.md) if POT alone is not enough.
4. Reduce bursty browsing — extracts are already serialized (1.25s spacing); avoid restarting jobs in a tight loop.
5. Update the image / yt-dlp — extractor breakage is common when YouTube changes.

## Files not appearing in the library

1. Confirm the file is under `DOWNLOADS_DIR` with a supported extension (`.mp4`, `.mkv`, `.webm`).
2. Intermediate names (`.part`, `.fNNN.`, `.norm.`) are ignored until the final merge exists.
3. Wait for the watchdog or the poll interval (`SCAN_INTERVAL_SEC`, default 60s).
4. Imports may sit in **needs review** — open [Import](../guides/import-review.md).
5. Permissions: the process UID must read the file ([PUID/PGID](#permissions-puid-pgid)).

## Permissions (`PUID` / `PGID`)

Docker entrypoint runs Horde as `PUID`:`PGID` (defaults `1000:1000`) and chowns `DATA_DIR`. The downloads mount is **not** recursively chowned (host owns the media dataset).

**Symptoms:** cannot write downloads; empty library; “permission denied” in logs; SMB cannot read new files.

**Fix:** set `PUID`/`PGID` to the owner of your media dataset, recreate the container, ensure the mount is writable by that user.

## Ollama offline

**Symptoms:** AI status not ready; embeds/tags stuck queued; `/api/health` shows `ollama.reachable: false`.

1. If using Compose AI profile: `docker compose --profile ai up -d` and wait for Ollama to listen on 11434.
2. Set `OLLAMA_BASE_URL` explicitly if auto-discover fails (especially remote GPUs).
3. From inside the Horde container, curl the candidate URLs in [AI setup](ai-setup.md) order.
4. OpenRouter-only setups can run without Ollama when scope covers the tasks you need (embeddings may still want Ollama unless scope is **all** or cloud embeds are configured).

## DASH / stream preview issues

In-app watch-before-download preview resolves progressive or adaptive formats via yt-dlp. Failures often share root causes with [bot checks](#bot-checks-youtube-blocks) or expired CDN URLs.

- Retry after POT/cookies are healthy.
- Preview refresh uses `force=True` on extract to bust the 180s info cache when refreshing media URLs.
- Some sources simply lack a usable progressive format under the preview height cap.

## Stale UI after update

After pulling a new image or rebuilding the frontend, browsers may keep old hashed assets incorrectly, or service workers/cache may serve a previous shell.

**Fix:** hard reload — +++ctrl+shift+r+++ (Windows/Linux) or +++cmd+shift+r+++ (macOS).

If Settings → System still shows an old version, confirm the container actually restarted on the new image (`horde_version` / `horde_sha` on `/api/health`).

## Wiki missing in local development

The MkDocs wiki is built in the Docker image and served at `/wiki/`. Local `uvicorn` without a wiki build reports:

```json
"wiki_available": false
```

on `/api/health`. That is expected. Build docs (`mkdocs build`) into the static tree, or use the full Docker image, to enable Settings → System → Documentation.

## Related

- [YouTube access](youtube-access.md)
- [Ports & networking](ports-networking.md)
- [Updating](../getting-started/updating.md)
- [Local development](../getting-started/local-dev.md)

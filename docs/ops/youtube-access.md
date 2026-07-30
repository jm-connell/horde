# YouTube access

YouTube frequently challenges automated clients (bot checks, PO tokens, cookies). Horde ships a POT sidecar by default and adds rate-limited extracts so browsing a channel feed does not open dozens of parallel sessions.

## bgutil POT sidecar

Compose includes:

```yaml
bgutil-pot:
  image: brainicism/bgutil-ytdlp-pot-provider:1.3.1
```

Horde is configured with:

```text
YTDLP_POT_BASE_URL=http://bgutil-pot:4416
```

The [bgutil yt-dlp POT provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) supplies Proof-of-Origin tokens over HTTP. Horde wires this into yt-dlp extractor args when `YTDLP_POT_BASE_URL` is set.

!!! tip "Health"
    `GET /api/health` includes a `pot_provider` block (`ok` / `error`, URL, version) by pinging `{YTDLP_POT_BASE_URL}/ping`.

If the sidecar is down, downloads and previews may fail with bot-check style errors. Restart `bgutil-pot` and confirm the URL from inside the Horde container.

## Cookie fallbacks

When POT is not enough (members content you are entitled to, stubborn challenges, age gates):

| Variable | Behavior |
|----------|----------|
| `YTDLP_COOKIE_FILE` | Netscape cookie file path. Used when the file exists. |
| `YTDLP_COOKIES_FROM_BROWSER` | yt-dlp browser cookies (`chrome`, `firefox`, or `browser:profile`). Used only if the cookie file is unset or missing. |

Cookie file takes precedence over browser cookies. Browser cookies typically require host-network / local runs (harder inside a locked-down container).

## Members-only videos

Members-only (and similar gated) entries are **skipped** during channel catalog indexing and download flows that detect the gate. Skips are recorded in `channel_catalog_skips` so indexing does not retry forever.

You will not get those videos without valid cookies for an entitled account — and Horde will not hammer YouTube retrying them.

## Extract gate (bot-check hygiene)

All metadata `extract_info` calls (feed cards, download preview, stream preview, catalog) share a global gate:

| Control | Value | Purpose |
|---------|-------|---------|
| Semaphore | **1** | One extract at a time |
| Min interval | **1.25 s** | Spacing between extracts |
| Result cache | **180 s** TTL (max 48 entries) | Reuse recent info JSON |

Downloads themselves stay limited by `MAX_DOWNLOAD_CONCURRENCY` (default **2**). The extract gate is specifically for metadata bursts when scrolling feeds or opening many previews.

`force=True` bypasses cache reads (used when refreshing CDN URLs for DASH/progressive preview).

## Related

- [Environment variables](environment.md)
- [Troubleshooting](troubleshooting.md) — bot checks
- [Download pipeline](../architecture/downloads-pipeline.md)

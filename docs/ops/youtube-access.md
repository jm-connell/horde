# YouTube access

YouTube frequently challenges automated clients (bot checks, PO tokens, cookies). Horde ships a POT sidecar by default and adds rate-limited extracts so browsing a channel feed does not open dozens of parallel sessions.

## bgutil POT sidecar

Compose includes:

```yaml
bgutil-pot:
  image: brainicism/bgutil-ytdlp-pot-provider:1.3.2
```

Horde is configured with:

```text
YTDLP_POT_BASE_URL=http://bgutil-pot:4416
```

The [bgutil yt-dlp POT provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) supplies Proof-of-Origin tokens over HTTP. Horde wires this into yt-dlp extractor args when `YTDLP_POT_BASE_URL` is set. YouTube player clients follow yt-dlp’s current defaults (minus `android_vr`, whose media URLs now 403 after about a minute of playback).

!!! tip "Health"
    `GET /api/health` includes a `pot_provider` block (`ok` / `error`, URL, version) by pinging `{YTDLP_POT_BASE_URL}/ping`, plus `youtube.cookies_configured` and `youtube.last_extract_failure` (kind/message/timestamp of the most recent classified extract error, plus the video or channel it targeted). Download pause and AI/catalog queue depths are under `downloads` and `workers`.

If the sidecar is down, downloads and previews may fail with bot-check style errors (UI `error_kind` of `bot` or `pot`). Restart `bgutil-pot` and confirm the URL from inside the Horde container.

## Cookie fallbacks

Cookies identify a signed-in YouTube account, so Horde **does not send them on ordinary requests** (channel feeds, search, public downloads, public index extracts). When cookies are configured they are a **per-video fallback**:

1. Try the download or per-video index extract anonymously (PO token still applies).
2. If YouTube blocks that one video as **age-restricted**, **members-only**, or similar login-required, retry **that action only** with cookies.
3. Bot checks still go through the POT sidecar — cookies are not attached to clear a bot challenge.

| Variable | Behavior |
|----------|----------|
| `YTDLP_COOKIE_FILE` | Netscape cookie file path. Used when the file exists. |
| `YTDLP_COOKIES_FROM_BROWSER` | yt-dlp browser cookies (`chrome`, `firefox`, or `browser:profile`). Used only if the cookie file is unset or missing. |

Cookie file takes precedence over browser cookies. Browser cookies typically require host-network / local runs (harder inside a locked-down container).

## Gated videos

Channel **listings** (feeds, search, playlist pages) stay anonymous. Members-only / age-restricted entries are skipped on those lists unless cookies are configured (so you can try a download). A **full catalog index** keeps gated rows when cookies exist so the per-video description pass can retry with cookies after an anonymous block. Casual feed-head sync still skips them so browsing a channel does not attach cookies.

Downloads, stream preview, metadata refresh, and that description pass try anonymously first, then retry **that video** once with cookies. If the account still cannot watch it, the video is skipped (`channel_catalog_skips`) and indexing continues; the channel page shows a toast (and the catalog `last_error`) instead of failing the whole job.

You will not get those videos without valid cookies for an entitled account. After an anonymous block, Horde retries **that video** once with cookies (if configured) and then records a skip so indexing does not hammer YouTube.

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
- [Bumping yt-dlp](maintenance.md#bumping-yt-dlp) — pin and rebuild when extractors break
- [Download pipeline](../architecture/downloads-pipeline.md)

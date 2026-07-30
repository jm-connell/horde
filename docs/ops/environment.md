# Environment variables

Horde is configured primarily through environment variables. Most values have sensible defaults; Docker Compose sets the ones you usually need for a homelab install.

!!! tip "Settings UI vs env"
    Day-to-day preferences (appearance, AI models, sync intervals) live in [Settings](../settings/index.md) and are stored in `app_settings.json` under [DATA_DIR](storage-layout.md). Env vars cover paths, process binding, YouTube access helpers, and deploy identity.

## Application

| Variable | Default | Purpose |
|----------|---------|---------|
| `DOWNLOADS_DIR` | `./downloads` | Root for media files (channel/year layout, imports, sidecars). |
| `DATA_DIR` | `./data` | SQLite DB, settings, caches, thumbnails, sprites, fonts, backgrounds. |
| `SCAN_INTERVAL_SEC` | `60` | Fallback poll interval (seconds) for the downloads-tree scanner when the watchdog misses an event. |
| `HOST` | `0.0.0.0` | Bind address for uvicorn. |
| `PORT` | `8080` | Listen port **inside** the process/container. |
| `MAX_DOWNLOAD_CONCURRENCY` | `2` | Max simultaneous yt-dlp download workers (FIFO queue). |

In Compose, Horde maps host **8686** → container **8080**. See [Ports & networking](ports-networking.md).

## YouTube access

| Variable | Default | Purpose |
|----------|---------|---------|
| `YTDLP_POT_BASE_URL` | *(empty)*; Compose: `http://bgutil-pot:4416` | Base URL for the [bgutil POT](youtube-access.md) HTTP provider. |
| `YTDLP_COOKIE_FILE` | *(empty)* | Path to a Netscape cookie file for authenticated / age-gated extracts. |
| `YTDLP_COOKIES_FROM_BROWSER` | *(empty)* | Browser cookies via yt-dlp (`browser` or `browser:profile`). Used only if `YTDLP_COOKIE_FILE` is unset or missing. |

Cookie file wins over browser cookies when the file exists. Details: [YouTube access](youtube-access.md).

## AI providers

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_BASE_URL` | *(empty)* | Fixed Ollama URL. Empty = [auto-discover](ai-setup.md). |
| `OPENROUTER_API_KEY` | *(empty)* | Optional key that overrides the key stored in Settings → AI. |

## Deploy identity

| Variable | Default | Purpose |
|----------|---------|---------|
| `HORDE_GITHUB_REPO` | `jm-connell/horde` | GitHub `owner/repo` for update checks. |
| `HORDE_GIT_SHA` | `unknown` (baked at image build) | Deployed commit SHA; falls back to local `git rev-parse HEAD` in development. |

## Docker Compose host paths

These are **Compose / host** variables used when mounting volumes — not read by the Python app itself. The app sees the in-container paths (`DOWNLOADS_DIR`, `DATA_DIR`).

| Variable | Typical default | Mounted as |
|----------|-----------------|------------|
| `PUID` | `1000` | UID the entrypoint runs as (file ownership on the data volume). |
| `PGID` | `1000` | GID for the same. |
| `DOWNLOADS_PATH` | host media dataset | → `/downloads` (`DOWNLOADS_DIR`) |
| `DATA_PATH` | host data dir | → `/app/data` (`DATA_DIR`) |
| `OLLAMA_DATA_PATH` | `./ollama` | Ollama model store when using `--profile ai` |

!!! warning "Permissions"
    Set `PUID`/`PGID` to the user that owns your media dataset (common on TrueNAS). Wrong IDs cause downloads that the host cannot read, or a scanner that cannot write. See [Troubleshooting](troubleshooting.md).

## Example Compose fragment

```yaml
ports:
  - "8686:8080"
environment:
  - PUID=${PUID:-1000}
  - PGID=${PGID:-1000}
  - DOWNLOADS_DIR=/downloads
  - DATA_DIR=/app/data
  - SCAN_INTERVAL_SEC=${SCAN_INTERVAL_SEC:-60}
  - YTDLP_POT_BASE_URL=${YTDLP_POT_BASE_URL:-http://bgutil-pot:4416}
  - OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-}
  - HORDE_GITHUB_REPO=${HORDE_GITHUB_REPO:-jm-connell/horde}
volumes:
  - ${DOWNLOADS_PATH}:/downloads
  - ${DATA_PATH}:/app/data
```

## Related

- [Storage layout](storage-layout.md)
- [AI setup](ai-setup.md)
- [Install with Docker](../getting-started/install-docker.md)

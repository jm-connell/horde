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

These are **Compose / host** variables used when mounting volumes — not read by the Python app itself. The app sees the in-container paths (`DOWNLOADS_DIR`, `DATA_DIR`). Keep `DOWNLOADS_PATH` and `DATA_PATH` in `.env` (gitignored). `update.sh` copies the running container's bind mounts into `.env` before `git pull` so an update cannot remount empty defaults.

| Variable | Typical default | Mounted as |
|----------|-----------------|------------|
| `PUID` | `1000` | UID the entrypoint runs as (file ownership on the data volume). |
| `PGID` | `1000` | GID for the same. |
| `DOWNLOADS_PATH` | host media dataset | → `/downloads` (`DOWNLOADS_DIR`) |
| `DATA_PATH` | host data dir | → `/app/data` (`DATA_DIR`) |
| `OLLAMA_DATA_PATH` | `./ollama` | Ollama model store when using `--profile ai` |

!!! warning "Permissions"
    Set `PUID`/`PGID` to the user that owns your media dataset (common on TrueNAS). Wrong IDs cause downloads that the host cannot read, or a scanner that cannot write. See [Troubleshooting](troubleshooting.md).

## GPU { #gpu }

Settings → System → Resources shows a **GPU** card from what the **`horde` container** can see (`nvidia-smi`, ROCm, or `/dev/dri`). **None detected** means that process has no card — usually the GPU snippets in `docker-compose.yml` are still commented out, TrueNAS isolated the device to another app, or the host has no GPU. Horde still runs.

This is **not** the Ollama GPU. Passing a device into `ollama` (or running Ollama on another PC) does not fill the System GPU card.

### Do you need one?

Horde does **not** require a GPU to download, browse, or play the library. Playback is the stored file; there is no live transcode while you watch.

| What you do | GPU? |
|-------------|------|
| Default **AV1** archives | No — bitstream is copied |
| **H.264** at 1080p and below | No — YouTube already has H.264 |
| **H.264 / H.265** at 1440p/4K | Optional: hardware encode is much faster; otherwise software can take a long time |
| Local **Ollama** (tags, chat, search) | On the **Ollama** machine — or skip Ollama and use OpenRouter |
| Everything else | No |

Keep **Archive video codec → AV1** if you do not want encode work. Codec tradeoffs: [Compatibility codecs (beta)](../guides/downloads.md#compatibility-codecs).

### Pass the GPU into Horde

The GPU snippets on the **`horde`** service in `docker-compose.yml` start commented out. Uncomment the block that matches the host, then recreate the stack (`docker compose up --build -d` or Dockge deploy).

**NVIDIA** (needs nvidia-container-toolkit on the host):

```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

On TrueNAS: install NVIDIA drivers in the TrueNAS UI, and do **not** isolate the GPU to another app (Plex, Jellyfin, official Apps). An isolated GPU is invisible to Dockge.

**Intel QSV / AMD VAAPI:**

```yaml
    devices:
      - /dev/dri
    group_add:
      - video
      - render
```

**AMD ROCm extra** (if using AMF via `/dev/kfd`): also mount `/dev/kfd` as in the compose comments.

`git pull` / `update.sh` overwrites tracked `docker-compose.yml`. Re-apply uncommented GPU lines after an update. Keep media paths in `.env`; device passthrough has to live in compose.

Ollama passthrough is a **separate** uncomment on the `ollama` service. See [AI setup](ai-setup.md).

### Archive transcode (beta) { #horde-encode-gpu }

H.264/H.265 conversion runs **inside the Horde container**, once per download — not while someone is watching, and not on the Ollama machine if that GPU lives elsewhere. The image installs **jellyfin-ffmpeg** when the Jellyfin repo is available so NVENC/QSV/VAAPI encoders exist; Debian ffmpeg is the fallback (software `libx264`/`libx265` only).

What you should see after passthrough:

- Settings → System → Resources **GPU** shows name / util / VRAM (**None detected** is gone)
- Settings → Library **Rec** / amber warnings come from ffmpeg in this process (`/api/system/stats` → `encode.hw_hevc`, `hw_h264`, `ffmpeg_has_hw_encoder`)
- If **GPU** is filled but Library still warns that encode cannot use it, ffmpeg in this image cannot load NVENC/QSV/VAAPI
- Ollama VRAM under AI is a different probe and may be a GPU on another PC

AV1 archives never use the encode GPU. 1080p H.264 copies YouTube’s stream. Only 1440p/4K (and 1080p AV1/VP9 that must become H.264) hit the encoder.

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
- [TrueNAS / Dockge](../getting-started/truenas-dockge.md)
- [Install with Docker](../getting-started/install-docker.md)

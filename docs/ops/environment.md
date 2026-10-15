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
| `HORDE_TEMP_SWEEP_HOURS` | `6` | At boot, delete leftover files that Horde itself generates (`<stem>.norm.<n>.mp4`, `.compat.<n>.mp4`, `.xcode.<n>.mp4`, `.horde-h264.dl.*`, `.horde-h264.enc.mp4`) older than this many hours that no library row references. Your own files are never swept, whatever their name (`x.temp.mkv`, `notes.part`, `Show.compat.mkv`). `0` disables the sweep. Staging dirs of finished or missing jobs are always removed at boot. |
| `HOST` | `0.0.0.0` | Bind address for uvicorn. |
| `PORT` | `8080` | Listen port **inside** the process/container. |
| `MAX_DOWNLOAD_CONCURRENCY` | `2` | Max simultaneous yt-dlp download workers (FIFO queue). |
| `MAX_FFMPEG_CONCURRENCY` | *(empty)* → **2** if a GPU encoder is available, else **1** | Max simultaneous remux/transcode/loudnorm/H.264-copy workers. |

In Compose, Horde maps host **8686** → container **8080**. See [Ports & networking](ports-networking.md).

## YouTube access

| Variable | Default | Purpose |
|----------|---------|---------|
| `YTDLP_POT_BASE_URL` | *(empty)*; Compose: `http://bgutil-pot:4416` | Base URL for the [bgutil POT](youtube-access.md) HTTP provider. |
| `YTDLP_COOKIE_FILE` | *(empty)* | Path to a Netscape cookie file. Attached only after a per-video age-restricted or members-only block. |
| `YTDLP_COOKIES_FROM_BROWSER` | *(empty)* | Browser cookies via yt-dlp (`browser` or `browser:profile`). Used only if `YTDLP_COOKIE_FILE` is unset or missing. Same per-video fallback as the cookie file. |

Cookie file wins over browser cookies when the file exists. Details: [YouTube access](youtube-access.md).

## AI providers

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_BASE_URL` | *(empty)* | Fixed Ollama URL. Empty = [auto-discover](ai-setup.md). |
| `OPENROUTER_API_KEY` | *(empty)* | Optional key that overrides the key stored in Settings → AI. |

## Security

| Variable | Default | Purpose |
|----------|---------|---------|
| `HORDE_ALLOWED_HOSTS` | *(empty)* | Extra `Host` names Horde answers, comma separated (`horde.example.com`, `*.example.com`). Adds to the LAN defaults; `*` disables the check. See [Security](security.md#allowed-hosts). |
| `HORDE_ALLOW_PRIVATE_URLS` | *(empty)* | `1` lets server-side fetches and link checks target private / loopback addresses (LAN download sources). See [Security](security.md#private-urls). |
| `HORDE_MAX_UPLOAD_GB` | `50` | Largest video accepted by Import → upload. |

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

Horde does **not** require a GPU to download, browse, or play the library. Playback is a stored file (the original or an H.264 copy made ahead of time); there is no live transcode while you watch.

| What you do | GPU? |
|-------------|------|
| **AV1 only** (default) | No — bitstream is copied |
| **H.264 only, up to 1080p** | No — YouTube already has H.264 |
| **H.264 only, full resolution** | Strongly advised: every 1440p/4K download is re-encoded |
| **AV1 + H.264 copy** | Helpful: new YouTube downloads need no encode, but copies of existing videos and imports are encoded |
| One-off **Create compatible copy** | Optional: hardware encode is much faster; software takes minutes per 1080p video |
| Local **Ollama** (tags, chat, search) | On the **Ollama** machine — or skip Ollama and use OpenRouter |
| Everything else | No |

Keep **Playback compatibility → AV1 only** if you do not want encode work. Tradeoffs: [Playback compatibility](../guides/downloads.md#compatibility-codecs).

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

### Playback compatibility encoding { #horde-encode-gpu }

H.264 encodes (copies, and `h264_convert` conversions) run **inside the Horde container** when a download finishes or a copy is requested — not while someone is watching, and not on the Ollama machine if that GPU lives elsewhere. The image installs **jellyfin-ffmpeg** when the Jellyfin repo is available so NVENC/QSV/VAAPI encoders exist; Debian ffmpeg is the fallback (software `libx264` only). Horde tries NVENC, QSV, VAAPI, AMF, VideoToolbox, then `libx264`.

What you should see after passthrough:

- Settings → System → Resources **GPU** shows name / util / VRAM (**None detected** is gone)
- Settings → Library shows the encoder Horde picked (for example `h264_nvenc (GPU)`); the amber warnings come from ffmpeg in this process (`/api/system/stats` → `encode.hw_h264`, `ffmpeg_has_hw_encoder`)
- If **GPU** is filled but Library still says Horde cannot use it for encoding, ffmpeg in this image cannot load NVENC/QSV/VAAPI
- Ollama VRAM under AI is a different probe and may be a GPU on another PC

**GTX 16-series / RTX 20-series:** these NVIDIA cards encode H.264 fine but cannot decode AV1. Horde decodes AV1 on the CPU (dav1d) and encodes on the GPU, which is still several times faster than real time at 1080p. NVDEC is used for H.264/HEVC/VP9 sources.

AV1-only and H.264-up-to-1080p modes never use the encode GPU. YouTube's own H.264 is downloaded, not encoded. Only `h264_convert`, copies for non-YouTube videos, and copies where YouTube has no H.264 hit the encoder. The ffmpeg pool is **2** workers with a GPU encoder, otherwise **1** (override with `MAX_FFMPEG_CONCURRENCY`).

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

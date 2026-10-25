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
| `HORDE_STREAM_AI_RETENTION_DAYS` | `30` | How long the AI summary, chapters and chat of a streamed (not downloaded) video are kept after it was last opened. Downloading the video moves them onto it instead. Minimum 1. |
| `HORDE_TRASH_DAYS` | `7` | How many days a video the user deleted waits in the [trash](../guides/library.md#trash) before it is erased for good. `0` turns the trash off: new deletes are immediate and permanent (entries already in it still expire after 7 days). |
| `HORDE_LOG_LEVEL` | `INFO` | Log level for Horde and uvicorn (`DEBUG`, `INFO`, `WARNING`, `ERROR`). See [Logging](logging.md). |
| `HORDE_LOG_FORMAT` | `text` | `json` writes one JSON object per log line (for Loki, Vector and similar). See [Logging](logging.md). |
| `HORDE_YTDLP_REQUEST_THREADS` | `8` | How many requests may be inside yt-dlp work (link checks, previews, feeds, searches) at once. Extra requests wait up to 15 s without using a worker thread, then get HTTP 429, so slow YouTube calls can never freeze the rest of the API. |
| `HORDE_EXTRACT_QUEUE_TIMEOUT_SEC` | `180` | How long one yt-dlp call waits its turn on the global extract queue before giving up with an error. |
| `HORDE_EXTRACT_QUEUE_TIMEOUT_BACKGROUND_SEC` | `540` (3x the above) | The same wait for background work (catalog indexing, metadata fills), which always queues behind interactive requests. |
| `HORDE_LIVE_POLL_SEC` | `300` | How often each followed channel is checked for a live broadcast (seconds). `0` turns the checks off. See [Live streams](../design/live-streams.md). |
| `HORDE_LIVE_POLL_SPACING_SEC` | `2` | Pause between two live checks, so a long follow list never bursts requests at YouTube. |
| `HORDE_LIVE_DVR_HOURS` | `4` | How far back the player can scrub in a live stream, when YouTube still serves those segments. |
| `HORDE_BACKUP_ENABLED` | `1` | `0` turns the [nightly database backup](backup-restore.md#nightly) off. |
| `HORDE_BACKUP_HOUR` | `4` | Local hour (0-23) after which the nightly backup is taken. |
| `HORDE_BACKUP_KEEP` | `7` | How many nightly backups to keep (minimum 1). |
| `HOST` | `0.0.0.0` | Bind address for uvicorn. |
| `PORT` | `8080` | Listen port **inside** the process/container. |
| `MAX_DOWNLOAD_CONCURRENCY` | `2` | Max simultaneous yt-dlp download workers (FIFO queue). |
| `HORDE_MIN_FREE_GB` | `2` | Downloads wait while the downloads volume has less than this much free space (GB). `0` turns the check off. The library size limit is a setting, not an environment variable: see [Disk limits](../guides/downloads.md#disk-limits). |
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
| `OLLAMA_BASE_URL` | *(empty)* | Legacy Ollama URL, used when Settings → AI has no provider URL. The provider is set in Settings; see [AI setup](ai-setup.md). |
| `OPENROUTER_API_KEY` | *(empty)* | Optional key that overrides the key stored in Settings → AI while the provider URL is OpenRouter. |

## Security

| Variable | Default | Purpose |
|----------|---------|---------|
| `HORDE_ALLOWED_HOSTS` | *(empty)* | Extra `Host` names Horde answers, comma separated (`horde.example.com`, `*.example.com`). Adds to the LAN defaults; `*` disables the check. See [Security](security.md#allowed-hosts). |
| `HORDE_TRUST_PROXY` | *(off)* | `1` = believe `X-Forwarded-For` / `X-Forwarded-Proto` from a proxy you control (login rate limiting, `Secure` cookie). See [Accounts](authentication.md#behind-a-reverse-proxy). |
| `HORDE_AUTH_DISABLED` | *(off)* | `1` = no sign-in; every request acts as the first admin. Only behind a proxy that authenticates. See [Accounts](authentication.md#behind-a-reverse-proxy). |
| `HORDE_TRUSTED_PROXY_HOPS` | `1` | Proxies appending to `X-Forwarded-For`; the client address is counted from the right. |
| `HORDE_TRUSTED_USER_HEADER` | *(empty)* | With the two above: the header naming the existing Horde user to act as. Requires `HORDE_TRUST_PROXY=1`, otherwise Horde refuses to start. |
| `HORDE_ALLOW_PRIVATE_URLS` | *(empty)* | `1` lets server-side fetches and link checks target private / loopback addresses (LAN download sources). See [Security](security.md#private-urls). |
| `HORDE_MAX_UPLOAD_GB` | `50` | Largest video accepted by Import → upload. |
| `HORDE_PUBLIC_URL` | *(empty)* | The address you open Horde at (`https://horde.example.com`, no trailing path). [Notifications](notifications.md) use it to link back to Horde; without it they carry no link. It must be an `http(s)://` URL with a host and no user name or password; an invalid value is ignored with a warning in the log at startup. |

## Deploy identity

| Variable | Default | Purpose |
|----------|---------|---------|
| `HORDE_GITHUB_REPO` | `jm-connell/horde` | GitHub `owner/repo` for update checks. |
| `HORDE_GIT_SHA` | `unknown` (baked at image build) | Deployed commit SHA; falls back to local `git rev-parse HEAD` in development. |
| `HORDE_VERSION` | `dev` (baked at image build) | Release version (for example `1.2.3`) for images built from a release tag. Used by the update check. |

The image also contains `/app/BUILD_INFO` (version, commit, ffmpeg flavor and `ffmpeg -version`), printed in the container log at start: `docker logs horde | grep build:`.

## Container runtime

| Variable | Default | Purpose |
|----------|---------|---------|
| `HORDE_UPDATE_CHANNEL` | `release` | Host-side, read by `update.sh`: `release` (newest stable `vX.Y.Z` tag), `prerelease` or `main`. See [Update channels](../getting-started/updating.md#update-channels). |
| `HORDE_ALLOW_DOWNGRADE` | *(unset)* | Host-side: `1` lets `update.sh` switch to a release older than the checkout. |
| `HORDE_ALLOW_ROOT` | `0` | The entrypoint refuses `PUID=0` / `PGID=0` unless this is `1`. |
| `YTDLP_AUTO_UPDATE` | `0` | `1` = on start, install the latest yt-dlp into `DATA_DIR/pylib` and prefer it over the baked version (details below). |
| `HORDE_MEM_LIMIT` | *(unlimited)* | Compose-only. Memory limit for the `horde` container, for example `4g`. |
| `HORDE_PIDS_LIMIT` | `1024` | Compose-only. Maximum processes/threads. |
| `FFMPEG_FLAVOR` | `jellyfin` | Build-time. `jellyfin` or `debian`; the build fails if the flavor is unavailable. |
| `JELLYFIN_GPG_FPR` | `4918AABC486CA052358D778D49023CD01DE21A7B` | Build-time. Expected fingerprint (40 hex characters) of the Jellyfin repository signing key; the build fails on a mismatch. Empty = use the built-in pinned fingerprint. Only override it if Jellyfin rotates their key (verify the new one out of band first). |
| `YTDLP_UPDATE_TIMEOUT_SEC` | `45` | Time limit for the `YTDLP_AUTO_UPDATE` download at start. |

### Runtime yt-dlp updater

YouTube changes its player regularly and yt-dlp ships fixes within days, faster than Horde cuts releases. With `YTDLP_AUTO_UPDATE=1` the entrypoint runs `pip install --upgrade --target $DATA_DIR/pylib yt-dlp` as the unprivileged runtime user on every start (120 s timeout) and puts that folder first on `PYTHONPATH`, so the newer yt-dlp wins.

- **Failure is never fatal.** Offline or PyPI down: a warning is logged and the yt-dlp baked into the image is used. A leftover copy older than the baked one is discarded.
- **Trade-off.** You run a yt-dlp that was not tested with this Horde release, and the container needs outbound access to PyPI at start. That is why it is off by default.
- Remove the folder (or set the variable to `0` and delete `DATA_DIR/pylib`) to go back to the baked version.
- `GET /api/health` reports the yt-dlp version actually in use.

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

Settings → System → Resources shows a **GPU** card from what the **`horde` container** can see (`nvidia-smi`, ROCm, or `/dev/dri`). **None detected** means that process has no card — usually no GPU has been [passed in](#pass-the-gpu-into-horde) yet (the default), TrueNAS isolated the device to another app, or the host has no GPU. Horde still runs.

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
| A local AI server such as **Ollama** (tags, chat, search) | On the AI server's machine — or use a cloud provider |
| Everything else | No |

Keep **Playback compatibility → AV1 only** if you do not want encode work. Tradeoffs: [Playback compatibility](../guides/downloads.md#compatibility-codecs).

### Pass the GPU into Horde

Put GPU settings in a file named `docker-compose.override.yml` in the Horde folder, next to `docker-compose.yml`. Docker Compose (and Dockge) read it automatically, Git ignores it, and updates leave it alone. Do **not** uncomment the GPU examples inside `docker-compose.yml` itself: `update.sh` and the **Update now** button stop when that file has local edits.

Create the file with `nano docker-compose.override.yml`, paste the block for your GPU, save, and run `docker compose up -d`. If the file already exists, add the lines under its existing `horde:` entry instead of repeating `services:`.

**NVIDIA** (install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host first; TrueNAS includes it once the NVIDIA driver is installed):

```yaml
services:
  horde:
    environment:
      - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

The `NVIDIA_DRIVER_CAPABILITIES` line asks the toolkit for the video encode libraries (NVENC); without it the card can show up in Settings while encoding still falls back to the CPU.

**Intel Quick Sync / AMD VAAPI** (`/dev/dri`): first look up the host's group numbers for the device, because group names inside the container differ from the host's:

```bash
getent group video render   # e.g. video:x:44:  and  render:x:105:
```

Use the numbers from that output (a host with no `render` group needs only the `video` line):

```yaml
services:
  horde:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "44"    # video, from getent
      - "105"   # render, from getent
```

**AMD ROCm extra** (AMF via `/dev/kfd`): add `- /dev/kfd:/dev/kfd` under `devices`.

!!! warning "`/dev/dri` passthrough is not yet confirmed to work"
    Horde starts as root and then switches to `PUID`:`PGID`, and that switch may drop the extra groups that `group_add` gives the container. If Settings → Library still reports a CPU encoder after this, run `docker logs horde` and look for *permission denied* on `/dev/dri`. A **GPU** entry in Settings only means the device file is visible, not that ffmpeg can open it. NVIDIA does not depend on these groups.

On TrueNAS: install the NVIDIA driver in the TrueNAS UI if you have an NVIDIA card, and do **not** isolate the GPU to another app (Plex, Jellyfin, official Apps). An isolated GPU is invisible to Dockge stacks.

Check the result in Settings → System → Resources (**GPU** shows the card) and Settings → Library (the encoder says **GPU**). The real test is making a compatibility copy of a 1080p video: on the GPU it takes well under the video's running time. `docker compose config` prints the merged configuration if you want to confirm Compose picked the file up.

The `ollama` service's GPU is separate: add an `ollama:` entry with the same `deploy` block (NVIDIA) or `devices` (AMD/Intel) to the same override file. See [AI setup](ai-setup.md#gpu-templates).

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

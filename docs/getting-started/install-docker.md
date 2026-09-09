# Install with Docker

Horde runs as a Docker Compose stack: the main `horde` app, a `bgutil-pot` sidecar for YouTube proof-of-origin tokens, and an optional `ollama` service behind the `ai` profile.

There is **no pre-built image on Docker Hub**. You clone this git repository onto the Docker host and Compose **builds** `horde:latest` from the `Dockerfile`. A zip download of the source can start once, but it has no `.git` directory, so later [`update.sh`](updating.md) / `git pull` will fail.

On **TrueNAS with Dockge**, clone into the Dockge stacks directory and deploy from the UI: [TrueNAS / Dockge](truenas-dockge.md).

!!! warning "LAN only — no authentication"
    Horde has **no login**. Bind it to a trusted LAN only. Do not publish it to the public internet or reverse-proxy it without your own access control in front.

## Requirements

- **Git** on the Docker host (for clone and later pulls)
- Docker Engine and Docker Compose **v2** (`docker compose`, not the old `docker-compose` binary)
- A host directory for media downloads
- A host directory for persistent app data (SQLite database and thumbnails) — keep this **outside** the git working tree
- Outbound HTTPS on first build (`apt`, `npm`, `pip`, base images)
- Enough disk for the library you plan to archive

## From zero

Work on the **host** (SSH or a local terminal). Do not run these commands in a container shell.

### 1. Clone the repository

```bash
git clone https://github.com/jm-connell/horde.git
cd horde
```

HTTPS is enough; the repo is public. Stay on `main` unless you intend to run another branch.

If you already cloned it and only need new commits, do **not** clone again. From the same directory:

```bash
bash update.sh
```

That is `git pull` plus rebuild. Details: [Updating](updating.md).

### 2. Create host directories

Pick two paths that will survive container rebuilds. Examples on a generic Linux box:

```text
/home/you/horde-media     → DOWNLOADS_PATH
/home/you/horde-data      → DATA_PATH
```

```bash
mkdir -p /home/you/horde-media /home/you/horde-data
```

`.env.example` ships TrueNAS-style defaults (`/mnt/tank/media/youtube_archive`, `/opt/dockge/horde/data`). If you leave those paths on a machine where they do not exist, Compose may create them as **root**, and Horde will not be able to write. Always set paths that you created and own.

### 3. Copy and edit `.env`

```bash
cp .env.example .env
```

Set at least `PUID`, `PGID`, `DOWNLOADS_PATH`, and `DATA_PATH` (see [Configure .env](#configure-env) below). Then fix ownership to match:

```bash
# use the same numbers you put in .env
sudo chown -R 1000:1000 /home/you/horde-media /home/you/horde-data
```

### 4. Build and start

```bash
docker compose up --build -d
```

The first build compiles the React UI, the MkDocs wiki, and the Python runtime. Expect several minutes. Recreates after that are faster.

Open the UI at:

```text
http://<server-ip>:8686
```

!!! note "Host port is 8686, not 8080"
    Compose publishes **host port 8686 → container port 8080**. The app listens on `8080` inside the container. Use `http://<server-ip>:8686` from your browser, not `:8080` on the host.

## Configure .env

You copied `.env` in step 3. These are the host-side keys that matter:

| Variable | Purpose |
|----------|---------|
| `PUID` / `PGID` | UID/GID the container uses for file ownership (default `1000`) |
| `DOWNLOADS_PATH` | Host path mounted at `/downloads` (your media library) |
| `DATA_PATH` | Host path mounted at `/app/data` (DB, thumbnails, sprites) |
| `SCAN_INTERVAL_SEC` | Fallback folder rescan interval in seconds (default `60`) |

See [Environment variables](../ops/environment.md) for the full list, including YouTube cookies and optional AI URLs.

### PUID and PGID

Set these to the user that owns (or should own) your media files — typically the same account you use for SMB shares. On Linux:

```bash
id <username>
```

Put the numeric `uid` and `gid` into `.env`. The entrypoint creates a matching user inside the container and runs Horde as that user so downloads are not owned by root.

### Volumes

| Host (`.env`) | Container mount | Contents |
|---------------|-----------------|----------|
| `DOWNLOADS_PATH` | `/downloads` | Video files under Channel / Year / Title |
| `DATA_PATH` | `/app/data` | `horde.db`, thumbnails, sprites, backgrounds, fonts |

Create both host directories before the first start if they do not exist yet. Library media and the database live on these volumes — rebuilding the image does not wipe them. Set the paths in `.env` (`DOWNLOADS_PATH` / `DATA_PATH`) rather than hardcoding them in `docker-compose.yml`, so `git pull` cannot replace them with compose defaults.

## What Compose starts

| Service | When it runs | Role |
|---------|--------------|------|
| `horde` | Always | FastAPI + built React UI on container port 8080 |
| `bgutil-pot` | Always | PO-token provider for yt-dlp (no Google login) |
| `ollama` | Profile `ai` only | Optional local LLM for embeddings, tags, recommendations |

```bash
# Default stack (horde + bgutil-pot)
docker compose up --build -d

# Include local Ollama
docker compose --profile ai up -d
```

For remote Ollama on another machine, leave the `ai` profile off and set `OLLAMA_BASE_URL` (or configure it under [Settings → AI](../settings/index.md)). Details: [AI setup](../ops/ai-setup.md).

GPU passthrough for the `horde` service is commented out by default. Settings → System shows **GPU** / **None detected** until you uncomment the NVIDIA or `/dev/dri` block. Horde does not need a GPU for normal use. See [GPU](../ops/environment.md#gpu).

## Verify the install

```bash
docker compose ps
curl -sf http://127.0.0.1:8686/api/health
```

Then open `http://<server-ip>:8686` from a machine on your LAN.

## After install

1. [First run](first-run.md) — download a video and confirm the library
2. [TrueNAS / Dockge](truenas-dockge.md) — if you deploy via Dockge on TrueNAS
3. [Updating](updating.md) — pull and rebuild when new commits land
4. [Downloads](../guides/downloads.md) — quality presets, queue, playlists

## Troubleshooting tips

!!! tip "UI unreachable on port 8080"
    That is expected on the host. Horde’s published port is **8686**. Inside the network, other containers still reach the app on `8080`.

!!! tip "Permission denied writing downloads"
    Recheck `PUID`/`PGID` against the owner of `DOWNLOADS_PATH`. The container must be able to create Channel/Year folders under `/downloads`.

!!! tip "`Dockerfile` not found / unable to prepare context"
    Compose is not running in a full Horde checkout. `cd` into the `git clone` (the folder that contains `Dockerfile` and `docker-compose.yml`). Dockge **Add Stack** with pasted YAML is not enough.

!!! tip "`fatal: not a git repository` on update"
    First install used a ZIP or a copy without `.git`. Clone with `git clone` into a new folder (or add the GitHub remote to an existing tree) and point `.env` at the same `DOWNLOADS_PATH` / `DATA_PATH`.

If downloads fail with bot checks, see [YouTube access](../ops/youtube-access.md). Broader fixes: [Troubleshooting](../ops/troubleshooting.md).

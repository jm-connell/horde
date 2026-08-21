# Install with Docker

Horde runs as a Docker Compose stack: the main `horde` app, a `bgutil-pot` sidecar for YouTube proof-of-origin tokens, and an optional `ollama` service behind the `ai` profile.

!!! warning "LAN only — no authentication"
    Horde has **no login**. Bind it to a trusted LAN only. Do not publish it to the public internet or reverse-proxy it without your own access control in front.

## Requirements

- Docker Engine and Docker Compose v2
- A host directory for media downloads
- A host directory for persistent app data (SQLite database and thumbnails)
- Enough disk for the library you plan to archive

## Quick start

From a clone of the repository:

```bash
cp .env.example .env
# edit .env — set PUID, PGID, DOWNLOADS_PATH, and DATA_PATH
docker compose up --build -d
```

Open the UI at:

```text
http://<server-ip>:8686
```

!!! note "Host port is 8686, not 8080"
    Compose publishes **host port 8686 → container port 8080**. The app listens on `8080` inside the container. Use `http://<server-ip>:8686` from your browser, not `:8080` on the host.

## Configure `.env`

Copy the example file and adjust the values for your host:

```bash
cp .env.example .env
```

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

If downloads fail with bot checks, see [YouTube access](../ops/youtube-access.md). Broader fixes: [Troubleshooting](../ops/troubleshooting.md).

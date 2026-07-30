# TrueNAS / Dockge

Horde is designed to run comfortably on TrueNAS with [Dockge](https://dockge.kuma.pet/) managing the Compose stack. The same `docker-compose.yml` works on any Docker host; this page covers the TrueNAS-specific path layout, ownership, and update caveats.

!!! warning "LAN only — no authentication"
    Horde has **no login**. Keep the Dockge stack on your trusted network. Do not port-forward `8686` to the internet.

## 1. Create a media dataset

Create a ZFS dataset (or directory) for archived video, for example:

```text
/mnt/tank/media/youtube_archive
```

This path becomes `DOWNLOADS_PATH` and is mounted into the container at `/downloads`.

Optionally share the dataset over SMB so you can drop `.mp4` / `.mkv` / `.webm` files from a desktop. The folder scanner (watchdog plus a poll every `SCAN_INTERVAL_SEC`, default **60** seconds) picks them up for [Import & review](../guides/import-review.md).

## 2. Set PUID and PGID

Find the UID/GID of the TrueNAS user that owns the media dataset:

- TrueNAS UI → **Credentials → Local Users**, or
- Shell: `id <username>`

Put those numbers in `.env`:

```env
PUID=1000
PGID=1000
```

The container writes downloads and app data as this user so files stay readable and writable over SMB instead of being owned by root.

## 3. Create the Dockge stack

1. Clone (or copy) the Horde repo into a Dockge stack folder, e.g. `/mnt/tank/dockge/stacks/horde`.
2. In Dockge, create a stack that uses this repo’s `docker-compose.yml`.
3. Copy env defaults and edit paths:

```bash
cp .env.example .env
```

Typical TrueNAS-oriented values:

```env
PUID=1000
PGID=1000
DOWNLOADS_PATH=/mnt/tank/media/youtube_archive
DATA_PATH=/opt/dockge/horde/data
SCAN_INTERVAL_SEC=60
```

| Variable | Mount inside container | Store here |
|----------|------------------------|------------|
| `DOWNLOADS_PATH` | `/downloads` | Media dataset (Channel / Year / files) |
| `DATA_PATH` | `/app/data` | Persistent DB + thumbnails (survive rebuilds) |

Ensure `DATA_PATH` exists and is writable by `PUID`/`PGID`. It must survive container recreation.

## 4. Start the stack

From the stack directory (or via Dockge’s deploy):

```bash
docker compose up --build -d
```

Open:

```text
http://<truenas-ip>:8686
```

!!! note "Port mapping"
    Compose maps **8686 (host) → 8080 (container)**. Use `:8686` in the browser. The process inside the container listens on `8080`.

### Sidecars

- **`bgutil-pot`** always starts with the stack and supplies PO tokens for yt-dlp. No manual token rotation.
- **`ollama`** is behind Compose profile `ai`. Enable local AI with:

```bash
docker compose --profile ai up -d
```

Or point Horde at Ollama on a GPU PC via `OLLAMA_BASE_URL` / Settings → AI. See [AI setup](../ops/ai-setup.md).

## 5. Updating on TrueNAS

!!! warning "Update on the host shell — not Dockge Bash"
    Run updates from the **TrueNAS shell** (or SSH to the host), in the Dockge stack folder. Do **not** use Dockge’s per-service **Bash** button: that opens a shell *inside* the Horde container, where `docker` and `git pull` against the host stack are not available.

```bash
cd /mnt/tank/dockge/stacks/horde   # your stack path
bash update.sh
```

`update.sh` pulls the latest code, builds with `HORDE_GIT_SHA=$(git rev-parse HEAD)`, and recreates containers. Full details: [Updating](updating.md).

Your library on `DOWNLOADS_PATH` and database on `DATA_PATH` are unchanged by a rebuild.

## Storage layout on disk

Downloads are stored as:

```text
Channel/Year/Title [id].ext
```

for example:

```text
/mnt/tank/media/youtube_archive/Some Channel/2024/Talk Title [dQw4w9WgXcQ].mp4
```

More detail: [Storage layout](../ops/storage-layout.md).

## Checklist

- [ ] Media dataset created and path set as `DOWNLOADS_PATH`
- [ ] `DATA_PATH` on durable storage
- [ ] `PUID` / `PGID` match the dataset owner
- [ ] Stack up; UI loads at `http://<truenas-ip>:8686`
- [ ] Optional SMB share for manual drops
- [ ] Know to run `bash update.sh` on the **host**, not in Dockge Bash

## Next steps

- [First run](first-run.md)
- [Environment variables](../ops/environment.md)
- [Ports & networking](../ops/ports-networking.md)
- [Settings](../settings/index.md)

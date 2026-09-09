# TrueNAS / Dockge

Horde is designed to run on TrueNAS with [Dockge](https://dockge.kuma.pet/) managing the Compose stack. The same `docker-compose.yml` works on any Docker host; this page is a **from-zero** TrueNAS path: datasets, clone into the stacks directory, env, and first deploy.

Horde is **built from git** on the host (`build: .`). The Dockge stack folder must be a full `git clone`, not a compose snippet pasted into **Add Stack**. Without the repo, Docker has no `Dockerfile` and the image cannot build. A GitHub ZIP also skips `.git`, so later [`update.sh`](updating.md) cannot `git pull`.

!!! warning "LAN only — no authentication"
    Horde has **no login**. Keep the Dockge stack on your trusted network. Do not port-forward `8686` to the internet.

## Prerequisites

- TrueNAS SCALE with **Apps / Docker** working (you can run other compose stacks)
- **Git** on the host (TrueNAS shell and SSH normally have it)
- A shell on the NAS: **System → Shell**, or SSH. Do **not** use Dockge’s per-service **Bash** button for clone/pull — that is inside a container
- [Dockge](https://github.com/louislam/dockge) already running, **or** install it first (next section)

## 0. Install Dockge (if you do not have it)

Dockge is a UI over Compose. Official install: [louislam/dockge](https://github.com/louislam/dockge). Two rules matter for Horde:

1. **Stacks directory** (`DOCKGE_STACKS_DIR`, Dockge default `/opt/stacks`) is where you will `git clone` Horde.
2. That directory must be mounted at the **same path** inside the Dockge container as on the host (`/mnt/tank/dockge/stacks:/mnt/tank/dockge/stacks`, not `/mnt/tank/dockge/stacks:/opt/stacks`). If the paths differ, `build: .` and Horde’s bind mounts resolve incorrectly.

On TrueNAS, put stacks on a **pool dataset**, not the small boot device, for example:

```text
/mnt/tank/dockge/stacks
```

After Dockge is up (usually `http://<truenas-ip>:5001`), confirm the stacks path in Dockge settings. The rest of this page uses `/mnt/tank/dockge/stacks` — substitute yours.

## 1. Create datasets

Create a ZFS dataset (or directory) for archived video, for example:

```text
/mnt/tank/media/youtube_archive
```

This path becomes `DOWNLOADS_PATH` and is mounted into the container at `/downloads`.

Create a **second** directory on the pool for app data (SQLite, settings, thumbnails). Do not keep this inside the git clone:

```text
/mnt/tank/apps/horde/data
```

This becomes `DATA_PATH` → `/app/data`. `.env.example` still mentions `/opt/dockge/horde/data`; prefer a dataset on `tank` so the database is not on the boot pool.

Optionally share the media dataset over SMB so you can drop `.mp4` / `.mkv` / `.webm` files from a desktop. The folder scanner (watchdog plus a poll every `SCAN_INTERVAL_SEC`, default **60** seconds) picks them up for [Import & review](../guides/import-review.md).

```bash
sudo mkdir -p /mnt/tank/media/youtube_archive /mnt/tank/apps/horde/data
```

You will `chown` these after you know `PUID`/`PGID`.

## 2. Set PUID and PGID

Find the UID/GID of the TrueNAS user that owns the media dataset:

- TrueNAS UI → **Credentials → Local Users**, or
- Shell: `id <username>`

You will put those numbers in `.env` in the next step. The container writes downloads and app data as this user so files stay readable and writable over SMB instead of being owned by root. Custom TrueNAS users are often **not** `1000` — copy the real values.

```bash
sudo chown -R <uid>:<gid> /mnt/tank/media/youtube_archive /mnt/tank/apps/horde/data
```

## 3. Clone into the Dockge stacks directory

Do **not** click **Add Stack** in Dockge and paste YAML. Clone the repo so the folder name is the stack name (`horde`):

```bash
cd /mnt/tank/dockge/stacks          # your DOCKGE_STACKS_DIR
git clone https://github.com/jm-connell/horde.git horde
cd horde
cp .env.example .env
```

If a leftover empty `horde` stack folder already exists from Add Stack, delete that stack in Dockge (or rename the folder) before cloning, or clone as a different name.

If you already have a clone and only need new commits:

```bash
cd /mnt/tank/dockge/stacks/horde
bash update.sh
```

## 4. Edit `.env`

In the stack folder (or Dockge’s **env** editor for this stack), set:

```env
PUID=1000
PGID=1000
DOWNLOADS_PATH=/mnt/tank/media/youtube_archive
DATA_PATH=/mnt/tank/apps/horde/data
SCAN_INTERVAL_SEC=60
```

| Variable | Mount inside container | Store here |
|----------|------------------------|------------|
| `DOWNLOADS_PATH` | `/downloads` | Media dataset (Channel / Year / files) |
| `DATA_PATH` | `/app/data` | Persistent DB + thumbnails (survive rebuilds) |

Ensure `DATA_PATH` exists and is writable by `PUID`/`PGID`. It must survive container recreation. Keep these values in `.env` so `update.sh` / `git pull` cannot fall back to the compose defaults. Do not replace the volume lines in `docker-compose.yml` with hardcoded `/mnt/...` paths.

## 5. Scan and deploy in Dockge

1. Open Dockge in the browser.
2. Top-right menu → **Scan Stacks Folder**. You should see a stack named `horde` (the folder name).
3. Open it. The compose file should be this repo’s `docker-compose.yml` (`build: .`, `8686:8080`, volumes from `${DOWNLOADS_PATH}` / `${DATA_PATH}`).
4. Confirm the env panel matches the `.env` you edited. Do **not** rewrite bind-mount paths in the compose editor.
5. Click **Deploy** / start. The **first** build pulls base images and compiles the frontend and wiki; watch the log until `horde` and `horde-bgutil-pot` are up.

From the host shell, the equivalent is:

```bash
cd /mnt/tank/dockge/stacks/horde
docker compose up --build -d
```

Open:

```text
http://<truenas-ip>:8686
```

!!! note "Port mapping"
    Compose maps **8686 (host) → 8080 (container)**. Use `:8686` in the browser. The process inside the container listens on `8080`.

Sanity check from the NAS:

```bash
curl -sf http://127.0.0.1:8686/api/health
```

### Sidecars

- **`bgutil-pot`** always starts with the stack and supplies PO tokens for yt-dlp. No manual token rotation.
- **`ollama`** is behind Compose profile `ai`. Enable local AI with:

```bash
docker compose --profile ai up -d
```

Or point Horde at Ollama on a GPU PC via `OLLAMA_BASE_URL` / Settings → AI. See [AI setup](../ops/ai-setup.md).

### GPU (optional)

Stock compose leaves GPU passthrough commented out, so Settings → System → Resources **GPU** shows **None detected**. That is expected. Horde does not need a GPU for default AV1 archives or 1080p H.264.

To pass a host NVIDIA / Intel / AMD device into the **`horde`** container (for 1440p/4K H.264/H.265 encode), uncomment the matching block in `docker-compose.yml` and recreate the stack. Do not isolate the GPU to another TrueNAS app. Full steps and whether you need it: [GPU](../ops/environment.md#gpu).

## 6. Updating on TrueNAS

!!! warning "Update on the host shell — not Dockge Bash"
    Run updates from the **TrueNAS shell** (or SSH to the host), in the Dockge stack folder. Do **not** use Dockge’s per-service **Bash** button: that opens a shell *inside* the Horde container, where `docker` and `git pull` against the host stack are not available.

```bash
cd /mnt/tank/dockge/stacks/horde   # your stack path
bash update.sh
```

`update.sh` pulls the latest code, records the running container’s volume mounts into `.env`, builds with `HORDE_GIT_SHA=$(git rev-parse HEAD)`, and recreates containers **only if** `DOWNLOADS_PATH` and `DATA_PATH` would stay the same. Full details: [Updating](updating.md).

Put host paths in `.env`, not in the compose file. `git pull` overwrites tracked `docker-compose.yml`; if you hardcoded `/mnt/...` volume lines in Dockge, that is what used to remount empty defaults and look like a settings wipe.

Your library on `DOWNLOADS_PATH` and database/settings on `DATA_PATH` are unchanged by a rebuild.

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

- [ ] Dockge stacks dir on the pool; host path equals container path
- [ ] Full `git clone` into that dir (not **Add Stack** paste, not a GitHub ZIP)
- [ ] Media dataset created and path set as `DOWNLOADS_PATH`
- [ ] `DATA_PATH` on durable pool storage, outside the git tree
- [ ] `PUID` / `PGID` match the dataset owner; dirs `chown`’d
- [ ] Dockge **Scan Stacks Folder**; stack deployed; UI at `http://<truenas-ip>:8686`
- [ ] Optional SMB share for manual drops
- [ ] Know to run `bash update.sh` on the **host**, not in Dockge Bash
- [ ] GPU optional — **None detected** is normal until you [pass a device in](../ops/environment.md#gpu)

## Next steps

- [First run](first-run.md)
- [Environment variables](../ops/environment.md)
- [Ports & networking](../ops/ports-networking.md)
- [Settings](../settings/index.md)

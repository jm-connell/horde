# TrueNAS / Dockge

Horde is designed to run on TrueNAS SCALE with [Dockge](https://dockge.kuma.pet/) managing the Compose stack. This page is a **from-zero** path: create two datasets, download Horde into Dockge's stacks folder, fill in four settings, and deploy. No Docker experience needed; each step says how to check it worked. Not on TrueNAS? Use [Install with Docker](install-docker.md).

**The short version:** a shell on the NAS → `git clone` Horde into Dockge's stacks folder → `cp .env.example .env` and set `PUID`, `PGID`, `DOWNLOADS_PATH`, `DATA_PATH` → Dockge **Scan Stacks Folder** → **Deploy** → open `http://<truenas-ip>:8686`.

The Dockge stack folder must be a full `git clone`, not a compose snippet pasted into **Add Stack**: the stack needs the repository's compose file, `.env.example` and the [`update.sh`](updating.md) script, and a GitHub ZIP skips `.git`, so `update.sh` could not update it later. The Horde image itself is downloaded (the published release image), not built on the NAS.

!!! warning "Trusted network"
    Create the admin account on first visit ([accounts](../ops/authentication.md)). Keep the Dockge stack on your trusted network by default. To expose it, follow the [internet exposure checklist](../ops/internet-exposure.md) instead of just forwarding `8686`.

## Prerequisites

- TrueNAS SCALE with **Apps / Docker** working (you can run other compose stacks)
- **Git** on the host (TrueNAS shell and SSH normally have it)
- A shell on the NAS: **System → Shell** in the TrueNAS web UI, or SSH. Do **not** use Dockge’s per-service **Bash** button for clone/pull — that is inside a container
- Commands that start with `docker` or `mkdir`/`chown` under `/mnt` need `sudo` in front when you are signed in as the TrueNAS admin user rather than `root`; the examples below include it
- [Dockge](https://github.com/louislam/dockge) already running, **or** install it first (next section)

## 0. Install Dockge (if you do not have it)

Dockge is a web UI over Docker Compose. Official install: [louislam/dockge](https://github.com/louislam/dockge). If you installed it from the TrueNAS **Apps** catalog instead, open its app settings to see which host folder holds the stacks and use that folder below. Two rules matter for Horde:

1. **Stacks directory** (`DOCKGE_STACKS_DIR`, Dockge default `/opt/stacks`) is where you will `git clone` Horde.
2. That directory must be mounted at the **same path** inside the Dockge container as on the host (`/mnt/tank/dockge/stacks:/mnt/tank/dockge/stacks`, not `/mnt/tank/dockge/stacks:/opt/stacks`). If the paths differ, Horde’s bind mounts resolve incorrectly.

On TrueNAS, put stacks on a **pool dataset**, not the small boot device, for example:

```text
/mnt/tank/dockge/stacks
```

After Dockge is up (usually `http://<truenas-ip>:5001`), confirm the stacks path in Dockge settings. The rest of this page uses `/mnt/tank/dockge/stacks` — substitute yours.

## 1. Create datasets

In the TrueNAS UI open **Datasets**, select your pool, and use **Add Dataset** (the *Generic* or *SMB* preset). Create one for archived video, for example:

```text
/mnt/tank/media/youtube_archive
```

This path becomes `DOWNLOADS_PATH` and is mounted into the container at `/downloads`.

Create a **second** directory on the pool for app data (SQLite, settings, thumbnails). Do not keep this inside the git clone:

```text
/mnt/tank/apps/horde/data
```

This becomes `DATA_PATH` → `/app/data`. Use a dataset on a pool such as `tank`, not the boot pool. Do not point `DATA_PATH` at an SMB or NFS mount: SQLite's WAL mode is unsafe on network filesystems.

Optionally share the media dataset over SMB so you can drop `.mp4` / `.mkv` / `.webm` / `.m4v` / `.mov` files from a desktop. The folder scanner (watchdog plus a poll every `SCAN_INTERVAL_SEC`, default **60** seconds) picks them up for [Import & review](../guides/import-review.md).

Prefer the shell? Plain folders work too (datasets just make snapshots and quotas easier):

```bash
sudo mkdir -p /mnt/tank/media/youtube_archive /mnt/tank/apps/horde/data
```

You will `chown` these after you know `PUID`/`PGID`.

## 2. Set PUID and PGID

`PUID` and `PGID` are the user and group Horde writes files as. Use the user you browse the media share with, so the files Horde downloads are yours over SMB instead of being owned by root. Find its numbers:

- TrueNAS UI → **Credentials → Local Users** (the **UID** column; the group is usually that user's own group with the same number), or
- Shell: `id <username>` prints `uid=3000(alex) gid=3000(alex) ...`

TrueNAS users you created are usually **not** `1000` (new users start at `3000`), so copy the real values. Do not use `0` (root); Horde refuses to start as root.

```bash
sudo chown -R 3000:3000 /mnt/tank/media/youtube_archive /mnt/tank/apps/horde/data   # your uid:gid
```

If the dataset uses ACLs (for example the SMB share preset), you can instead give that user **Modify** permission in **Datasets → Edit Permissions**; what matters is that this user can create folders and files in both.

## 3. Clone into the Dockge stacks directory

Do **not** click **Add Stack** in Dockge and paste YAML. Clone the repo so the folder name is the stack name (`horde`):

```bash
cd /mnt/tank/dockge/stacks          # your DOCKGE_STACKS_DIR
git clone https://github.com/jm-connell/horde.git horde
cd horde
git checkout -B horde-release "$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*')"
cp .env.example .env
```

The `git checkout` line switches to the newest release, so the compose file and scripts match the image you run (a fresh clone is on `main`, which is often ahead of the newest release). [Updates](updating.md) keep it on releases.

If `git clone` says *Permission denied*, the stacks folder belongs to root: run `sudo git clone https://github.com/jm-connell/horde.git horde`, then give the folder to your own user so later updates work without `sudo` (`sudo chown -R $(id -u):$(id -g) horde`), and continue with `cd horde` and the `git checkout` line. Check that it worked with `ls`: you should see `docker-compose.yml`, `Dockerfile` and `.env.example`.

If a leftover empty `horde` stack folder already exists from Add Stack, delete that stack in Dockge (or rename the folder) before cloning, or clone as a different name.

If you already have a clone and only need new commits:

```bash
cd /mnt/tank/dockge/stacks/horde
bash update.sh
```

## 4. Edit `.env`

`.env` holds your settings for this stack. Open it in the shell with `nano .env` (move with the arrow keys, save with **Ctrl+O** then **Enter**, quit with **Ctrl+X**), or, after step 5's scan, in the **.env** editor on the stack's page in Dockge. Fill in these lines with your values (the two paths start out empty, and Horde will not start until they are set) and leave the rest alone:

```env
PUID=3000
PGID=3000
DOWNLOADS_PATH=/mnt/tank/media/youtube_archive
DATA_PATH=/mnt/tank/apps/horde/data
SCAN_INTERVAL_SEC=60
```

| Variable | Mount inside container | Store here |
|----------|------------------------|------------|
| `DOWNLOADS_PATH` | `/downloads` | Media dataset (Channel / Year / files) |
| `DATA_PATH` | `/app/data` | Persistent DB + thumbnails (survive rebuilds) |

Ensure `DATA_PATH` exists and is writable by `PUID`/`PGID`. It must survive container recreation. Keep these values in `.env`: the compose file has no fallback paths and stops with `required variable DOWNLOADS_PATH is missing a value` when one is missing. Do not replace the volume lines in `docker-compose.yml` with hardcoded `/mnt/...` paths.

## 5. Scan and deploy in Dockge

1. Open Dockge in the browser.
2. Top-right menu → **Scan Stacks Folder**. You should see a stack named `horde` (the folder name).
3. Open it. The compose file should be this repo’s `docker-compose.yml` (`8686:8080`, volumes from `${DOWNLOADS_PATH}` / `${DATA_PATH}`).
4. Confirm the env panel matches the `.env` you edited. Do **not** rewrite bind-mount paths in the compose editor.
5. Click **Deploy** / start. The first start downloads the Horde image (about 300 MB); watch the log until `horde` and `horde-bgutil-pot` are up.

From the host shell, the equivalent is:

```bash
cd /mnt/tank/dockge/stacks/horde
sudo docker compose up -d
```

Wait until both containers show **running** (Dockge) or `docker compose ps` lists `horde` as `Up (healthy)`. If `horde` keeps restarting, its log says why; the usual causes are in [If something goes wrong](install-docker.md#if-something-goes-wrong).

Open:

```text
http://<truenas-ip>:8686
```

!!! note "Port mapping"
    Compose maps **8686 (host) → 8080 (container)**. Use `:8686` in the browser. The process inside the container listens on `8080`.

The first screen asks you to create the administrator account; then a short setup wizard runs. Continue with [First run](first-run.md).

Sanity check from the NAS shell (prints a line containing `"status":"ok"`):

```bash
curl -s http://127.0.0.1:8686/api/health
```

### Sidecars

- **`bgutil-pot`** always starts with the stack and supplies PO tokens for yt-dlp. No manual token rotation.
- **`ollama`** is behind Compose profile `ai`. Enable local AI with:

```bash
cd /mnt/tank/dockge/stacks/horde
sudo docker compose --profile ai up -d
```

Or point Horde at an AI server on a GPU PC (or a cloud provider) in Settings → AI. See [AI setup](../ops/ai-setup.md).

### GPU (optional)

Stock compose leaves GPU passthrough commented out, so Settings → System → Resources **GPU** shows **None detected**. That is expected. Horde does not need a GPU for AV1-only archives or H.264 up to 1080p.

To pass a host NVIDIA / Intel / AMD device into the **`horde`** container (for H.264 compatibility copies and 4K H.264 conversion), create `docker-compose.override.yml` in the stack folder from the TrueNAS shell (`nano /mnt/tank/dockge/stacks/horde/docker-compose.override.yml`) with the block for your GPU from [GPU](../ops/environment.md#pass-the-gpu-into-horde), then click **Deploy** in Dockge (or run `sudo docker compose up -d` in the stack folder; a plain restart does not apply it). Dockge's editor does not show that file, but Compose and Dockge read it. Do **not** uncomment the examples inside `docker-compose.yml` in Dockge's editor: the **Update now** button and `update.sh` stop when that file has local edits. Also do not isolate the GPU to another TrueNAS app. Whether you need a GPU at all: [GPU](../ops/environment.md#gpu).

## 6. Updating on TrueNAS

### The Update now button (recommended)

Set up the button once and later updates are one click in **Settings → System → Updates**, with no shell. Setup is a single TrueNAS Cron Job that runs `scripts/update_watch.sh` as `root` every minute. Follow the numbered steps in [Updating: one-time setup](updating.md#update-button-setup) (run the `--setup` check, then **System → Advanced Settings → Cron Jobs → Add**). To remove it later, disable the cron job.

### Updating from the shell

!!! warning "Update on the host shell — not Dockge Bash"
    Run shell commands (`update.sh`, `update_watch.sh --setup`) from the **TrueNAS shell** (or SSH to the host), in the Dockge stack folder. Do **not** use Dockge’s per-service **Bash** button: that opens a shell *inside* the Horde container, where `docker` and `git pull` against the host stack are not available. The **Update now** button needs none of this once the cron job exists.

```bash
cd /mnt/tank/dockge/stacks/horde   # your stack path
bash update.sh
```

`update.sh` pulls the latest code, records the running container’s volume mounts into `.env`, pulls the image of the new release, and recreates containers **only if** `DOWNLOADS_PATH` and `DATA_PATH` would stay the same. Full details: [Updating](updating.md).

Put host paths in `.env` and other changes (GPU, ports) in `docker-compose.override.yml`, never in `docker-compose.yml`. `update.sh` stops when `docker-compose.yml` has local edits (it saves your copy and tells you what to do, see [Local compose edits](updating.md#local-compose-edits)); hardcoded `/mnt/...` volume lines in Dockge's editor are what used to remount empty defaults and look like a settings wipe.

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
- [ ] Set up the **Update now** [cron job](updating.md#update-button-setup), or know to run `bash update.sh` on the **host**, not in Dockge Bash
- [ ] GPU optional — **None detected** is normal until you [pass a device in](../ops/environment.md#pass-the-gpu-into-horde) (in `docker-compose.override.yml`)

## Next steps

- [First run](first-run.md)
- [Environment variables](../ops/environment.md)
- [Ports & networking](../ops/ports-networking.md)
- [Settings](../settings/index.md)

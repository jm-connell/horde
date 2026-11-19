# Other platforms

[Install with Docker](install-docker.md) and [TrueNAS / Dockge](truenas-dockge.md) are the tested paths. Horde is one container plus a small helper, so any Docker host or container manager can run it. This page has recipes for the common ones. They all use the published image `ghcr.io/jm-connell/horde` (64-bit `amd64` and `arm64`), so nothing is built on your machine.

| You have | Follow |
|----------|--------|
| A Linux server, mini PC, VM or NAS with a shell (Ubuntu, Debian, Fedora, OpenMediaVault, ...) | [Install with Docker](install-docker.md) |
| TrueNAS SCALE | [TrueNAS / Dockge](truenas-dockge.md) |
| Raspberry Pi or another ARM board | [Raspberry Pi](#raspberry-pi), then Install with Docker |
| Proxmox | [Proxmox](#proxmox), then Install with Docker |
| Windows | [Windows](#windows) |
| macOS | [macOS](#macos) |
| Unraid, Synology, Portainer | The sections below |
| Anything else that runs containers | [Plain `docker run`](#plain-docker-run) |

Whatever the platform, Horde needs the same four things:

| Setting | Value |
|---------|-------|
| `PUID` / `PGID` | The user and group that own your media folder (`id -u` / `id -g`). Not `0`. |
| Media folder → `/downloads` | Where videos go. May be a network share. |
| Data folder → `/app/data` | Database, settings, thumbnails, backups. **Must be a local disk**, not SMB/NFS. |
| Port `8080` in the container | Publish it on any host port; the guides use `8686`. |

And the helper container `brainicism/bgutil-ytdlp-pot-provider` on the same Docker network, reachable as `YTDLP_POT_BASE_URL=http://<its name>:4416`. It lets YouTube downloads work without a Google login. Without it Horde runs, but YouTube downloads hit bot checks sooner.

!!! warning "Trusted network"
    The first visit creates the administrator account. Keep Horde on your home network or a VPN; see the [internet exposure checklist](../ops/internet-exposure.md) before opening it up.

## Raspberry Pi { #raspberry-pi }

A Raspberry Pi 4 or 5 with 4 GB of RAM or more runs Horde. It needs the **64-bit** Raspberry Pi OS (or another 64-bit OS): the images are `arm64` only, so the 32-bit OS cannot run them (`uname -m` prints `aarch64` on a 64-bit OS).

1. Install Docker with the official [Debian guide](https://docs.docker.com/engine/install/debian/), which is the one for 64-bit Raspberry Pi OS, then `sudo apt install git`.
2. Follow [Install with Docker](install-docker.md) from step 1.

Keep the media folder on a USB SSD or hard drive rather than the SD card, and put the data folder there too if you can (it is written often). A Pi has no hardware video encoder Horde can use, so leave **Playback compatibility** on **AV1 only** unless you need H.264 copies and can wait for them.

## Proxmox { #proxmox }

Run Horde in a Debian or Ubuntu **VM** (simplest), or in an **LXC container** with Docker inside: create it with **Nesting** turned on (Options → Features; an unprivileged container also needs **keyctl**). Then follow [Install with Docker](install-docker.md) inside the VM or container. Put the data folder on the guest's own disk, not on a share mounted from elsewhere. To use a media folder from the Proxmox host in an LXC container, add it as a mount point and set `PUID`/`PGID` to the owner as seen *inside* the container (an unprivileged container shifts IDs by 100000).

## Windows { #windows }

Horde runs on Windows through **WSL 2**, the Linux that Windows includes. Less tested than Linux; please report problems.

1. Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) with the WSL 2 backend (the default), and Ubuntu from the Microsoft Store (or `wsl --install -d Ubuntu` in PowerShell).
2. In Docker Desktop, **Settings → Resources → WSL integration**, turn on Ubuntu.
3. Open **Ubuntu** from the Start menu and follow [Install with Docker](install-docker.md) from step 1 in that terminal, skipping "Install Docker and Git" except `sudo apt install git`.

Keep both folders inside Ubuntu's own disk (such as `/home/<you>/horde-data`), not under `/mnt/c/...`: the Windows drives are mounted like a network share, where the database can corrupt. To reach the videos from Windows, open `\\wsl$\Ubuntu\home\<you>\horde-media` in File Explorer. Open Horde at `http://localhost:8686` on the PC; other devices use the PC's address, after allowing port 8686 in Windows Firewall. Update from the Ubuntu terminal with `bash update.sh`. The **Update now** button needs a cron job running in Ubuntu, which only runs while WSL keeps Ubuntu started, so the terminal is the dependable way here.

## macOS { #macos }

Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) (or OrbStack), then follow [Install with Docker](install-docker.md) from step 1 in Terminal (Git comes with the Xcode command line tools: `xcode-select --install`). Less tested than Linux; please report problems.

- Create the two folders under your home folder (`/Users/<you>/horde-media`, `/Users/<you>/horde-data`), which Docker Desktop shares by default.
- `id -u` / `id -g` print something like `501` / `20`: use those for `PUID` / `PGID`. If Horde's log says the media folder is not writable, run the `chown` from step 3 of the guide.
- Open Horde at `http://localhost:8686`. Docker Desktop must be running for Horde to run, and the Mac must stay awake for downloads.

## Portainer

Use a stack from the Git repository, so Portainer gets the same compose file as everyone else:

1. **Stacks → Add stack**, name it `horde`, build method **Repository**.
2. Repository URL `https://github.com/jm-connell/horde`, compose path `docker-compose.yml`.
3. Under **Environment variables**, add `PUID`, `PGID`, `DOWNLOADS_PATH` and `DATA_PATH` (full host paths). Or upload a filled-in copy of `.env.example` with **Load variables from .env file**.
4. **Deploy the stack**, then open `http://<host>:8686`.

## Synology (Container Manager)

DSM 7.2 and later run Compose files as **projects**:

1. In **File Station**, create a folder for the project (for example `docker/horde`), a media folder and a data folder on a local volume (not a mounted share).
2. Download `docker-compose.yml` and `.env.example` from the [repository](https://github.com/jm-connell/horde) into the project folder, and rename `.env.example` to `.env`.
3. Edit `.env`: `PUID` / `PGID` of the DSM user that owns the media folder (Control Panel → User, or `id` over SSH), and the full paths, which on Synology start with `/volume1/...`.
4. **Container Manager → Project → Create**, choose the project folder, use the existing `docker-compose.yml`, and finish the wizard.
5. Open `http://<nas>:8686`.

A Synology without SSH can still run Horde, but [`update.sh`](updating.md) and the **Update now** button need a shell and a git checkout. Update with the project's **pull and redeploy** instead (below).

## Unraid

Unraid's own templates manage one container at a time, and Horde wants two. The simplest route is the **Docker Compose Manager** plugin (from Community Applications):

1. Install **Docker Compose Manager** from the **Apps** tab.
2. Create a share for media. Horde's data goes in `appdata` on the cache pool.
3. In a terminal: `git clone https://github.com/jm-connell/horde.git /mnt/user/appdata/horde-stack`, then `cd /mnt/user/appdata/horde-stack` and `git checkout -B horde-release "$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*')"` (moves the checkout to the newest release, so it matches the image). If `git` is missing, install it first (for example with the NerdTools plugin).
4. **Docker → Compose → Add new stack**, point it at that folder (Advanced → stack directory), then edit the stack's `.env`: `PUID=99`, `PGID=100` (Unraid's `nobody:users`, the usual owner of shares), `DOWNLOADS_PATH=/mnt/user/<media share>`, `DATA_PATH=/mnt/cache/appdata/horde` (your pool's name instead of `cache`). Give the database a pool path, not `/mnt/user/...`: the user-share layer is not a safe place for SQLite.
5. **Compose Up**, then open `http://<server>:8686`.

Because the stack folder is a git clone, `bash update.sh` from the Unraid terminal works too.

## Plain `docker run`

Without Compose, create a network so the two containers find each other, then start the helper and Horde:

```bash
docker network create horde
```

```bash
docker run -d --name horde-bgutil-pot --network horde --init \
  --restart unless-stopped brainicism/bgutil-ytdlp-pot-provider:2.0.2
```

```bash
docker run -d --name horde --network horde --init --restart unless-stopped \
  -p 8686:8080 \
  -e PUID=1000 -e PGID=1000 \
  -e YTDLP_POT_BASE_URL=http://horde-bgutil-pot:4416 \
  -v /path/to/media:/downloads \
  -v /path/to/horde-data:/app/data \
  --add-host host.docker.internal:host-gateway \
  --security-opt no-new-privileges:true \
  --stop-timeout 40 \
  ghcr.io/jm-connell/horde:latest
```

`--stop-timeout 40` gives Horde the time Compose gives it to finish a stop cleanly (Docker's default is 10 seconds).

Replace the two `/path/to/...` folders with folders you created and own as `PUID`:`PGID`. Every other setting in [Environment variables](../ops/environment.md) is another `-e NAME=value`.

## Updating { #updating }

With the published image, an update is "pull the new image and recreate the container":

| Platform | How |
|----------|-----|
| Portainer | Open the stack → **Pull and redeploy** (tick **Re-pull image**). |
| Synology | Over SSH: `cd /volume1/docker/horde && sudo docker compose pull && sudo docker compose up -d` (your project folder). Without SSH: stop the project, update the `ghcr.io/jm-connell/horde` image in Container Manager's **Image** list, and start the project again. |
| Unraid (Compose Manager) | **Update Stack**, or `bash update.sh` in the stack folder. |
| `docker run` | `docker pull ghcr.io/jm-connell/horde:latest`, then `docker rm -f horde` and the `docker run` command again. |

Your videos and data live in the two folders and survive this. Horde backs up its database before running a migration (in `DATA_PATH/backups/`), but only [`update.sh`](updating.md) checks health afterwards and rolls back by itself. Pin a version (`:1.2.2` instead of `:latest`) to choose when you move. After an update, hard-refresh the browser (`Ctrl+Shift+R`).

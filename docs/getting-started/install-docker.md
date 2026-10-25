# Install with Docker

This page takes you from a machine with nothing on it to Horde running in your browser. It assumes no Docker experience: every command is spelled out, and each step says how to check that it worked. Plan on 15–30 minutes, most of it waiting for the first build.

Using **TrueNAS with Dockge**? Follow [TrueNAS / Dockge](truenas-dockge.md) instead; it covers the same steps with TrueNAS screens.

!!! warning "Trusted network"
    The first visit creates the admin account ([accounts](../ops/authentication.md)). Keep Horde on your home network or a VPN such as Tailscale. To put it on the internet, follow the [internet exposure checklist](../ops/internet-exposure.md) first.

## A few words first

You only need these to follow along:

| Word | What it means here |
|------|--------------------|
| **Host** (or server) | The computer Horde runs on: a NAS, a mini PC, a spare desktop, a VM. Commands on this page are typed on the host. |
| **Container** | A sealed box the app runs in. Horde's box cannot see your files unless you hand it a folder. |
| **Image** | The template a container is made from. Horde's image is **built on your host** from this repository (there is no Docker Hub image). |
| **Docker Compose** | Reads `docker-compose.yml` and starts all of Horde's containers with one command. |
| **`.env`** | A small text file next to `docker-compose.yml` with *your* settings: which folders to use, which user owns the files. |
| **Volume / bind mount** | A folder on the host handed to the container. Horde gets two: one for videos, one for its database. Anything outside them is thrown away when the container is rebuilt. |

## What you need

- A 64-bit **Linux** host (x86 or ARM) with **Docker Engine** and the **Docker Compose plugin**. Windows and macOS (Docker Desktop) are not tested.
- **Git**, to download Horde and to update it later.
- A few GB free for the build, plus room for the videos you plan to keep.
- Internet access during the build (it downloads base images and packages).
- A terminal on the host: open one directly, or connect with `ssh you@<server-ip>`.

### Install Docker and Git

If `docker compose version` already prints a version, skip ahead. Otherwise install Docker with the official guide for your distribution: [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) (Ubuntu and Debian also have a one-line [convenience script](https://docs.docker.com/engine/install/ubuntu/#install-using-the-convenience-script)). Then install Git, for example `sudo apt install git` on Debian/Ubuntu or `sudo dnf install git` on Fedora.

Check both:

```bash
docker compose version   # Docker Compose version v2.x or newer
git --version
```

If the first line says `docker: 'compose' is not a docker command`, you have the old standalone `docker-compose`; install the Compose plugin from the Docker guide above.

!!! note "`permission denied` from Docker? Use `sudo`"
    On most Linux hosts only `root` may talk to Docker. If a `docker` command fails with *permission denied … docker.sock*, put `sudo` in front of it (`sudo docker compose up --build -d`). Every command on this page works the same way with `sudo`. To drop the `sudo`, add yourself to the `docker` group with `sudo usermod -aG docker $USER`, then log out and back in (that group is equivalent to root access).

## 1. Download Horde

Pick where Horde's program files will live (your home folder is fine) and clone the repository there:

```bash
cd ~
git clone https://github.com/jm-connell/horde.git
cd horde
```

You are now inside the `horde` folder. Every later command on this page is run from here; if you open a new terminal, `cd ~/horde` first.

Use `git clone`, not GitHub's **Download ZIP**: a ZIP has no `.git` folder, so [updates](updating.md) cannot work later.

## 2. Create two folders for Horde's files

Horde keeps two kinds of files outside its container:

| Folder | Holds | `.env` name |
|--------|-------|-------------|
| Media | The videos, sorted as `Channel/Year/Title [id].mp4` | `DOWNLOADS_PATH` |
| Data | The database, settings, thumbnails and backups | `DATA_PATH` |

Put them **outside** the `horde` folder, on the disk with the most space. For example, for a user named `alex`:

```bash
mkdir -p /home/alex/horde-media /home/alex/horde-data
```

Write down both full paths; you need them in the next step. Paths must start with `/`.

!!! danger "The data folder must be on a local disk"
    `DATA_PATH` holds a SQLite database, which can be corrupted on a network share (SMB/NFS). Keep it on a disk inside the host. The media folder may be a network share.

## 3. Tell Horde about your folders and user

Find your user and group ID. Horde writes files as this user, so you can open, move and delete them later without `sudo`:

```bash
id -u   # your user ID, often 1000
id -g   # your group ID, often 1000
```

Copy the example settings file and open it in a text editor:

```bash
cp .env.example .env
nano .env
```

Change these four lines near the top (use your own numbers and paths; leave everything else alone):

```env
PUID=1000
PGID=1000
DOWNLOADS_PATH=/home/alex/horde-media
DATA_PATH=/home/alex/horde-data
```

In `nano`: move with the arrow keys, save with **Ctrl+O** then **Enter**, quit with **Ctrl+X**.

!!! warning "Do not keep the example paths"
    `.env.example` ships TrueNAS-style paths (`/mnt/tank/...`, `/opt/dockge/...`). On any other machine they do not exist, and Docker silently creates them **owned by root**. Horde then cannot save downloads. Always point both paths at folders you created.

Make sure that user owns both folders (use the numbers from `id -u` and `id -g`):

```bash
sudo chown -R 1000:1000 /home/alex/horde-media /home/alex/horde-data
```

Horde fixes the ownership of the data folder by itself on start; the media folder is left exactly as you set it, so this step matters for it.

## 4. Build and start Horde

```bash
docker compose up --build -d
```

What this does: builds the Horde image from the source you cloned, downloads the small `bgutil-pot` helper (it lets YouTube downloads work without a Google login), and starts both in the background (`-d`). The **first build takes several minutes**, longer on a low-power NAS, and prints a lot of output. It is finished when you get your prompt back with lines like `Container horde  Started`.

Check that it is running:

```bash
docker compose ps
```

You should see `horde` and `horde-bgutil-pot` with status `Up`. Within about a minute `horde` also shows `(healthy)`. If it says `Restarting` or `Exited`, see [If something goes wrong](#if-something-goes-wrong).

## 5. Open Horde and create your account

In a browser on any device on your network, open:

```text
http://<server-ip>:8686
```

Replace `<server-ip>` with the host's address (find it with `hostname -I` or `ip addr`; it usually looks like `192.168.x.x`). On the host itself, `http://localhost:8686` works too.

!!! note "Port 8686, not 8080"
    Horde listens on 8080 *inside* its container; Compose publishes it on **8686** on the host. Use `:8686` in the browser. To use another port, see [Change the port](../ops/ports-networking.md#change-the-port).

The first screen asks you to create the **administrator** account (a username and a password of at least 8 characters). A short setup wizard follows; every choice in it can be changed later, and **Use defaults** skips it. Then continue with [First run](first-run.md) to download your first video.

## Everyday commands

Run these from the `horde` folder (add `sudo` if you needed it above):

| To… | Run |
|-----|-----|
| See whether Horde is running | `docker compose ps` |
| Watch Horde's log (Ctrl+C to stop watching) | `docker compose logs -f horde` |
| Stop Horde | `docker compose down` |
| Start it again | `docker compose up -d` |
| Apply a change you made to `.env` | `docker compose up -d` |
| Update to a new version | `bash update.sh` ([Updating](updating.md)) |

Stopping or rebuilding never deletes your videos or settings: they live in the two folders from step 2. Horde starts again by itself after the host reboots.

## Optional extras

**AI features.** Nothing to install for a cloud provider: paste an API key in the setup wizard or [Settings → AI](../settings/ai.md). To run models on this machine with the bundled Ollama, see [AI setup](../ops/ai-setup.md#bundled-ollama-run-ollama-for-me).

**A GPU.** Not needed for downloading, browsing or playing. It only speeds up making H.264 copies for devices that cannot play AV1. See [GPU](../ops/environment.md#gpu); settings like this go in a `docker-compose.override.yml`, never in `docker-compose.yml` itself, so updates keep working.

**Dropping in your own files.** Copy `.mp4`, `.mkv` or `.webm` files into the media folder (for example over an SMB share) and they show up under **Import** within a minute ([Import & review](../guides/import-review.md)).

**More settings.** Every option you can put in `.env` is listed under [Environment variables](../ops/environment.md). After editing `.env`, run `docker compose up -d`.

## What Compose starts

| Service | When it runs | Role |
|---------|--------------|------|
| `horde` | Always | The app: web UI, API, downloads, player (container port 8080, host port 8686) |
| `bgutil-pot` | Always | Proof-of-origin tokens for YouTube, without a Google login |
| `ollama` | Only with `--profile ai` | Optional bundled Ollama for local AI ("Run Ollama for me") |

## If something goes wrong { #if-something-goes-wrong }

Start with the log: `docker compose logs --tail=50 horde`. The cause is usually in the last few lines.

| Problem | Fix |
|---------|-----|
| `permission denied while trying to connect to the Docker daemon socket` (newer Docker: `… to the docker API at unix:///var/run/docker.sock`) | Put `sudo` in front of the command (see the note under [Install Docker and Git](#install-docker-and-git)). |
| `docker: 'compose' is not a docker command` | Install the Docker Compose plugin (step [Install Docker and Git](#install-docker-and-git)). |
| `unable to prepare context` / `Dockerfile not found` | You are not in the `horde` folder. `cd ~/horde` (or wherever you cloned it) and run the command again. |
| `horde` keeps restarting, log says `refusing to run as root` | `PUID` or `PGID` in `.env` is `0`. Set them to your own `id -u` / `id -g`. |
| Downloads fail with *permission denied*, or the log mentions `/downloads` | The media folder is not owned by `PUID`:`PGID`. Rerun the `chown` from step 3 with the right numbers, then `docker compose up -d`. If you left the example paths in `.env`, fix them first. |
| Browser cannot connect | Check `docker compose ps`, use port **8686** (not 8080), and use the host's LAN address. A firewall on the host (for example `ufw`) may need `sudo ufw allow 8686/tcp`. |
| Browser shows `host_not_allowed` | You opened Horde under a domain name (for example `horde.mydomain.com`). Add `HORDE_ALLOWED_HOSTS=horde.mydomain.com` to `.env`, then `docker compose up -d`. Plain IP addresses, `localhost`, single-word names and `*.local` / `*.lan` names always work. |
| The page looks old or broken after an update | Hard-refresh the browser: **Ctrl+Shift+R** (Mac: **Cmd+Shift+R**). |
| Forgot the admin password | **Forgot password?** on the sign-in page, or `docker exec -it horde python -m app.cli reset-password <username>` ([Accounts](../ops/authentication.md)). |
| `fatal: not a git repository` when updating | Horde was installed from a ZIP. Clone it again with `git clone` (step 1) and reuse the same `.env`; your videos and data are untouched. |

YouTube downloads failing with "sign in to confirm you're not a bot"? See [YouTube access](../ops/youtube-access.md). Everything else: [Troubleshooting](../ops/troubleshooting.md).

## Next steps

1. [First run](first-run.md): download a video and find it in the library
2. [Updating](updating.md): the **Update now** button and `update.sh`
3. [Backup & restore](../ops/backup-restore.md): what to back up
4. [Remote access](../ops/remote-access.md): watch away from home over a VPN

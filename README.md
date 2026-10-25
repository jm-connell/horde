# Horde

This entire project was vibecoded ~~in a relatively short amount of time~~. I've used Plex for a long time, but I really don't like how it handles "Other" videos that aren't Movies and TV. There are lots of YouTube and other videos that I want to archive and "horde" (hoard) but still be able to find and watch them in an organized way. I looked a bit at TubeArchivist and it looks decent, but I wanted to make something exactly the way I envisioned it, and since I had a lot of credit left for the month on my Cursor subscription I figured I'd let it rip. Horde gives a clean frontend to browse and search your videos on your server, and it also has a GUI for yt-dlp to download videos directly from any supported website (though I haven't tested much outside of YouTube). You can also drop in any video file from your computer, upload it directly to Horde's storage directory, and adjust metadata in the Horde UI.

I also made some AI features like auto tagging, video summary and chat, and enhanced search. This works with any OpenAI-compatible provider: OpenRouter, OpenAI, Gemini, Groq, or your own Ollama / LM Studio / llama.cpp server. If you want to use Ollama you'll need some kind of GPU on your host machine. I have a 1660 Super but use OpenRouter anyway because it's lower maintenance, faster, and it costs virtually nothing for this app.

There is also the ability to stream videos directly from YouTube, though it is somewhat fragile and quality can vary from video to video. It's mostly functional, but streaming is not the primary focus of Horde. The idea is more that you can stream the video to preview, then choose to download or not. 

I don't take credit for creating this, it was all Opus 4.8, Composer 2.5, and recently, Grok 4.5 and 4.6. I built it specifically for my use case, TrueNAS with Dockge. There may or may not be updates in the future, depending on how much I end up using this day to day. Try it out, and if you want to change anything then I welcome you to download the repo, boot it up with your AI-enabled IDE of choice, and get vibecoding. If you have any questions the best way to handle it is to open this repo in Cursor and use the Ask mode (that's what I do). Hope you enjoy.

--

FastAPI serves a built React UI (and an in-app MkDocs wiki) from one container.
Compose always starts a [bgutil POT](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
sidecar for YouTube; Ollama is an optional profile. Built for TrueNAS / Dockge,
works on any Docker host.

**Accounts.** The first visit asks you to create the admin account (nothing else works until you do), and the admin adds other people, each with their own watch history, AI chats and look; members get only the permissions the admin grants. Lost the admin password: `docker exec -it horde python -m app.cli reset-password <user>`. Optional two-step sign-in (authenticator app and recovery codes) can be required of everyone. Behind an authenticating reverse proxy see `HORDE_AUTH_DISABLED`. Horde is built for a trusted LAN or VPN and is meant to stay there by default; to reach it from the internet anyway, follow the [internet exposure checklist](docs/ops/internet-exposure.md) first. See [Accounts and sign-in](docs/ops/authentication.md).

Full docs ship in the image: **Settings → System → Documentation**, or `/wiki/`
on the host. Interactive API docs: `/docs`.

## Features

- **Downloads** — paste a yt-dlp URL, pick a quality preset, watch a FIFO queue
  with live progress, pause/resume, and YouTube playlist import.
- **On disk** — `Channel/Year/Title [id].ext` so SMB browsing matches the UI.
- **Import** — drag-and-drop upload or drop `.mp4` / `.mkv` / `.webm` into the
  media folder; a review queue before they join the library.
- **Library** — channel sidebar, YouTube channel catalogs (browse / preview /
  download undownloaded uploads), hybrid search, tags, bulk select, continue
  watching.
- **Player** — standard / theater / windowed, mini player, PiP, Chromecast,
  SponsorBlock, chapters, subtitles. Optional YouTube stream preview (fragile;
  no live transcoding — the browser plays the original, or a pre-made
  ≤1080p H.264 copy on devices that can't decode AV1).
- **Live streams** — follow channels and see, quietly in the sidebar, which are
  live; watch through a server-side HLS proxy with scrub-back (DVR).
- **Playlists** — your own lists or imported YouTube playlists.
- **AI** (optional) — any OpenAI-compatible provider (OpenRouter, OpenAI, Ollama, LM Studio, …) for embeddings, tags, summaries,
  chat, recommendations, and duplicate help.

## Screenshots

![Library home with constellation background, channel sidebar, and video grid](docs/assets/screenshots/library.webp)

![Download page with URL field, quality presets, and queue](docs/assets/screenshots/downloads.webp)

![Watch page with the Horde player](docs/assets/screenshots/player.webp)

## Quick start

Full walkthroughs: [Install with Docker](https://jm-connell.github.io/horde/getting-started/install-docker/)
and [TrueNAS / Dockge](https://jm-connell.github.io/horde/getting-started/truenas-dockge/).

### Requirements

- 64-bit Linux host with Docker, the Docker Compose plugin (`docker compose
  version` reports v2 or newer) and Git.
- Run all commands in a shell on the host (SSH or the TrueNAS shell), not in
  Dockge's per-container **Bash** button.
- If Docker reports `permission denied`, prefix `docker` commands with `sudo`.

### 1. Clone

There is no Docker Hub image; Compose builds it from this repo. Use
`git clone`, not a ZIP, so `update.sh` can update it later.

```bash
git clone https://github.com/jm-connell/horde.git
cd horde
```

TrueNAS / Dockge: clone into the Dockge stacks folder so the folder name is the
stack name. Do not use **Add Stack** with only `docker-compose.yml`; the build
needs the whole repo.

```bash
cd /mnt/tank/dockge/stacks          # your DOCKGE_STACKS_DIR
git clone https://github.com/jm-connell/horde.git horde
cd horde
```

### 2. Create folders

Create a media folder and a data folder outside the repo, owned by the user
Horde should write files as (`id -u` / `id -g`):

```bash
mkdir -p /home/you/horde-media /home/you/horde-data
sudo chown -R 1000:1000 /home/you/horde-media /home/you/horde-data
```

### 3. Configure

```bash
cp .env.example .env
```

Set these in `.env`:

| Variable | Value |
|----------|-------|
| `PUID` / `PGID` | Output of `id -u` / `id -g` (TrueNAS: Credentials → Local Users). Not `0`. |
| `DOWNLOADS_PATH` | Full path of the media folder. May be a network share. |
| `DATA_PATH` | Full path of the data folder (database, thumbnails). Must be a local disk, not SMB/NFS: SQLite can corrupt on network filesystems. |

The example values are TrueNAS paths. On other machines Docker creates missing
paths owned by root, and Horde cannot save downloads there. Keep paths in
`.env`, not in `docker-compose.yml`.

### 4. Start

```bash
docker compose up --build -d
```

Dockge: menu → **Scan Stacks Folder**, open `horde`, **Deploy**. Do not edit
the volume lines in the compose editor. The first build takes several minutes.

### 5. Open

Go to `http://<server-ip>:8686` (host port 8686, not 8080), create the admin
account and complete the setup wizard. To verify: `docker compose ps` shows
`horde` as `Up (healthy)`, and `curl -s http://127.0.0.1:8686/api/health`
returns `"status":"ok"`. Common errors:
[troubleshooting table](https://jm-connell.github.io/horde/getting-started/install-docker/#if-something-goes-wrong).

### Optional

- **Imports:** `.mp4` / `.mkv` / `.webm` files copied into the media folder
  (for example over SMB) appear in **Import** within `SCAN_INTERVAL_SEC`
  (default 60s).
- **AI:** choose a provider in the setup wizard or Settings → AI (any
  OpenAI-compatible URL, plus an API key if required). For local models without
  your own server, run `docker compose --profile ai up -d` and choose "Run
  Ollama for me". Docker networking: [AI setup](docs/ops/ai-setup.md).
- **GPU or a different port:** put these in `docker-compose.override.yml` next
  to `docker-compose.yml`. Compose reads it automatically and updates do not
  touch it. See [GPU](https://jm-connell.github.io/horde/ops/environment/#gpu)
  and [Change the port](https://jm-connell.github.io/horde/ops/ports-networking/#change-the-port).

### Update

Administrators can update from the app: **Settings → System → Updates → Update now**.
It needs a one-time setup, a cron job on the host that runs
`scripts/update_watch.sh` every minute as root (TrueNAS: System → Advanced
Settings → Cron Jobs). Horde itself never gets Docker access; the button only
leaves a request file that the job picks up. Steps and troubleshooting:
[Updating](docs/getting-started/updating.md#update-from-the-app).

The button runs the same script as the shell. From the same clone, on the host:

```bash
cd /path/to/horde          # e.g. /mnt/tank/dockge/stacks/horde
bash update.sh
```

That snapshots live volume mounts into `.env`, backs up the SQLite database,
moves the checkout to the newest release tag (`HORDE_UPDATE_CHANNEL=main`
follows every commit instead), rebuilds with the version baked in (tagged
`horde:<shortsha>`), recreates containers, and waits on `/api/health`. If the
new version is not healthy it rolls back automatically; `bash update.sh
--rollback` goes back on demand. Media and settings on host volumes are
preserved. Hard-refresh the browser (`Ctrl+Shift+R`). Do not `git reset
--hard` to unstick a pull. Details: [Updating](docs/getting-started/updating.md).

Prefer not to build on the NAS? Tagged releases are published as multi-arch
images to `ghcr.io/jm-connell/horde`; see "Use the published image" in the
same page.

If you use Dockge, refresh it so it reloads compose — do **not** click
**Deploy** with a stale editor (the script already recreated the stack).

yt-dlp is **pinned** in `backend/requirements.txt` at image build time; pull
+ rebuild is how you pick up a newer pin. Set `YTDLP_AUTO_UPDATE=1` in `.env`
to fetch the newest yt-dlp on every container start instead (opt-in).

Longer walkthroughs: [`docs/getting-started/install-docker.md`](docs/getting-started/install-docker.md),
[`docs/getting-started/truenas-dockge.md`](docs/getting-started/truenas-dockge.md),
[`docs/getting-started/updating.md`](docs/getting-started/updating.md).

## Local development

```bash
./start.sh          # Linux: backend :8080 + Vite ~5173
# Windows: dev.bat
```

Open the Vite URL (usually `http://localhost:5173`). Wiki build runs unless
you set `SKIP_WIKI=1`. Tests: `pytest` in `backend/`, `npm test` in
`frontend/`. CI (pytest, Vitest, wiki, Docker image) runs on every GitHub
push — see [`docs/getting-started/testing.md`](docs/getting-started/testing.md).

## Configuration

| Variable | Purpose |
|----------|---------|
| `PUID` / `PGID` | UID/GID the container uses for files (default `1000`) |
| `DOWNLOADS_PATH` | Host media dataset → `/downloads` |
| `DATA_PATH` | Host DB + thumbnails → `/app/data` |
| `SCAN_INTERVAL_SEC` | Folder rescan interval (default `60`) |
| `HORDE_LIVE_POLL_SEC` | Seconds between live checks of a followed channel (default `300`, `0` = off) |
| `YTDLP_POT_BASE_URL` | Compose: `http://bgutil-pot:4416` |
| `YTDLP_COOKIE_FILE` | Optional Netscape cookies (age gates / hard blocks) |
| `OLLAMA_BASE_URL` | Legacy fallback when Settings → AI has no provider URL |
| `OPENROUTER_API_KEY` | Optional; overrides the saved key while the provider is OpenRouter |
| `HORDE_GITHUB_REPO` | Repo for in-app update checks |
| `HORDE_UPDATE_CHANNEL` | `update.sh` only: `release` (default), `prerelease` or `main` |
| `HORDE_ALLOWED_HOSTS` | Extra `Host` names to accept (public names behind a reverse proxy) |
| `HORDE_TRUST_PROXY` | `1` behind a proxy you control: trust `X-Forwarded-For` / `-Proto` |
| `HORDE_AUTH_DISABLED` | `1` only when a proxy authenticates users and is the only way in |

Full list: `/wiki/` → Configuration & ops → Environment variables, or
[`docs/ops/environment.md`](docs/ops/environment.md).

## YouTube access

Compose always runs `bgutil-pot` so proof-of-origin tokens are generated
without a Google login. Keep download concurrency modest (`MAX_DOWNLOAD_CONCURRENCY`,
default 2) to reduce IP flagging.

If extracts still fail with bot / sign-in errors, check Settings → System
(POT health, last extract failure). Cookie fallbacks: `YTDLP_COOKIE_FILE` or
`YTDLP_COOKIES_FROM_BROWSER`. Details:
[`docs/ops/youtube-access.md`](docs/ops/youtube-access.md).

## Documentation

| Topic | Where |
|-------|--------|
| Public wiki (GitHub Pages) | [jm-connell.github.io/horde](https://jm-connell.github.io/horde/) |
| Install, TrueNAS, first run, updates | `/wiki/` → Getting started |
| Library, player, downloads, AI | `/wiki/` → Using Horde |
| Every setting | `/wiki/` → Settings |
| Env vars, storage, troubleshooting | `/wiki/` → Configuration & ops |
| Architecture & design rationale | `/wiki/` → Architecture (start with the architecture map) / Design decisions / Decision records |
| API (Swagger) | `/docs` |

Source Markdown lives in [`docs/`](docs/) and is built into the image with
MkDocs Material. The same site is deployed to GitHub Pages from `main`.

## Notes

- Playback compatibility (Settings → Library): AV1 only (default), H.264 up to 1080p, H.264 full resolution (converts 1440p/4K, replacing originals), or AV1 + a ≤1080p H.264 copy beside the original. The player picks whichever file the device can decode. H.264 encodes use a GPU encoder when passed into the container, otherwise software.
- Channel catalogs (index remote uploads for feed search and stream preview)
  are YouTube-only. Non-YouTube yt-dlp URLs still download.
- Health: `GET /api/health` (version, yt-dlp, POT, wiki, library count when signed in; anonymous callers get only `status`, `setup_required` and `auth_required`), `GET /api/ready` (database, migrations and workers; `503` when not ready), `GET /api/ping` (liveness).

## License

Horde is **source-available** under the
[PolyForm Noncommercial License 1.0.0](LICENSE). You can run, change, and
share it for personal / homelab use (and other noncommercial purposes). You
may not sell it, offer it as a paid product or hosted service, or otherwise
use it commercially. Full terms: [`LICENSE`](LICENSE).

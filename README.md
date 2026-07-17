# Horde

This entire project was vibecoded in a relatively short amount of time. I've used Plex for a long time, but I really don't like how it handles "Other" videos that aren't Movies and TV. There are lots of YouTube and other videos that I want to archive and "horde" (hoard) but still be able to find and watch them in an organized way. I looked a bit at TubeArchivist and it looks decent, but I wanted to make something exactly the way I envisioned it, and since I had a lot of credit left for the month on my Cursor subscription I figured I'd let it rip. Horde gives a clean frontend to browse and search your videos on your server, and it also has a GUI for yt-dlp to download videos directly from any supported website (though I haven't tested much outside of YouTube).

I don't take credit for creating this, it was all Opus 4.8, Composer 2.5, and recently, Grok 4.5. I built it specifically for my use case, TrueNAS with Dockge. There may or may not be updates in the future, depending on how much I end up using this day to day. I would like to integrate some (small) local AI models to help with video search, organization, and recommendations. Try it out, and if you want to change anything then I welcome you to download the repo, boot it up with your AI-enabled IDE of choice, and get vibecoding. A demo may or may not be coming soon. If you have any questions the best way to handle it is to open this repo in Cursor and use the Ask mode (that's what I do). Hope you enjoy. Everything that follows is the AI-generated readme.

--

A self-hosted media downloader and library for your homelab. Paste a YouTube
(or other yt-dlp supported) link to download it straight to your server with
metadata and thumbnails, then browse and watch everything through a dark,
YouTube-style web UI.

This is a single-container app (FastAPI backend serving a built React frontend)
designed to run on TrueNAS via Dockge, but it works with any Docker host.

## Features

- URL ingestion with quality presets and a live progress bar (yt-dlp).
- Automatic metadata, tags, subtitles (WebVTT), and thumbnail extraction; files
  are stored under `/<channel>/<year>/<title>.ext`.
- Folder scanner (watchdog + 60s polling fallback) that detects manually
  dropped `.mp4` / `.mkv` / `.webm` files and queues them for review.
- Edit any video's metadata, notes, and thumbnail (not just review items), and
  rename a channel across every video at once.
- Playlists: build your own or import a public YouTube playlist; both are
  browsed and played the same way.
- Playback queue with auto-advance, a floating mini-player that keeps playing
  while you browse, and a Picture-in-Picture button.
- Home page with library grid, continue watching, and (when Ollama is connected)
  a Recommended tab with history-based shelves and browse categories.
- Channel sidebar, hybrid search (keyword + optional semantic embeddings over
  title, description, notes, tags, and subtitles), tag filters, and sorting.
- Optional local AI via Ollama: better search/related videos, auto-tags,
  duplicate confirmation, and homepage recommendations.
- Settings for the default playback mode and whether descriptions are shown.
- Custom player with standard, theater, and windowed-fullscreen modes,
  subtitles, plus keyboard shortcuts (`space`/`k` play, `t` theater,
  `f` fullscreen, arrows seek).

This is a single-admin app with no authentication. Keep it on a trusted LAN.

## Quick start

```bash
cp .env.example .env
# edit .env to set PUID/PGID and your host paths
docker compose up --build -d
```

Open `http://<server-ip>:8080`.

## TrueNAS / Dockge setup

1. Create a ZFS dataset for media, e.g. `/mnt/tank/media/youtube_archive`.
2. Find the UID/GID of the user that owns that dataset (TrueNAS:
   Credentials > Local Users, or `id <user>`). Put them in `.env` as `PUID`
   and `PGID` so downloaded files are owned correctly and visible over SMB.
3. In Dockge, create a new stack from this `docker-compose.yml` and set the
   volume host paths:
   - `DOWNLOADS_PATH` -> your media dataset, mounted at `/downloads`
   - `DATA_PATH` -> persistent app data (DB + thumbnails), mounted at
     `/app/data`
4. (Optional) Expose the media dataset as an SMB share so you can drag videos
   in from your desktop. Dropped files appear in the Review tab within
   `SCAN_INTERVAL_SEC` (default 60s).

### Updating a Dockge deploy

Horde is built from source on the server (`build: .` in `docker-compose.yml`),
so pulling new code and rebuilding the image is required after changes. Use the
**TrueNAS shell** (or SSH to the host)—not the per-service **Bash** button in
Dockge, which opens a shell inside the running container where `docker` is not
available.

Settings → System shows a quiet notice when a newer commit is available on
GitHub (dismissible until the next newer commit).

1. On TrueNAS open the shell and go to the Dockge stack folder (the path shown
   in Dockge for the stack), e.g. `/mnt/tank/dockge/stacks/horde`.
2. Run the update script (use `bash` so you do not need `chmod +x`):

```bash
cd /mnt/tank/dockge/stacks/horde   # adjust to your stack path
bash update.sh
```

That pulls the latest code, builds with the current commit SHA (so update
checks keep working), and recreates the containers.

**Manual / advanced** (same steps as the script):

```bash
cd /mnt/tank/dockge/stacks/horde
git pull
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose build horde
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose up -d
```

Stopping the container in Dockge before rebuilding is optional; either way,
the running container must be recreated from the new image for changes to take
effect. Your library and database are on host volumes (`DATA_PATH`,
`DOWNLOADS_PATH`) and are not affected by a rebuild.

If the UI still looks old after a deploy, hard-refresh the browser
(`Ctrl+Shift+R`) to clear cached frontend assets.

## Local development

Backend:

```bash
cd backend
pip install -r requirements.txt
DOWNLOADS_DIR=./downloads DATA_DIR=./data uvicorn app.main:app --reload --port 8080
```

Frontend (proxies `/api` to port 8080):

```bash
cd frontend
npm install
npm run dev
```

On Windows, start the backend before the frontend. The Vite proxy targets
`127.0.0.1:8080` (not `localhost`) to avoid IPv6 `::1` connection refused
errors that show up as instant 500s in the UI.

## Configuration

| Variable            | Default                            | Purpose                                  |
| ------------------- | ---------------------------------- | ---------------------------------------- |
| `PUID` / `PGID`     | `1000`                             | User the container runs file ops as       |
| `DOWNLOADS_PATH`    | `/mnt/tank/media/youtube_archive`  | Host media dataset                        |
| `DATA_PATH`         | `/opt/dockge/horde/data`           | Host persistent data (DB, thumbnails)     |
| `SCAN_INTERVAL_SEC` | `60`                               | Folder rescan interval                    |
| `YTDLP_POT_BASE_URL`| `http://bgutil-pot:4416` (Docker)  | bgutil PO-token sidecar (auto, no login)  |
| `OLLAMA_BASE_URL`   | _(auto-discover)_                  | Ollama API URL; blank tries compose + host |
| `OLLAMA_DATA_PATH`  | `./ollama`                         | Host path for Ollama model data (profile) |

## AI (optional, Ollama)

Horde does not bundle models. It talks to [Ollama](https://ollama.com) over HTTP
for embeddings (`nomic-embed-text`) and a small chat model (`llama3.2:3b`) used
for tags, browse categories, and duplicate confirmation. Without Ollama, the
app works as before (keyword search and heuristic related videos).

**Same host (compose sidecar):**

```bash
docker compose --profile ai up -d
```

Horde auto-discovers `http://ollama:11434`. Models are pulled on first connect
when Settings → AI → Auto-pull is enabled.

**GPU vendors:** Ollama does the inference; Horde only probes the host for
workload sizing and Settings stats. Same-host detection supports NVIDIA
(`nvidia-smi`), AMD (`rocm-smi` or DRM sysfs), and Intel (DRM sysfs). For the
compose sidecar, uncomment the matching NVIDIA / AMD / Intel device block in
`docker-compose.yml`. Remote Ollama still works on any GPU Ollama supports —
set **Ollama VRAM (GB)** if autodetection cannot see that machine’s VRAM.

**Ollama on another machine (e.g. NAS runs Horde, PC has the GPU):** leave the
`ai` profile off and set `OLLAMA_BASE_URL=http://<pc-ip>:11434` in `.env`, or
enter that URL under Settings → AI. Set **Ollama VRAM (GB)** there to the GPU
PC’s VRAM so workload/model autodetection matches Ollama (not the Horde host).
Use Settings → **Process library now** for backlogs after enabling AI for the
first time.

Schedule modes (Settings → AI):

- **On download** — embed + tag enrich when a download finishes
- **Only when requested** — no automatic jobs
- **On a timer** — periodic sweep for missing embeddings

## YouTube bot checks

Docker Compose runs a `bgutil-pot` sidecar that generates proof-of-origin tokens
automatically — no Google login and no cookies to rotate. Keep
`MAX_DOWNLOAD_CONCURRENCY` at 1–2 to reduce IP flagging.

If downloads still fail with "Sign in to confirm you're not a bot" and YouTube
also blocks you in a logged-out browser, your IP may be hard-blocked. Try a new
IP (router restart) or set `YTDLP_COOKIE_FILE` to a guest cookie export as a
fallback.

## Notes

- No transcoding: the original file is streamed with HTTP range support, so
  playback depends on your browser's codec support (`.mp4`/`.webm` are safest).
- Automated channel subscriptions are out of scope for this version.
- **yt-dlp must be kept current.** YouTube changes frequently; if downloads
  fail with "Requested format is not available", upgrade: `pip install -U yt-dlp`
  (or rebuild the Docker image).

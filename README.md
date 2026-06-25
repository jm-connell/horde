# Horde

A self-hosted media downloader and library for your homelab. Paste a YouTube
(or other yt-dlp supported) link to download it straight to your server with
metadata and thumbnails, then browse and watch everything through a dark,
YouTube-style web UI.

This is a single-container app (FastAPI backend serving a built React frontend)
designed to run on TrueNAS via Dockge, but it works with any Docker host.

## Features

- URL ingestion with quality presets and a live progress bar (yt-dlp). Pasted
  links are cleaned of tracking parameters before download.
- Automatic metadata, tags, subtitles (WebVTT), and thumbnail extraction; files
  are stored under `/<channel>/<year>/<title>.ext`.
- Folder scanner (watchdog + 60s polling fallback) that detects manually
  dropped `.mp4` / `.mkv` / `.webm` files and queues them for review. yt-dlp
  downloads are no longer mistakenly sent to review.
- Edit any video's metadata, notes, and thumbnail (not just review items), and
  rename a channel across every video at once.
- Playlists: build your own or import a public YouTube playlist; both are
  browsed and played the same way.
- Playback queue with auto-advance, a floating mini-player that keeps playing
  while you browse, and a Picture-in-Picture button.
- Library grid with channel sidebar, global keyword search (title, channel,
  description, notes, tags), tag filters, and sorting.
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

## Notes

- No transcoding: the original file is streamed with HTTP range support, so
  playback depends on your browser's codec support (`.mp4`/`.webm` are safest).
- Automated channel subscriptions are out of scope for this version.
- **yt-dlp must be kept current.** YouTube changes frequently; if downloads
  fail with "Requested format is not available", upgrade: `pip install -U yt-dlp`
  (or rebuild the Docker image).

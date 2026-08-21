# Horde

This entire project was vibecoded in a relatively short amount of time. I've used Plex for a long time, but I really don't like how it handles "Other" videos that aren't Movies and TV. There are lots of YouTube and other videos that I want to archive and "horde" (hoard) but still be able to find and watch them in an organized way. I looked a bit at TubeArchivist and it looks decent, but I wanted to make something exactly the way I envisioned it, and since I had a lot of credit left for the month on my Cursor subscription I figured I'd let it rip. Horde gives a clean frontend to browse and search your videos on your server, and it also has a GUI for yt-dlp to download videos directly from any supported website (though I haven't tested much outside of YouTube).

I don't take credit for creating this, it was all Opus 4.8, Composer 2.5, and recently, Grok 4.5. I built it specifically for my use case, TrueNAS with Dockge. There may or may not be updates in the future, depending on how much I end up using this day to day. Try it out, and if you want to change anything then I welcome you to download the repo, boot it up with your AI-enabled IDE of choice, and get vibecoding. If you have any questions the best way to handle it is to open this repo in Cursor and use the Ask mode (that's what I do). Hope you enjoy.

--

A self-hosted media downloader and library for your homelab. Paste a YouTube
(or other yt-dlp supported) link to download it straight to your server with
metadata and thumbnails, then browse and watch everything through a dark,
YouTube-style web UI.

This is a single-container app (FastAPI backend serving a built React frontend)
designed to run on TrueNAS via Dockge, but it works with any Docker host.

**Full documentation** ships with the app: after install, open
**Settings → System → Documentation**, or go to `/wiki/` on your Horde host.
Interactive API docs are at `/docs`.

This is a single-admin app with no authentication. Keep it on a trusted LAN.

## Quick start

```bash
cp .env.example .env
# edit .env to set PUID/PGID and your host paths
docker compose up --build -d
```

Open `http://<server-ip>:8686` (Compose maps host **8686** → container 8080).

## Update

On the **host** shell (TrueNAS / SSH — not Dockge Bash):

```bash
cd /path/to/your/horde/stack
bash update.sh
```

Then hard-refresh the browser (`Ctrl+Shift+R`). Library data and settings on host volumes are preserved (`.env` volume paths survive `git pull`).

## Local development

```bash
./start.sh          # Linux: backend :8080 + Vite ~5173
# or on Windows: dev.bat
```

Automated tests (pytest, Vitest, wiki build, Docker image) run on every GitHub push. See the [testing](docs/getting-started/testing.md) wiki page, or `docs/getting-started/testing.md` in the repo.

## Documentation

| Topic | Where |
|-------|--------|
| Install, TrueNAS, first run, updates | `/wiki/` → Getting started |
| Library, player, downloads, AI | `/wiki/` → Using Horde |
| Every setting | `/wiki/` → Settings |
| Env vars, storage, troubleshooting | `/wiki/` → Configuration & ops |
| Architecture & design rationale | `/wiki/` → Architecture / Design decisions |
| API (Swagger) | `/docs` |

Source Markdown lives in [`docs/`](docs/) and is built into the image with MkDocs Material.

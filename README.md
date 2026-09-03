# Horde

This entire project was vibecoded ~~in a relatively short amount of time~~. I've used Plex for a long time, but I really don't like how it handles "Other" videos that aren't Movies and TV. There are lots of YouTube and other videos that I want to archive and "horde" (hoard) but still be able to find and watch them in an organized way. I looked a bit at TubeArchivist and it looks decent, but I wanted to make something exactly the way I envisioned it, and since I had a lot of credit left for the month on my Cursor subscription I figured I'd let it rip. Horde gives a clean frontend to browse and search your videos on your server, and it also has a GUI for yt-dlp to download videos directly from any supported website (though I haven't tested much outside of YouTube). You can also drop in any video file from your computer, upload it directly to Horde's storage directory, and adjust metadata in the Horde UI.

I also made some AI features like auto tagging, video summary and chat, and enhanced search. This can be used with Ollama or an OpenRouter API key. If you want to use Ollama you'll need some kind of GPU on your host machine. I have a 1660 Super but use OpenRouter anyway because it's lower maintenance, faster, and it costs virtually nothing for this app.

There is also the ability to stream videos directly from YouTube, though it is somewhat fragile and quality can vary from video to video. It's mostly functional, but streaming is not the primary focus of Horde. The idea is more that you can stream the video to preview, then choose to download or not. 

I don't take credit for creating this, it was all Opus 4.8, Composer 2.5, and recently, Grok 4.5 and 4.6. I built it specifically for my use case, TrueNAS with Dockge. There may or may not be updates in the future, depending on how much I end up using this day to day. Try it out, and if you want to change anything then I welcome you to download the repo, boot it up with your AI-enabled IDE of choice, and get vibecoding. If you have any questions the best way to handle it is to open this repo in Cursor and use the Ask mode (that's what I do). Hope you enjoy.

--

FastAPI serves a built React UI (and an in-app MkDocs wiki) from one container.
Compose always starts a [bgutil POT](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
sidecar for YouTube; Ollama is an optional profile. Built for TrueNAS / Dockge,
works on any Docker host.

**No authentication.** Single-admin, trusted LAN only. Do not port-forward it.

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
  no transcoding — the browser plays the original file).
- **Playlists** — your own lists or imported YouTube playlists.
- **AI** (optional) — Ollama and/or OpenRouter for embeddings, tags, summaries,
  chat, recommendations, and duplicate help.

## Quick start

```bash
cp .env.example .env
# set PUID, PGID, DOWNLOADS_PATH, and DATA_PATH
docker compose up --build -d
```

Open `http://<server-ip>:8686` (host **8686** → container **8080**).

Optional local Ollama:

```bash
docker compose --profile ai up -d
```

Or skip the profile and set `OLLAMA_BASE_URL` / `OPENROUTER_API_KEY` in `.env`
(and enable the provider under Settings → AI).

## TrueNAS / Dockge

1. Create a media dataset, e.g. `/mnt/tank/media/youtube_archive`.
2. Put that path in `.env` as `DOWNLOADS_PATH`. Put persistent app data
   (SQLite, thumbnails) in `DATA_PATH`. Keep both in `.env`, not hardcoded
   only in `docker-compose.yml`.
3. Set `PUID` / `PGID` to the user that owns the dataset (`id <user>`, or
   TrueNAS → Credentials → Local Users) so downloads are not owned by root
   and stay writable over SMB.
4. Clone this repo into a Dockge stack folder and deploy the included
   `docker-compose.yml`.

Dropped files on the share show up in **Import** within `SCAN_INTERVAL_SEC`
(default 60s).

## Update

On the **host** shell (TrueNAS / SSH — not Dockge’s per-service Bash):

```bash
cd /path/to/your/horde/stack
bash update.sh
```

That snapshots live volume mounts into `.env`, `git pull`s, rebuilds with the
commit SHA, recreates containers, and waits on `/api/health`. Then hard-refresh
the browser (`Ctrl+Shift+R`). Media and settings on host volumes are preserved.

Do not click **Deploy** in Dockge afterward with a stale compose editor — the
script already recreated the stack. Refresh Dockge so it reloads the file.

yt-dlp is **pinned** in `backend/requirements.txt` and installed at image
build time. Pull + rebuild is how you pick up a newer pin.

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
| `YTDLP_POT_BASE_URL` | Compose: `http://bgutil-pot:4416` |
| `YTDLP_COOKIE_FILE` | Optional Netscape cookies (age gates / hard blocks) |
| `OLLAMA_BASE_URL` | Empty = auto-discover compose service, then host |
| `OPENROUTER_API_KEY` | Optional; overrides the key in Settings → AI |
| `HORDE_GITHUB_REPO` | Repo for in-app update checks |

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
| Install, TrueNAS, first run, updates | `/wiki/` → Getting started |
| Library, player, downloads, AI | `/wiki/` → Using Horde |
| Every setting | `/wiki/` → Settings |
| Env vars, storage, troubleshooting | `/wiki/` → Configuration & ops |
| Architecture & design rationale | `/wiki/` → Architecture / Design decisions |
| API (Swagger) | `/docs` |

Source Markdown lives in [`docs/`](docs/) and is built into the image with
MkDocs Material.

## Notes

- No transcoding. Playback depends on the browser (`.mp4` / `.webm` are safest).
- Channel catalogs (index remote uploads for feed search and stream preview)
  are YouTube-only. Non-YouTube yt-dlp URLs still download.
- Health: `GET /api/health` (version, yt-dlp, POT, wiki, library count).

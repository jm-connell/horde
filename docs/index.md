# Horde

Horde is a self-hosted media downloader and library for your homelab. Paste a YouTube (or other [yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported) link, download it to your server with metadata and thumbnails, then browse and watch everything through a dark, YouTube-style web UI.

It exists because Plex is great for Movies and TV, and awkward for everything else — long-form YouTube, talks, music videos, random archives you want to keep forever. Horde is built for that archive: organized by channel and year on disk, searchable in the browser, with an optional local or cloud AI layer for tags, search, summaries, and recommendations.

!!! warning "LAN only — no authentication"
    Horde is a single-admin app with **no login**. Keep it on a trusted LAN. Do not expose it to the public internet.

## Feature tour

| Area | What you get |
|------|----------------|
| **Downloads** | URL ingestion, quality presets, live progress, playlist import, pause/resume queue |
| **Library** | Channel sidebar, tags, hybrid search, sorting, bulk select, continue watching |
| **Import** | Watchdog + poll scanner for dropped files; review before they enter the library |
| **Player** | Standard / theater / windowed modes, mini player, PiP, cast, SponsorBlock, chapters, subtitles |
| **Playlists** | Your own lists or imported YouTube playlists |
| **AI** (optional) | Ollama and/or OpenRouter for embeddings, tags, summaries, chat, recommendations, duplicates |

## Where to start

1. [Install with Docker](getting-started/install-docker.md) — or [TrueNAS / Dockge](getting-started/truenas-dockge.md)
2. [First run](getting-started/first-run.md) — download something and browse it
3. [Settings](settings/index.md) — appearance, library, playback, AI
4. [AI setup](ops/ai-setup.md) — when you want recommendations and smarter search

## Map of this wiki

- **Getting started** — install, update, local development, [automated testing](getting-started/testing.md)
- **Using Horde** — day-to-day guides for every major screen
- **Settings** — every control and what it does
- **Configuration & ops** — env vars, storage, YouTube bot checks, backups, troubleshooting
- **Architecture** — how the backend, frontend, workers, and AI pipeline fit together
- **Design decisions** — why things work the way they do
- **Reference** — shortcuts, glossary, FAQ, roadmap

In a running Horde instance, open **Settings → System → Documentation** to reach this wiki at `/wiki/`. Interactive API docs live at `/docs` (Swagger).

## License

Horde is source-available under the **PolyForm Noncommercial License 1.0.0**. Personal and other noncommercial use is allowed; selling Horde or using it commercially is not. The legal text is `LICENSE` at the repository root. See the [FAQ](reference/faq.md#what-license-is-horde-under).

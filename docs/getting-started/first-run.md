# First run

You have Horde running (Docker or local dev). This page walks through the first useful loop: open the UI, download something, confirm it on disk and in the library, and know where settings live.

!!! warning "LAN only — no authentication"
    There is **no login screen**. Anyone who can reach the URL can manage downloads and the library. Stay on a trusted LAN.

## Open the UI

| Deploy | URL |
|--------|-----|
| Docker Compose / TrueNAS | `http://<server-ip>:8686` |
| Local backend only | `http://127.0.0.1:8080` |
| Local Vite + API proxy | `http://localhost:5173` (usual) |

!!! note "Docker host port"
    Production Compose publishes **8686 → 8080**. Do not expect the UI on host port `8080` unless you changed the mapping.

You should see the Home / Library UI. Settings are available from the app chrome (gear / Settings).

## Download your first video

1. Open **Downloads** (or the download entry point in the UI).
2. Paste a YouTube URL (or another [yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported link).
3. Pick a quality preset if offered, then start the job.
4. Watch progress update live while yt-dlp runs.

Docker stacks always include the **`bgutil-pot`** sidecar so proof-of-origin tokens are generated without a Google login. Keep download concurrency modest (default max is low) to reduce bot flagging. If jobs fail with sign-in / bot errors, see [YouTube access](../ops/youtube-access.md).

Full download behavior: [Downloads](../guides/downloads.md).

## Confirm files on disk

Successful downloads land under your media root (`DOWNLOADS_PATH` → `/downloads` in Docker) using:

```text
Channel/Year/Title [id].ext
```

Example:

```text
Some Channel/2024/Example Talk [abcdefghijk].mp4
```

Sidecar metadata and thumbnails are stored with the app under `DATA_PATH` (`/app/data`). Layout details: [Storage layout](../ops/storage-layout.md).

## Browse the library

After the job finishes, the video should appear in the [Library](../guides/library.md): channel sidebar, search, tags, and sorting. Click through to play in the built-in player (no live transcoding — the browser streams the archived AV1+AAC MP4 with HTTP range requests).

## Optional: drop files for import

If you mount the media dataset as an SMB share (or copy files into `DOWNLOADS_PATH` another way), Horde’s scanner watches for:

- `.mp4`
- `.mkv`
- `.webm`

New files are queued for review before they join the library. The fallback poller runs every **`SCAN_INTERVAL_SEC`** seconds (default **60**), which helps when inotify events are missed on network/ZFS mounts.

Workflow: [Import & review](../guides/import-review.md).

## Glance at Settings

Open [Settings](../settings/index.md) early and skim:

| Area | Why |
|------|-----|
| Appearance | Theme / UI preferences |
| Library | Sort defaults, channel list, sync options |
| Playback | Default player mode, descriptions |
| AI | Ollama / OpenRouter when you want smarter search and tags |
| System | Storage stats, update notice, documentation link |

You do not need AI for a working archive. Enable it later via [AI setup](../ops/ai-setup.md) (`docker compose --profile ai up -d` for on-host Ollama).

## Sanity checklist

- [ ] UI loads on the correct port (`8686` for Docker)
- [ ] A test URL downloads without errors
- [ ] File exists under `Channel/Year/…`
- [ ] Video appears in the library and plays
- [ ] (Optional) A dropped `.mp4` / `.mkv` / `.webm` shows in Review within ~60s

## If something fails

!!! tip "Stale UI after a rebuild"
    Hard-refresh the browser (`Ctrl+Shift+R`) so cached frontend assets reload.

!!! tip "Empty library but files on disk"
    Confirm `DOWNLOADS_PATH` / `DATA_PATH` mounts, then check Import & review for unscanned drops. Scanner only indexes `.mp4`, `.mkv`, and `.webm`.

More: [Troubleshooting](../ops/troubleshooting.md).

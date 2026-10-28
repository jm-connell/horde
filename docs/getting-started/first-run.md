# First run

You have Horde running (Docker or local dev). This page walks through the first useful loop: the setup wizard, a test download, confirm it on disk and in the library, and know where settings live.

!!! info "Create the admin account first"
    The first screen asks you to create the administrator account (a username and a password). Nothing else works until you do. Add other people later in *Account settings* (the account menu at the top right). Forgot the password later? Use **Forgot password?** on the sign-in page. See [Accounts and sign-in](../ops/authentication.md). Stay on a trusted LAN.

## Open the UI

| Deploy | URL |
|--------|-----|
| Docker Compose / TrueNAS | `http://<server-ip>:8686` |
| Local backend only | `http://127.0.0.1:8080` |
| Local Vite + API proxy | `http://localhost:5173` (usual) |

!!! note "Docker host port"
    Production Compose publishes **8686 → 8080**. Do not expect the UI on host port `8080` unless you changed the mapping.

Right after you create the admin account, a short **setup wizard** runs (on a new install, and again after **Settings → System → Reset Horde**). Every step can be changed later in [Settings](../settings/index.md), so do not worry about getting it perfect:

1. **Welcome**: how many videos the library has and how much disk space is free. **Use defaults** here skips the rest of the wizard.
2. **Downloads**: whether to even out the volume of new downloads (loudness normalization).
3. **Playback compatibility**: which devices can play your library. The default, **AV1 only**, needs no GPU and plays in current Chrome, Firefox and Edge; some Apple devices and older TVs cannot play AV1 and need one of the H.264 options. The step shows your GPU/encoder and whether *this* device can play AV1. Unsure? Keep the default ([details](../guides/downloads.md#compatibility-codecs)).
4. **Look**: a color palette.
5. **AI (optional)**: **Skip for now**, **Connect a provider** (paste an API key from a cloud provider such as OpenRouter, OpenAI, Gemini or Groq, or the address of an AI server you run), or **Run Ollama for me** (the bundled Ollama container, started with one command on the server). See [AI setup](../ops/ai-setup.md).
6. **You’re set**: opens **Downloads** when the library is empty, or the library when it already has videos.

Installs that were already set up before the wizard existed are not sent through it.

## Download your first video

1. Open **Download** in the top bar.
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

After the job finishes, the video should appear in the [Library](../guides/library.md): channel sidebar, search, tags, and sorting. Click through to play in the built-in player (no live per-client transcode — the browser streams the archived MP4 with HTTP range requests). New downloads default to AV1; if a device cannot decode it, the player offers an H.264 copy. Settings → Library **Playback compatibility** changes that policy (see [Playback compatibility](../guides/downloads.md#compatibility-codecs)).

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
| AI | Any OpenAI-compatible provider when you want smarter search and tags |
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

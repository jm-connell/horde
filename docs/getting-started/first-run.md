# First run

You have Horde running (Docker or local dev). This page walks through the first useful loop: the setup wizard, a test download, confirm it on disk and in the library, and know where settings live.

!!! info "Create the admin account first"
    The first screen asks you to create the administrator account (a username and a password). Nothing else works until you do. Add other people later in *Account settings* (the account menu at the top right). Forgot the password later? Use **Forgot password?** on the sign-in page. See [Accounts and sign-in](../ops/authentication.md). Stay on a trusted LAN.

## Open the UI

| Deploy | URL |
|--------|-----|
| Docker Compose / TrueNAS | `http://<server-ip>:8686` |
| Local backend only | `http://127.0.0.1:8080` (after `npm run build:sync` in `frontend/`; otherwise `/` is a 404 and only the API answers) |
| Local Vite + API proxy | `http://localhost:5173` (usual) |

!!! note "Docker host port"
    Production Compose publishes **8686 → 8080**. Do not expect the UI on host port `8080` unless you changed the mapping.

Right after you create the admin account (step 1 of 8 in the wizard's counter), a short **setup wizard** runs the remaining steps (on a new install, and again after **Settings → System → Reset Horde**). Every step can be changed later in [Settings](../settings/index.md), so do not worry about getting it perfect:

1. **Welcome**: how many videos the library has and how much disk space is free. **Use defaults** here skips the rest of the wizard.
2. **Downloads**: whether to even out the volume of new downloads (loudness normalization).
3. **Playback compatibility**: which devices can play your library. Tick what people will watch on (computers and Android phones; iPhones, iPads or Macs; smart TVs, Chromecast or consoles) and Horde picks the mode: **AV1 only** when computers are all, **AV1 + H.264 copy** as soon as an Apple device or a TV is in the house, because older ones cannot play AV1. You can still pick any mode yourself. Without ticking anything the default stays **AV1 only**, which needs no GPU and plays in current Chrome, Firefox and Edge. The step also shows your GPU/encoder and whether *this* device can play AV1 ([details](../guides/downloads.md#compatibility-codecs)).
4. **Look**: a color palette.
5. **AI (optional)**: **Skip for now** (then **Skip**), **Connect a provider** (paste an API key from a cloud provider such as OpenRouter, OpenAI, Gemini or Groq, or the address of an AI server you run), or **Run Ollama for me** (the bundled Ollama container, started with one command on the server). See [AI setup](../ops/ai-setup.md).
6. **YouTube history (optional)**: import your YouTube watch history, subscriptions and playlists from a Google Takeout export, for your account ([how](../guides/youtube-history.md)). Others can import their own later in Settings → Library.
7. **You’re set**: opens **Downloads** when the library is empty, or the library when it already has videos.

Installs that were already set up before the wizard existed are not sent through it. Reloading the page keeps you on the step you were on.

Until the library has its first video, **Home** shows **Get started**: download a video, subscribe to a channel, bring in videos you already have, import your YouTube history, add your household, put Horde on your phone and (optionally) turn on AI, each with a link to the page that does it.

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
- `.m4v`
- `.mov`

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
- [ ] (Optional) A dropped `.mp4` / `.mkv` / `.webm` / `.m4v` / `.mov` shows in Review within ~60s

## If something fails

!!! tip "Stale UI after a rebuild"
    Hard-refresh the browser (`Ctrl+Shift+R`) so cached frontend assets reload.

!!! tip "Empty library but files on disk"
    Confirm `DOWNLOADS_PATH` / `DATA_PATH` mounts, then check Import & review for unscanned drops. Scanner only indexes `.mp4`, `.mkv`, `.webm`, `.m4v` and `.mov`.

More: [Troubleshooting](../ops/troubleshooting.md).

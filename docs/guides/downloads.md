# Downloads

The **Download** page (`/download`) is where you paste a URL, pick a quality preset, watch the queue, and import YouTube playlists into Horde.

## Quality presets

| Preset | Meaning |
|--------|---------|
| **best** | Best combined video+audio yt-dlp can get |
| **2160p** | Cap height ≤ 2160 (4K) |
| **1440p** | Cap ≤ 1440 |
| **1080p** | Cap ≤ 1080 |
| **720p** | Cap ≤ 720 |
| **480p** | Cap ≤ 480 |
| **audio** | Best audio-only stream |
| **audio-160** / **128** / **64** | Audio-only capped at that bitrate (kbps) |

After metadata loads, the UI may limit the preset list to formats actually available for that URL and show approximate sizes when known. Audio bitrate caps that are at or above the source’s best stream are omitted (use **Audio (best)** instead).

Height-capped presets prefer an exact match (e.g. 1080p) when YouTube offers it, then the best stream under that height — they never fall back to unbounded `best`. If the finished file is still below the requested tier, the Download/Watch toast shows a **quality warning**.

## Change resolution (library)

On a library watch page, **••• → Change resolution** re-queues the source URL and **replaces the file in place** at the chosen preset (optional loudnorm via **Normalize volume**). Custom title/description/notes and locked tags are kept. The modal shows the current file height and notes that the source may not offer the selected tier.

## Queue behavior

Downloads run in a **FIFO** worker queue.

| Knob | Default | Notes |
|------|---------|--------|
| `MAX_DOWNLOAD_CONCURRENCY` | **2** | Env var — how many downloads run at once |

Set concurrency in the container environment ([Environment variables](../ops/environment.md)). Lower values (1–2) reduce YouTube IP flagging risk; see [YouTube access](../ops/youtube-access.md).

### Pause / resume

On the Download page:

- **Pause** — stops active work and prevents new jobs from starting until you resume
- **Resume** — continues the FIFO queue

Pause-all stops every download; nothing new starts until you resume. The pause flag is stored as `download_queue_paused` in app settings, so it **survives a container restart**.

## Single video

1. Paste a video URL (YouTube or other [yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported site).
2. Wait for preview metadata.
3. Choose a preset (and optional volume normalize).
4. Choose a **destination**:
   - **Save to library** (default) — archives on the server under Channel/Year and appears in Library.
   - **Download to this device** — Horde still fetches/merges on the server into a temporary folder, then your browser saves the file. It is **not** kept in the library; dismissing the job card deletes the temp file.
5. Submit — the job appears in the queue with live progress.

Completed library downloads land in the [Library](library.md), organized by channel/year on disk ([storage layout](../ops/storage-layout.md)). Device jobs show a **Save again** action on the card if the browser download was missed.

Playlist import is library-only (device destination is hidden for playlist URLs).

## Playlist import

Paste a **playlist** URL on the Download page:

1. Horde loads playlist entries.
2. Select which items to import (all or a subset).
3. Optionally set a **playlist name**.
4. Choose a quality preset and import.

Horde creates a playlist and queues downloads for the selected entries. Manage the list later under [Playlists](playlists.md).

!!! tip "Create empty playlists elsewhere"
    Local empty playlists are created on `/playlists`. YouTube playlist *import* always goes through Download.

## Loudnorm (optional)

You can enable **volume normalization** (ffmpeg `loudnorm`) on download. When on, Horde runs a post-download loudness pass (I=−16, TP=−1.5, LRA=11) if `ffmpeg` is available. If ffmpeg is missing or the pass fails, the download still succeeds with a warning.

Toggle via the download options / `normalizeVolumeOnDownload` preference when submitting.

## Progress and failures

The queue panel shows status, percentage, and errors. Failures carry a typed **`error_kind`** (bot check, PO token, cookies, members-only, rate limit, unavailable, post-process, etc.) with a short fix hint on the card; the Download URL field also shows a banner when link preview fails for the same reasons.

Failed jobs can be retried from the card. Retry **requeues the same job** (it does not create a second queue entry), so extra clicks while it is already queued or downloading are ignored. Active download paths are marked so the [import scanner](import-review.md) does not race the same files.

See [Troubleshooting — error kinds](../ops/troubleshooting.md#download-error_kind-values) and [YouTube access](../ops/youtube-access.md).

## Related

- [Channels](channels.md) — channel-scoped download panel
- [Watching](watching.md) — stream preview → download handoff
- [Playlists](playlists.md) — after YouTube import
- [Download pipeline](../architecture/downloads-pipeline.md)
- [Environment variables](../ops/environment.md) — `MAX_DOWNLOAD_CONCURRENCY`

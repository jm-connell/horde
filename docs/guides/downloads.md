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
| **audio** | Audio-only extract |

After metadata loads, the UI may limit the preset list to formats actually available for that URL and show approximate sizes when known.

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

Pause-all stops every download; nothing new starts until you resume.

## Single video

1. Paste a video URL (YouTube or other [yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported site).
2. Wait for preview metadata.
3. Choose a preset (and optional volume normalize).
4. Submit — the job appears in the queue with live progress.

Completed downloads land in the [Library](library.md), organized by channel/year on disk ([storage layout](../ops/storage-layout.md)).

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

The queue panel shows status, percentage, and errors. Failed jobs can be retried from the UI when available. Active download paths are marked so the [import scanner](import-review.md) does not race the same files.

## Related

- [Channels](channels.md) — channel-scoped download panel
- [Watching](watching.md) — stream preview → download handoff
- [Playlists](playlists.md) — after YouTube import
- [Download pipeline](../architecture/downloads-pipeline.md)
- [Environment variables](../ops/environment.md) — `MAX_DOWNLOAD_CONCURRENCY`

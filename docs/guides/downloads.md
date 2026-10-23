# Downloads

The **Download** page (`/download`) is where you paste a URL, pick a quality preset, watch the queue, and handle YouTube playlists (import, subscribe, or download as individual videos).

Horde does not download **YouTube Shorts** (Shorts URLs, `#shorts` titles, or sub-minute uploads from the Shorts era). They are also omitted from channel feeds, catalog search, and playlist import. Videos already in the library are left as they are. Stream preview of a pasted Shorts URL can still play without saving a file.

## Quality presets

| Preset | Meaning |
|--------|---------|
| **best** | Highest resolution **AV1** (then other codecs) + AAC when YouTube offers it |
| **2160p** | Cap height ≤ 2160 (4K) |
| **1440p** | Cap ≤ 1440 |
| **1080p** | Cap ≤ 1080 |
| **720p** | Cap ≤ 720 |
| **480p** | Cap ≤ 480 |
| **audio** | Best audio-only stream |
| **audio-160** / **128** / **64** | Audio-only capped at that bitrate (kbps) |

After metadata loads, the UI may limit the preset list to formats actually available for that URL and show approximate sizes when known. Audio bitrate caps that are at or above the source’s best stream are omitted (use **Audio (best)** instead). Downloads pick the **original-language** audio track when YouTube also offers autodubs (same scoring as stream preview). Existing library files are not rewritten.

When you queue with **Best available** (the channel download panel default), Horde still fetches the highest source tier, but the download queue stores and shows that **actual resolution** (for example **4K**) instead of the “best” label. Finished cards use the probed file height, never **Best available**.

Height-capped presets prefer an exact match (e.g. 1080p) when YouTube offers it, then the best stream under that height — they never fall back to unbounded `best`. Within a height, the default **AV1** [playback mode](#compatibility-codecs) prefers **AV1 + AAC** over a higher-bitrate VP9/H.264 stream, then remuxes to MP4 with `faststart` (video is **copied**). If the finished file is still below the requested tier, the Download/Watch toast shows a **quality warning**.

## Playback compatibility { #compatibility-codecs }

Horde stores **one original file per video** and plays it as a normal MP4 (HTTP range requests). There is **no live per-client transcode** like Plex: the browser or phone decodes the stored file itself. What Horde can do is keep a **second, H.264 file beside the original** and hand each device whichever one it can play. Pick the policy in Settings → Library → **Playback compatibility** (also a step in the [setup wizard](../getting-started/first-run.md)). It is stored as `downloadVideoCodec` and stamped onto every new download job (`video_codec`).

### Why AV1 is a problem

YouTube publishes its **highest resolutions as AV1** (and sometimes VP9). That is great for bandwidth: AV1 is smaller than H.264 at the same quality. The catch is **decode support**:

- Current Chrome, Edge, and Firefox, most Android phones, iPhone 15 Pro and newer, and M3+ Macs/iPads decode AV1
- M1/M2 iPads and Macs in Safari, older iPhones, many smart TVs, and older PCs **cannot**
- YouTube offers **H.264 only up to 1080p**. There is no 1440p/4K H.264 (or H.265) stream to download. To get H.264 at 4K, Horde has to download the AV1 file and re-encode it

### The four modes

| Mode | Value | What is stored | Storage | Server work | Devices |
|------|-------|----------------|---------|-------------|---------|
| **AV1 only** (default) | `av1` | YouTube's AV1/VP9, copied (remux only) | Smallest | None | Recent devices only |
| **H.264 only, up to 1080p** | `h264_native` | YouTube's own H.264; every video preset is capped at 1080p (1440p/4K are saved at 1080p) | About 1.5-2x AV1 | None (stream copied) | Nearly everything |
| **H.264 only, full resolution** | `h264_convert` | Native H.264 at 1080p and below; 1440p/4K download AV1, then are **re-encoded to H.264 at source resolution**, replacing the original | About 2-3x AV1 at 4K | Heavy; GPU strongly advised | Nearly everything (but old devices often struggle with 4K H.264) |
| **AV1 + H.264 copy** | `sidecar` | The AV1 original **plus** a ≤1080p H.264 copy next to it | AV1 plus roughly 50-150% | Low for new YouTube downloads; encode for old videos and imports | Everything: each device plays the best file it can |

Legacy values migrate automatically: `h264` and `h265` become `h264_convert`. **H.265 mode was removed.** YouTube never ships HEVC for these videos, so it only ever added an encode.

Audio-only presets are unaffected by all four modes.

!!! warning "H.264 full resolution replaces originals"
    In `h264_convert`, 1440p/4K originals are overwritten by a lossy re-encode (a generation below YouTube's AV1). Changing the mode does not touch existing videos. The **Convert library to H.264** button (visible only in this mode) re-encodes every AV1/VP9 original in place after a confirm step. The only way back is to download the videos again.

### How the sidecar works

In `sidecar` mode (and whenever you create a copy by hand), the H.264 copy is saved as `<original stem>.horde-h264.mp4` in the same folder. It is 8-bit H.264 High + AAC with `faststart`, with the short side capped at 1080 (a vertical 1080x1920 video keeps its full 1080 width).

**Copy resolution** (Settings → Library, and the wizard) controls how big copies get:

| Copy resolution | 1080p and lower sources | 1440p / 4K sources | Cost |
|---|---|---|---|
| **Up to 1080p** (default) | YouTube's own H.264, same size | Scaled to 1080p (YouTube's 1080p H.264 for new downloads) | Light: mostly downloads, small encodes |
| **Full resolution** | YouTube's own H.264, same size | Encoded here at full size, up to 4K (8K sources get a 4K copy, the H.264 limit) | Heavy: every 1440p/4K copy is a full encode, files roughly 2× the AV1 size. A GPU is strongly advised |

The same setting applies to one-off copies in the other modes. Devices that can't decode AV1 are often too old for smooth 4K H.264 as well, so "Up to 1080p" is the safer default.

- **YouTube videos:** Horde first downloads **YouTube's own avc1 stream** after the main file finishes. That is an extra download, not a conversion, so there is no quality loss and almost no server work. If YouTube has no H.264 for the video, it falls back to encoding locally.
- **Everything else** (imports, non-YouTube sites, existing library videos): encoded locally from the original with ffmpeg.
- Sidecars are counted in [storage stats](../ops/storage-layout.md#h264-sidecars), deleted with the video, and moved with it when you rename a manual import. Re-downloading or changing the resolution of a video removes its old copy.
- A video that is already 8-bit H.264 within the copy resolution never gets a copy. Audio-only files never do either.

Settings → Library shows the library size, how many copies exist, and a **Create N copies** button that backfills existing videos (with an estimated size and a cancel button). Copies of existing videos use YouTube's H.264 when available, otherwise a local encode.

### How the player picks a file

Every video row stores the **real probed codec** (video and audio codec, RFC 6381 codec string, bit depth, HDR flag). Existing libraries are probed in the background shortly after startup.

When you open a video, the player asks the browser (`MediaCapabilities.decodingInfo`) about that exact codec string, resolution, and frame rate:

| Browser says | Copy exists | Result |
|--------------|-------------|--------|
| Smooth | any | Plays the **original** |
| Unsupported, or supported but not smooth | yes | Plays the **H.264 copy** |
| Supported but not smooth | no | Plays the original (it may stutter) |
| Unsupported | no | An overlay covers the player (see below) |

The overlay depends on the mode. With **AV1 + H.264 copy**, Horde starts creating the copy automatically and shows progress, then switches to it when it is ready. In the other modes it offers **Create compatible copy** (a one-off for this video, which jumps the queue) and **Try playing the original anyway**. The copy stays saved for next time.

[Offline saves](offline.md) store whichever file the device can play.

### How the server GPU affects encoding

Encoding runs **inside the Horde container**, never on the Ollama machine. It happens when a download finishes, when you request a copy, or during a bulk action; never as a live stream. It applies to `h264_convert`, to copies of non-YouTube videos, and to copies when YouTube has no H.264 stream.

| Host GPU situation | What encode jobs do |
|--------------------|---------------------|
| **NVIDIA** (NVENC), device passed into the `horde` container, jellyfin-ffmpeg in the image | Minutes per 4K file |
| **Intel** QSV / **AMD** VAAPI or AMF, `/dev/dri` on `horde` | Similar: hardware encode, much faster than CPU |
| **GPU visible in System → Resources but Settings warns** | A card is visible but **this** ffmpeg cannot use it. Pass the GPU into **`horde`**, not only Ollama, and use jellyfin-ffmpeg (Debian ffmpeg has no NVENC) |
| **None detected**, or GPU only on another PC for Ollama | **Software** `libx264`: 4K can take hours per video. 1080p copies are far cheaper |
| **AV1 only / H.264 up to 1080p** | GPU does not matter; nothing is encoded |

Encoder pick order: NVENC → QSV → VAAPI → AMF → VideoToolbox → libx264. Settings → Library shows the detected GPU, the encoder Horde will use, and an amber warning when a GPU-heavy mode is selected with no GPU encoder (`h264_convert` warns that every 1440p/4K download will be converted on the CPU; `sidecar` warns that copies for existing videos and imports will be). It also shows whether **this device** can play AV1, and flags AV1-only mode if it cannot.

!!! note "GTX 16-series and RTX 20-series"
    Turing cards (GTX 1650/1660 and RTX 20xx) can **encode** H.264 on the GPU but have **no AV1 decoder**. Horde decodes AV1 on the CPU (dav1d) and only encodes on the GPU, which is still several times faster than real time at 1080p. For H.264, HEVC, and VP9 sources it uses NVDEC. RTX 30-series and newer decode AV1 on the GPU too.

Other encoding details:

- 8-bit `yuv420p`, H.264 High, short side scaled to ≤1080, AAC 160k stereo (audio is copied when it is already AAC).
- **HDR** sources are tone-mapped to SDR (`zscale` + `tonemap=hable`) when Horde's ffmpeg has those filters.
- If an encode fails, Horde retries without NVDEC, then without tone-mapping, before giving up. A washed-out copy beats no copy.
- Copy jobs share the ffmpeg pool: `MAX_FFMPEG_CONCURRENCY`, or **2** with a GPU encoder and **1** without.

Setup: [GPU](../ops/environment.md#gpu) (passthrough and when you need one). Encode details: [Playback compatibility encoding](../ops/environment.md#horde-encode-gpu).

Safari (including other browsers on iOS) also needs **AAC** in MP4 and `faststart`. That remux always runs for every original; it is separate from the modes above. Desktop Chrome's device emulation is not a substitute for a real phone.

## Change resolution (in-progress)

On an **active** queue card (or the stream-watch download indicator), pick a different resolution from the quality menu. Horde **discards partial files** and restarts that job at the new preset — no extra confirmation. Queued jobs just switch preset and keep their place.

## Change resolution (library)

On a library watch page, **••• → Change resolution** re-queues the source URL and **replaces the file in place** at the chosen preset (optional loudnorm via **Normalize volume**). Custom title/description/notes and locked tags are kept. The modal shows the current file height and notes that the source may not offer the selected tier.

## Queue behavior

Downloads run in a **FIFO** worker queue.

| Knob | Default | Notes |
|------|---------|--------|
| `MAX_DOWNLOAD_CONCURRENCY` | **2** | Env var — how many yt-dlp downloads run at once |
| `MAX_FFMPEG_CONCURRENCY` | **1** (or **2** with GPU) | Env var — remux / encode / loudnorm / H.264 copy overlap |

Set concurrency in the container environment ([Environment variables](../ops/environment.md)). Lower values (1–2) reduce YouTube IP flagging risk; see [YouTube access](../ops/youtube-access.md). After yt-dlp finishes, the next queued download can start while the last file is still remuxing or transcoding.

The URL field accepts **comma-separated links**. One link still loads preview and playlist import. Two or more skip preview of the blob, apply the same quality to every URL, and enqueue immediately. Playlist-only URLs in a list are skipped (`Skipped playlist link — paste it alone to import.`). Paste a playlist URL **alone** for import/subscribe. Duplicate videos (already queued, downloading, or in the library) toast and are not added; deleting a library row and pasting again is allowed.

Cancel shows **Cancelled**, not a failed download. Quality-restart cancels stay silent.

### Pause / resume

On the Download page:

- **Pause** — stops active work and prevents new jobs from starting until you resume
- **Resume** — continues the FIFO queue

Pause-all stops claiming new yt-dlp downloads; an encode that already started keeps running. Nothing new starts until you resume. The pause flag is stored as `download_queue_paused` in app settings, so it **survives a container restart**.

### Disk limits { #disk-limits }

Nothing should fill the volume behind your back, least of all unattended channel auto-downloads and playlist subscriptions. Two checks run before a **library** download starts:

| Check | Set with | Default |
|-------|----------|---------|
| **Max disk usage** | Settings → System → Storage (admins), in GB | No limit |
| **Free-space floor** | `HORDE_MIN_FREE_GB` ([environment](../ops/environment.md)) | 2 GB |

The limit counts the same number Storage shows: the videos in the library, their H.264 copies and thumbnails, and the videos waiting in the [trash](library.md#trash) (they still use disk; emptying the trash makes room). A job waits when the library is already at the limit, when its estimated size (known once its formats are read) would cross it, or when the downloads volume has less than the floor free. **Offline (this device)** downloads only check the floor.

A waiting job is **held**, not failed: it stays in the queue, its card says why (for example *Paused: library is at its 55 GB limit* or *Paused: less than 2 GB free on disk*) and the Download page shows a banner above the queue. Horde looks again every 30 seconds, and straight away when a video is deleted or the limit is changed, and starts the job by itself once there is room. **Settings → System → Status** shows the same reason on the Active downloads row, and `GET /api/health` reports `status: "warning"` with `downloads.held_reason` while anything waits. Imports are not held (an import only checks that 1 GB stays free).

A download that has already started is allowed to finish, so the library can pass the limit by about one video per download slot ([`MAX_DOWNLOAD_CONCURRENCY`](../ops/environment.md)). Set the limit with that margin in mind.

If the disk runs out **while** a download writes (`No space left on device`), the job fails with the kind `disk_full` and the message *The disk is full*, and the queue holds for five minutes (or until you delete a video or change the limit) instead of failing every following job. Free up space and press **Retry**.

## Single video

1. Paste one video URL, or several separated by commas.
2. One URL: wait for preview metadata if you want title/channel edits. Several URLs skip preview and use the quality selector for every link.
3. Choose a preset (and optional volume normalize).
4. Choose a **destination**:
   - **Save to library** (default) — archives on the server under Channel/Year and appears in Library.
   - **Offline (this device)** — Horde still fetches/merges on the server into a temporary folder, then the app saves it into [offline storage](offline.md) on this device, playable from the **Offline** page. It is **not** kept in the library; dismissing the job card deletes the server's temp file (the offline copy stays). Without HTTPS the browser saves the file instead.
5. Submit — cards appear immediately (`Working…` until metadata fills). Already queued, downloading, or library videos toast instead of adding a second job.

Completed library downloads land in the [Library](library.md), organized by channel/year on disk ([storage layout](../ops/storage-layout.md)). Device jobs show **Watch** once saved offline, and a **Save file** action to also save the raw file to the device.

Playlist URLs are library-only (device destination is hidden). When Horde detects a playlist you choose one of three actions:

| Action | What it does |
|--------|----------------|
| **Import playlist** (default) | One-time download of the videos, saved as a playlist in Horde |
| **Subscribe** | Sync with the YouTube playlist and download new videos as they appear |
| **Download videos** | Download like regular videos, without organizing into a playlist |

## Sending links to Horde { #sending-links }

Instead of copying a link and pasting it on the Download page, send it from where you found it. Each route opens `/download?url=<link>`, which fills the URL field and reads the link (title, channel, qualities) exactly as if you had pasted it. **Nothing is queued until you press Download**, and the link is then removed from the address bar so a reload does not repeat the lookup. A member without the download permission sees the usual "Not available for your account" page. When you are signed out, you sign in first and come back to the same link.

- **Android share sheet.** Install Horde as an app (see [Offline & installed app](offline.md#install-the-app)); **Horde** then appears in the share sheet of the YouTube app and of Chrome. Sharing a video opens the Download page with the link filled in. This needs the installed app (Chrome only offers it for installed web apps, over HTTPS), and an installed app from before this release must be reinstalled once to pick up the share option.
- **Bookmarklet (any desktop browser, and phones without the share sheet).** Open the Download page, expand **Send links from your browser** and drag **Send to Horde** to your bookmarks bar. Click it on any video page and that page opens in a new tab on Horde. On a phone, use **Copy bookmarklet**, create any bookmark, and paste the copied text into its address. A few sites (GitHub, for example) forbid bookmarklets with their security policy; use the share sheet or copy the link instead there.
- **iPhone and iPad.** Safari does not support share targets, so make a Shortcut. In the Shortcuts app, create one named **Send to Horde**, open its settings and turn on **Show in Share Sheet** (accept **URLs** and **Safari web pages**), then add these actions in order: **URL Encode** the **Shortcut Input**; **Text** containing `https://<your-horde>/download?url=` followed by the **URL Encoded Text** variable; **Open URLs** with that text. Replace `<your-horde>` with the address you use for Horde. Sharing a link and picking **Send to Horde** opens the Download page with it filled in. The bookmarklet also works in Safari.

## Playlist import

Paste a **playlist** URL on the Download page:

1. Horde loads playlist entries.
2. Choose **Import playlist**, **Subscribe**, or **Download videos**.
3. For import / download-videos, select which items (all or a subset). Subscribe uses the full remote list.
4. Optionally set a **playlist name** (import and subscribe).
5. Choose a quality preset and run the action.

Import and subscribe skip YouTube ids already in the library (attach only). Manage lists later under [Playlists](playlists.md). You can also subscribe from `/playlists` with a URL field.

!!! tip "Create empty playlists elsewhere"
    Local empty playlists are created on `/playlists`. YouTube playlist ingest still goes through Download or the Playlists subscribe field.

## Loudnorm (optional)

You can enable **volume normalization** (ffmpeg `loudnorm`) on download. When on, Horde runs a post-download loudness pass (I=−16, TP=−1.5, LRA=11) if `ffmpeg` is available. Video is copied; audio is re-encoded to AAC with `faststart` so the file stays phone-playable. If ffmpeg is missing or the pass fails, the download still succeeds with a warning.

Toggle via the download options / `normalizeVolumeOnDownload` preference when submitting.

## Progress and failures

The queue panel shows status, percentage, and errors. After the file is on disk, the card names the current post-download step instead of a generic Processing label: **Merging** (yt-dlp combining video+audio), **Encoding audio** (Opus/Vorbis → AAC for Safari), **Remuxing** (MP4 / `faststart` without an audio re-encode), **Transcoding** (H.264 conversion in `h264_convert` mode), or **Normalizing** (optional loudnorm). Failures carry a typed **`error_kind`** (bot check, PO token, age-restricted/private, members-only, rate limit, unavailable, post-process, etc.) with a short fix hint on the card; the Download URL field also shows a banner when link preview fails for the same reasons.

Failed jobs can be retried from the card. Retry **requeues the same job** (it does not create a second queue entry), so extra clicks while it is already queued or downloading are ignored. Active download paths are marked so the [import scanner](import-review.md) does not race the same files.

Completed jobs stay in **Recent downloads**.

| Control | What it does |
|---------|----------------|
| **Watch →** | Open the library video |
| **Delete** | Removes the video **and file** from the library. The card stays so you can **Redownload**. |
| **×** | Hides the card only. The video stays in the library. |
| **+ Playlist** | Add the finished video to a local playlist |

You can still attach a note while a download is queued or in progress. After it finishes, edit notes from the watch page.

Completed library cards stay in Recent downloads after you delete the video from the library (**Removed**). **Redownload** queues a **new** library copy from the saved URL and preset, keeping leftover title, channel, and any note that was still on the job. Notes saved after the original download, tags, and watch progress are not restored. Replaced (superseded) cards and failed jobs do not show Redownload — failed jobs keep **Retry**.

See [Troubleshooting — error kinds](../ops/troubleshooting.md#download-error_kind-values) and [YouTube access](../ops/youtube-access.md).

## Related

- [Channels](channels.md) — channel-scoped download panel
- [Watching](watching.md) — stream preview → download handoff
- [Playlists](playlists.md) — after YouTube import
- [Download pipeline](../architecture/downloads-pipeline.md)
- [Environment variables](../ops/environment.md) — `MAX_DOWNLOAD_CONCURRENCY`, `HORDE_MIN_FREE_GB`

## Upgrading: file and folder names

New downloads use byte-limited names and a folder that matches the channel Horde stores for the video (see [storage layout](../ops/storage-layout.md)). Existing files are never renamed. For channels with a very long name (more than 80 bytes), or whose names end in a dot or space, new videos can therefore land in a different folder than older ones from the same channel. Re-downloading a video whose channel you edited also moves it to the edited channel's folder.

# Downloads

The **Download** page (`/download`) is where you paste a URL, pick a quality preset, watch the queue, and import YouTube playlists into Horde.

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

After metadata loads, the UI may limit the preset list to formats actually available for that URL and show approximate sizes when known. Audio bitrate caps that are at or above the source’s best stream are omitted (use **Audio (best)** instead).

When you queue with **Best available** (the channel download panel default), Horde still fetches the highest source tier, but the download queue stores and shows that **actual resolution** (for example **4K**) instead of the “best” label. Finished cards use the probed file height, never **Best available**.

Height-capped presets prefer an exact match (e.g. 1080p) when YouTube offers it, then the best stream under that height — they never fall back to unbounded `best`. Within a height, the **AV1** archive setting prefers **AV1 + AAC** over a higher-bitrate VP9/H.264 stream, then remuxes to MP4 with `faststart` (video is **copied**). If the finished file is still below the requested tier, the Download/Watch toast shows a **quality warning**.

## Compatibility codecs (beta) { #compatibility-codecs }

Horde stores **one file per video** and plays it as a normal MP4 (HTTP range requests). There is **no live per-client transcode** like Plex. Whatever codec is in the file is what the browser or phone must decode. Settings → Library → Downloads → **Archive video codec** is **beta**. New downloads default to **AV1** (video copied, no encode). That choice is stamped onto every new job. Existing library files stay as they are until you [redownload / change resolution](#change-resolution-library).

### Why convert AV1 at all

YouTube now publishes its **highest resolutions as AV1** (and sometimes VP9). That is great for bandwidth: AV1 is smaller than H.264 at the same quality. The catch is **decode support**:

- Many recent desktop browsers can play AV1
- A large set of phones, tablets, TVs, set-top boxes, and some Safari/Linux setups **cannot**
- YouTube itself still offers **H.264 only up to 1080p**. There is no 1440p/4K H.264 (or H.265) stream to download. YouTube never ships HEVC for these videos

So if you want **4K on a device that cannot play AV1**, Horde must **download the AV1 4K file and re-encode it** on your server to H.264 or H.265, then replace the library file. That conversion is lossy (a generation down from YouTube’s encode) and uses CPU or GPU. 1080p and below can usually skip that: YouTube already has H.264, which Horde copies.

Convert when playback clients cannot decode AV1. Keep AV1 when they can — it is the smallest, best-looking archive and costs almost nothing to store.

Choose the format for **who watches the library**, not for which GPU Ollama uses.

### AV1

YouTube’s default for 1440p/4K, and often 1080p as well. Horde **copies** the video bitstream and only remuxes to MP4 + AAC + `faststart` (Safari needs AAC audio and the `moov` atom at the start of the file; that remux is not a video transcode).

- **Files:** smallest
- **Quality:** highest — no re-encode
- **Server cost:** none beyond the remux
- **Playback:** modern Chrome, Firefox, and Edge; recent flagship phones. Fails on many older devices and on some Linux/Safari setups

Use this when every screen you care about can decode AV1.

### H.264

The compatibility codec. Nearly every browser, phone, tablet, and TV can play it.

- **Files:** largest, especially at 1440p/4K
- **Quality:** YouTube’s own H.264 at 1080p and below (no encode). 1440p/4K is a transcode of AV1, so a bit softer/larger than keeping AV1
- **Server cost:** none at ≤1080p; GPU or slow software encode at 1440p/4K
- **Playback:** pick this when you do not control the client, or when Linux Chrome / older hardware must work

At 1440p/4K Horde still downloads AV1 (the only high-res stream), then transcodes to H.264.

### H.265 (HEVC)

A middle path **at 1440p/4K**: smaller than H.264, playable on more devices than AV1 (recent phones, tablets, TVs, Safari). Linux Chrome often still cannot play HEVC.

- **Files:** smaller than H.264 at 1440p/4K. 1080p and below stay YouTube H.264 — transcoding those to HEVC would not help compatibility and would only burn the server
- **Quality:** transcode of YouTube AV1 at 1440p/4K
- **Server cost:** GPU encode when Horde’s ffmpeg has NVENC/QSV/VAAPI; otherwise very slow software encode
- **Playback:** strong on recent Apple/Android hardware and many TVs; weaker on desktop Linux browsers

### How the server GPU affects transcoding

Transcode runs **once, when the download finishes**, inside the **Horde** process on your NAS/PC — not while someone is watching, and **not** on the Ollama GPU if that is a different machine.

| Host GPU situation | What 1440p/4K H.264/H.265 jobs do |
|--------------------|-----------------------------------|
| **NVIDIA** (NVENC), device passed into the `horde` container, jellyfin-ffmpeg in the image | Minutes per 4K file, encoder block (chat/LLM can still use CUDA) |
| **Intel** QSV / **AMD** VAAPI or AMF, `/dev/dri` on `horde` | Similar: hardware encode, much faster than CPU |
| **GPU visible in System → Resources but Settings warns** | nvidia-smi/DRM see a card, but **this** ffmpeg cannot use it — pass the GPU into **`horde`**, not only Ollama, and use jellyfin-ffmpeg (Debian ffmpeg has no NVENC) |
| **None detected**, no GPU, or GPU only on another PC for Ollama | **Software** `libx264` / `libx265`: 4K can take a long time (often hours). 1080p H.264 downloads still need no encode |
| **AV1 setting** | GPU does not matter; video is copied |

Horde software-decodes the source AV1 (CPU, usually fine) and uses the GPU for the **encode** when an encoder is available. Settings → Library marks **Rec** from that same probe (`hw_hevc` / `hw_h264` on `/api/system/stats`), and shows an amber warning when 1440p/4K would fall back to software.

Encoder pick order: NVENC → QSV → VAAPI/AMF → VideoToolbox → libx264/libx265.

Setup: [GPU](../ops/environment.md#gpu) (passthrough and when you need one). Encode details: [Archive transcode (beta)](../ops/environment.md#horde-encode-gpu).

Safari (including other browsers on iOS) still needs **AAC** in MP4 and `faststart`. That remux always runs; it is not the same as choosing H.264/H.265. Desktop Chrome’s device emulation is not a substitute for a real phone.

## Change resolution (in-progress)

On an **active** queue card (or the stream-watch download indicator), pick a different resolution from the quality menu. Horde **discards partial files** and restarts that job at the new preset — no extra confirmation. Queued jobs just switch preset and keep their place.

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

You can enable **volume normalization** (ffmpeg `loudnorm`) on download. When on, Horde runs a post-download loudness pass (I=−16, TP=−1.5, LRA=11) if `ffmpeg` is available. Video is copied; audio is re-encoded to AAC with `faststart` so the file stays phone-playable. If ffmpeg is missing or the pass fails, the download still succeeds with a warning.

Toggle via the download options / `normalizeVolumeOnDownload` preference when submitting.

## Progress and failures

The queue panel shows status, percentage, and errors. Failures carry a typed **`error_kind`** (bot check, PO token, cookies, members-only, rate limit, unavailable, post-process, etc.) with a short fix hint on the card; the Download URL field also shows a banner when link preview fails for the same reasons.

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
- [Environment variables](../ops/environment.md) — `MAX_DOWNLOAD_CONCURRENCY`

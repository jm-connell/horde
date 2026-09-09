# Download pipeline

End-to-end path from a pasted URL to a library row and live UI updates.

## Flow

```text
URL
  -> url_clean (normalize / strip tracking)
    -> cheap enqueue DownloadJob (no yt-dlp extract; YouTube thumb from i.ytimg)
    -> GET /api/downloads/events (one SSE for the queue)
    -> background job-metadata fill (low-priority extract)
    -> download slot (MAX_DOWNLOAD_CONCURRENCY) — yt-dlp only
    -> ffmpeg slot (1, or 2 with a GPU encoder; MAX_FFMPEG_CONCURRENCY)
    -> library: Channel/YYYY/Title [id].ext
       device:  _device/{job_id}/Title [id].ext (ephemeral)
    -> optional loudnorm / H.264/H.265 transcode (ffmpeg slot; bar uses out_time)
    -> library only: FFmpegSubtitlesConvertor -> .vtt, thumbnails + sprites, Video row
    -> device: browser GET /api/downloads/{id}/file; delete on dismiss
    -> library: optional AI enqueue (embed / tags / summary)
```

## Module split

Download-related code is split for maintainability (façades may still re-export):

| Module | Role |
|--------|------|
| `downloader.py` | `DownloadQueue`, ffmpeg postprocess queue, finalize, playlist import / subscribe attach |
| `job_metadata.py` | Background title/preset fill for cheap-enqueued jobs |
| `ffmpeg_progress.py` | ffmpeg `-progress` / `out_time` parsing and cancel |
| `ytdlp_extract.py` | Download-card preview, channel feed fetch, channel search |
| `ytdlp_formats.py` | Quality preset / format-chain helpers; original-language audio picker |
| `mp4_compat.py` | Copy-video remux to MP4: AAC audio + `faststart` for Safari |
| `encode_probe.py` | ffmpeg encoder inventory in the Horde process |
| `video_transcode.py` | Optional GPU/software H.264/H.265 encode after remux |
| `stream_preview.py` | In-app progressive + DASH preview caches/manifests |
| `ytdlp_common.py` | Cookies, POT, extract gate, error classification |

## URL cleaning

`url_clean` normalizes share links and strips noisy query params before extract/download so duplicate jobs and cache keys stay stable.

## yt-dlp

- Format presets: `best`, height caps (`2160p`…`480p`), `audio`. Default selectors prefer AV1 then AAC; `format_sort` is `res`, `fps`, `hdr:12`, `vcodec:av01`, `lang`, `acodec:mp4a`, `vbr`, `abr`. After download-meta extract, Horde pins the original-language audio `format_id` (same scoring as stream preview) so autodubs lose to the source track. A Settings **archive video codec** (beta) of H.264/H.265 uses YouTube `avc1` at ≤1080p and still prefers AV1 as the source at 1440p/4K, then transcodes. Existing library files are not rewritten.
- Output template under `DOWNLOADS_DIR`:

  ```text
  %(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s].%(ext)s
  ```

- Extractor args use yt-dlp’s default YouTube player clients minus `android_vr` (those CDN URLs now 403 after ~60s of range requests). bgutil POT is attached when `YTDLP_POT_BASE_URL` is set. Cookies (see [YouTube access](../ops/youtube-access.md)) stay off until a specific video is blocked as age-restricted or members-only; that one extract/download is retried with cookies.
- `POST /api/downloads` and `/bulk` insert a job and return immediately (catalog autodownload already did this). Title/presets fill on a background worker that uses the **low-priority** extract gate. Interactive `GET /preview` jumps that gate. Preview, download-meta, and stream preview share the same `url` cache key.
- Duplicate checks are by **video identity** (YouTube id, else cleaned URL): already queued, already downloading, or still in the library. Paste does not set `replace_video_id`. Library/Watch redownload still can. Cancelled / failed / deleted-then-readded are not duplicates.
- Metadata extracts share the same global extract gate (1 + 1.25s spacing, priority waiters) as preview/feed extracts so concurrent browsing does not stampede YouTube.
- Progress hooks update an in-memory `progress_store` consumed by **one** `GET /api/downloads/events` stream (plus per-job `/{id}/events` for Watch). Percent during download is combined bytes; during remux/transcode/loudnorm it is ffmpeg `out_time` (not clamped to 99). yt-dlp merge and Horde’s MP4 compat / transcode / loudnorm flip to `processing` with a `stage` token.
- Preview `preset_sizes` walk the same `format_chain` + `format_sort` as the downloader and sum each selected format’s components (`filesize` / `filesize_approx` / bitrate×duration), so 4K DASH is not labeled with a progressive mux or audio-only size.
- The download slot is released after yt-dlp; ffmpeg remux/transcode/loudnorm use a separate cap (**1**, or **2** if a GPU encoder is available). Pause does not kill an in-flight encode. Cancel kills the ffmpeg process.
- Failures set `DownloadJob.error` plus a typed `error_kind` (`bot`, `pot`, `cookies`, `members`, `rate_limit`, `unavailable`, `postprocess`, `cancelled`, `unknown`) for actionable UI. Cancel races are coerced off `status=error`.
- Retry (`POST /api/downloads/{id}/retry`) resets a failed/cancelled job to `queued`. Extra retries while it is already active return that same job. A second paste of an already-queued video is **409** (`already_queued` / `already_downloading` / `already_in_library`), not a silent reuse.
- Enqueue with `quality_preset: "best"` stays `best` until the metadata filler resolves the highest concrete source tier. `POST /api/downloads/{id}/quality` changes preset on a queued/downloading job; in-flight work is cancelled, partials deleted, and the same job is re-queued (no cancelled toast).
- List responses always include **all** `queued`/`downloading` jobs plus a bounded recent terminal list. They flag `video_missing` / `superseded`, and include `height_px`. **Clear all** dismisses completed, failed, **and cancelled**. The Download UI offers **Redownload** only for missing library videos.

Members-only detection aborts/skips rather than looping forever.

Global queue pause is persisted as `download_queue_paused` in app settings so it survives process restart. Jobs left `downloading` are requeued on startup.

## Post-processing

| Step | Detail |
|------|--------|
| **FFmpegSubtitlesConvertor** | yt-dlp postprocessor → WebVTT sidecars. Timedtext **429**s keep `subtitles_pending` and retry with backoff ([subtitle retry](workers.md#subtitle-retry)) instead of giving up. |
| **mp4 compat** | Video-copy remux: AAC audio if needed, `+faststart`. Keeps AV1/4K on the AV1 setting. |
| **compat transcode** | When the job’s `video_codec` is h264/h265 and the file is not already that codec (H.265 skips encode at ≤1080p H.264). GPU NVENC/QSV/VAAPI when the Horde process can use it; otherwise software. |
| **loudnorm** | Optional EBU-ish loudness (`I=-16:TP=-1.5:LRA=11`) when the job requests normalize; keeps AAC + faststart |
| **Thumbnails** | Cached under `DATA_DIR/thumbnails` |
| **Sprites** | Seek-preview sheet + JSON under `DATA_DIR/sprites` |

Probe helpers fill duration, dimensions, playability before the row is marked ready.

## Video row

On success the job links to a `videos` row (`file_path` relative to downloads, status `ready`). Replace-download flows can target an existing `replace_video_id`. Failed jobs keep `error` text plus typed `error_kind`; cancel cleans fragments.

## SSE events

`GET /api/downloads/events` is the Download page’s single EventSource (`{job_id, ...snapshot}`). Per-job `GET /api/downloads/{id}/events` remains for Watch. Snapshots include `progress`, status, `stage` during post-download work, title, `error` / `error_kind`. See [API overview](api-overview.md).

## Related

- [Downloads guide](../guides/downloads.md)
- [Workers](workers.md)
- [Storage layout](../ops/storage-layout.md)

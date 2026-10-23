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
    -> optional loudnorm / h264_convert re-encode (ffmpeg slot; bar uses out_time)
    -> library only: FFmpegSubtitlesConvertor -> .vtt, thumbnails + sprites, Video row
    -> device: browser GET /api/downloads/{id}/file; delete on dismiss
    -> library: optional AI enqueue (embed / tags / summary)
    -> sidecar mode: queue the H.264 copy (compat job, see below)
```

## Module split

Download-related code is split for maintainability. The queue, the yt-dlp attempt loop and the library commit live in the `services/downloads/` package. The old `downloader.py` compatibility façade (and the `start_download` shim) are gone; use `jobs.enqueue_download` and the other package modules directly.

| Module | Role |
|--------|------|
| `downloads/queue.py` | `DownloadQueue`: FIFO dispatch, global pause, cancel, quality restart, stuck-job reaper. It is handed the job runner instead of importing it |
| `downloads/runner.py` | `run_download`: the yt-dlp attempt loop (format selectors, one cookie retry, recovery of a finished file), then the hand-off to the postprocess queue |
| `downloads/ffmpeg_queue.py` | `FfmpegQueue`: bounded postprocess stage so a slow encode does not hold a download slot |
| `downloads/postprocess.py` | `PostprocessTask` and the ffmpeg steps: Safari remux, H.264 transcode, loudness normalisation, quality check |
| `downloads/finalize.py` | `complete_download`: promote from staging, commit the library row (`commit_library_video`), queue AI, catalog, subtitles, thumbnail and sidecar work |
| `downloads/jobs.py` | Job rows: duplicate detection, retry preparation, quality change, `job_mutate_lock` |
| `downloads/playlist_import.py`, `playlist_attach.py` | Playlist import as ordinary queue jobs; placing a finished download at its playlist position |
| `downloads/progress.py` | `progress_store` and the yt-dlp progress / postprocessor hooks |
| `downloads/staging.py`, `artifacts.py` | Per-job staging and `_device` dirs, output templates, promoting into the library; finding and cleaning yt-dlp output files |
| `downloads/lifecycle.py`, `errors.py`, `dbwrite.py`, `spec.py`, `infodict.py`, `subtitles.py` | Ending a job (cancel / requeue / fail), exceptions and the yt-dlp logger, locked-database retries, the `JobSpec` snapshot of a job row, info-dict helpers, subtitle fetch |
| `job_metadata.py` | Background title/preset fill for cheap-enqueued jobs |
| `ffmpeg_progress.py` | ffmpeg `-progress` / `out_time` parsing and cancel |
| `ytdlp_extract.py` | Download-card preview, channel feed fetch, channel search |
| `ytdlp_formats.py` | Quality preset / format-chain helpers; original-language audio picker |
| `mp4_compat.py` | Copy-video remux to MP4: AAC audio + `faststart` for Safari |
| `encode_probe.py` | ffmpeg encoder inventory in the Horde process |
| `video_transcode.py` | GPU/software H.264 encode for `h264_convert` and library conversion |
| `compat_rendition.py` | H.264 sidecar + in-place convert jobs, ffmpeg command, retry ladder, startup probe backfill |
| `media_info.py` | ffprobe summary stored on the video row (codec, codec string, bit depth, HDR); `needs_compat` |
| `stream_preview.py` | In-app progressive + DASH preview caches/manifests |
| `ytdlp_common.py` | Cookies, POT, extract gate, error classification |

## URL cleaning

`url_clean` normalizes share links and strips noisy query params before extract/download so duplicate jobs and cache keys stay stable.

## yt-dlp

- Format presets: `best`, height caps (`2160p`…`480p`), `audio`. Default selectors prefer AV1 then AAC; `format_sort` is `res`, `fps`, `hdr:12`, `vcodec:av01`, `lang`, `acodec:mp4a`, `vbr`, `abr`. After download-meta extract, Horde pins the original-language audio `format_id` (same scoring as stream preview) so autodubs lose to the source track. The Settings **playback compatibility** mode (`video_codec` on the job) picks the selector: `av1` as above; `h264_native` uses YouTube `avc1` and caps every video preset at 1080p; `h264_convert` uses `avc1` at ≤1080p and AV1 at 1440p/4K, then re-encodes; `sidecar` downloads AV1 like `av1` and fetches a second H.264 file afterwards. Legacy `h264`/`h265` normalize to `h264_convert`. Existing library files are not rewritten.
- Output template (rooted in the job's `DOWNLOADS_DIR/.horde-staging/{job_id}/`, then promoted into the library; see [storage layout](../ops/storage-layout.md)):

  ```text
  <channel>/%(upload_date>%Y|Unknown year)s/%(title).150B [%(id).64B].%(ext)s
  ```

  The channel folder is chosen in Python (`services/outtmpl.py`) to match `Video.channel`; the title budget shrinks until yt-dlp's own rendering leaves room for suffixes under 255 bytes. File-name matching for cleanup (`paths.video_stem` / `belongs_to_stem`) is exact on the full stem, never a prefix scan.
- Job robustness: the worker body is total (any failure ends the job in `error`, DB writes retry "database is locked"), and a reaper requeues `downloading` jobs no worker or ffmpeg stage owns. Scanner marks are held until the postprocess stage finishes. Playlist import enqueues normal jobs tagged with `playlist_id`; order is kept through ascending job ids (no position column on jobs).

- Extractor args use yt-dlp’s default YouTube player clients minus `android_vr` (those CDN URLs now 403 after ~60s of range requests). bgutil POT is attached when `YTDLP_POT_BASE_URL` is set. Cookies (see [YouTube access](../ops/youtube-access.md)) stay off until a specific video is blocked as age-restricted or members-only; that one extract/download is retried with cookies.
- `POST /api/downloads` and `/bulk` insert a job and return immediately (catalog autodownload already did this). Title/presets fill on a background worker that uses the **low-priority** extract gate. Interactive `GET /preview` jumps that gate. Preview, download-meta, and stream preview share the same `url` cache key.
- Duplicate checks are by **video identity** (YouTube id, else cleaned URL): already queued, already downloading, or still in the library. Paste does not set `replace_video_id`. Library/Watch redownload still can. Cancelled / failed / deleted-then-readded are not duplicates.
- Metadata extracts share the same global extract gate (1 + 1.25s spacing, priority waiters) as preview/feed extracts so concurrent browsing does not stampede YouTube.
- Progress hooks update an in-memory `progress_store` consumed by **one** `GET /api/downloads/events` stream (plus per-job `/{id}/events` for Watch). Percent during download is combined bytes; during remux/transcode/loudnorm it is ffmpeg `out_time` (not clamped to 99). yt-dlp merge and Horde’s MP4 remux / transcode / loudnorm flip to `processing` with a `stage` token.
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
| **convert** | Only for `h264_convert`: when the finished file is not already 8-bit H.264 (the ≤1080p native case skips the encode). GPU NVENC/QSV/VAAPI when the Horde process can use it; otherwise software. Replaces the original. |
| **H.264 sidecar** | Only for `sidecar` (video presets): after the row is ready and finalize is queued, a `compat` job is enqueued if `needs_compat`. See below. |
| **probe** | Every finished file is ffprobed into the `videos` row (`vcodec`, `acodec`, `codec_string`, `bit_depth`, `is_hdr`, `media_probed_at`). A new original also clears any previous sidecar. |
| **loudnorm** | Optional EBU-ish loudness (`I=-16:TP=-1.5:LRA=11`) when the job requests normalize; keeps AAC + faststart |
| **Thumbnails** | Cached under `DATA_DIR/thumbnails` |
| **Sprites** | Seek-preview sheet + JSON under `DATA_DIR/sprites` |

Probe helpers fill duration, dimensions, playability before the row is marked ready.

### H.264 sidecar { #h264-sidecar }

`compat_rendition.py` runs two job kinds on one small pool (the ffmpeg cap above):

1. **`compat`** writes `<stem>.horde-h264.mp4` beside the original. For YouTube sources it first runs yt-dlp with `compat_format_spec` (avc1 ≤1080p by short side + the original-language AAC track) into `<stem>.horde-h264.dl.*`. If YouTube has no avc1 stream, or that fails, it encodes locally into `<stem>.horde-h264.enc.mp4` (NVENC → QSV → VAAPI → AMF → VideoToolbox → libx264). The result goes through the Safari remux, is renamed into place, and `compat_path` / `compat_size` / `compat_source` (`youtube` or `transcode`) are saved on the row. Failures save `compat_error`.
2. **`convert`** re-encodes the original in place to H.264 at source resolution (`h264_convert` library action). A ≤1080p H.264 result makes any existing sidecar redundant, and it is deleted.

Encode details: 8-bit `yuv420p` High profile, short side ≤1080, AAC 160k stereo (copied when already AAC), `faststart`, HDR tone-mapped with `zscale` + `tonemap=hable` when ffmpeg has the filters. NVENC jobs use NVDEC for H.264/HEVC/VP9 sources; AV1 decodes on the CPU (dav1d) because GTX 16/RTX 20 cards have no AV1 decoder. On failure the **retry ladder** drops NVDEC, then tone-mapping, before erroring. Jobs are idempotent per video, in-memory progress is polled via the video row and `/api/videos/{id}/compat`, and viewer-requested jobs jump the queue.

The scanner ignores any filename containing `.horde-h264.`, so copies and temps never become library videos.

## Video row

On success the job links to a `videos` row (`file_path` relative to downloads, status `ready`). Replace-download flows can target an existing `replace_video_id`. Failed jobs keep `error` text plus typed `error_kind`; cancel cleans fragments.

## SSE events

`GET /api/downloads/events` is the Download page’s single EventSource (`{job_id, ...snapshot}`). Per-job `GET /api/downloads/{id}/events` remains for Watch. Snapshots include `progress`, status, `stage` during post-download work, title, `error` / `error_kind`. See [API overview](api-overview.md).

## Related

- [Downloads guide](../guides/downloads.md)
- [Workers](workers.md)
- [Storage layout](../ops/storage-layout.md)

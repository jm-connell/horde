# Download pipeline

End-to-end path from a pasted URL to a library row and live UI updates.

## Flow

```text
URL
  -> url_clean (normalize / strip tracking)
  -> enqueue DownloadJob
  -> worker slot (MAX_DOWNLOAD_CONCURRENCY)
  -> yt-dlp download (POT + cookies, quality preset)
  -> output template: Channel/YYYY/Title [id].ext
  -> FFmpegSubtitlesConvertor -> .vtt
  -> optional loudnorm (.norm intermediate)
  -> thumbnails + sprites
  -> Video row (ready) + library paths
  -> SSE progress events -> Download UI
  -> optional AI enqueue (embed / tags)
```

## URL cleaning

`url_clean` normalizes share links and strips noisy query params before extract/download so duplicate jobs and cache keys stay stable.

## yt-dlp

- Format presets: `best`, height caps (`2160p`…`480p`), `audio`.
- Output template under `DOWNLOADS_DIR`:

  ```text
  %(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s].%(ext)s
  ```

- Extractor args include bgutil POT when `YTDLP_POT_BASE_URL` is set; cookies via [YouTube access](../ops/youtube-access.md).
- Metadata extracts for downloads share the same global extract gate (1 + 1.25s spacing) as preview/feed extracts so concurrent browsing does not stampede YouTube.
- Progress hooks update an in-memory `progress_store` consumed by SSE.
- Failures set `DownloadJob.error` plus a typed `error_kind` (`bot`, `pot`, `cookies`, `members`, `rate_limit`, `unavailable`, `postprocess`, `cancelled`, `unknown`) for actionable UI.

Members-only detection aborts/skips rather than looping forever.

Global queue pause is persisted as `download_queue_paused` in app settings so it survives process restart. Jobs left `downloading` are requeued on startup.

## Post-processing

| Step | Detail |
|------|--------|
| **FFmpegSubtitlesConvertor** | yt-dlp postprocessor → WebVTT sidecars |
| **loudnorm** | Optional EBU-ish loudness (`I=-16:TP=-1.5:LRA=11`) when the job requests normalize |
| **Thumbnails** | Cached under `DATA_DIR/thumbnails` |
| **Sprites** | Seek-preview sheet + JSON under `DATA_DIR/sprites` |

Probe helpers fill duration, dimensions, playability before the row is marked ready.

## Video row

On success the job links to a `videos` row (`file_path` relative to downloads, status `ready`). Replace-download flows can target an existing `replace_video_id`. Failed jobs keep `error` text; cancel cleans fragments.

## SSE events

`GET /api/downloads/{id}/events` (EventSource) streams progress snapshots (`progress`, status, title, speed, etc.) for the Download page and job cards. See [API overview](api-overview.md).

## Related

- [Downloads guide](../guides/downloads.md)
- [Workers](workers.md)
- [Storage layout](../ops/storage-layout.md)

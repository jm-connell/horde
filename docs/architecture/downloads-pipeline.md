# Download pipeline

End-to-end path from a pasted URL to a library row and live UI updates.

## Flow

```text
URL
  -> url_clean (normalize / strip tracking)
    -> enqueue DownloadJob (destination: library | device)
    -> worker slot (MAX_DOWNLOAD_CONCURRENCY)
    -> yt-dlp download (POT + cookies, quality preset)
    -> library: Channel/YYYY/Title [id].ext
       device:  _device/{job_id}/Title [id].ext (ephemeral)
    -> optional loudnorm (.norm intermediate)
    -> library only: FFmpegSubtitlesConvertor -> .vtt, thumbnails + sprites, Video row
    -> SSE progress events -> Download UI
    -> device: browser GET /api/downloads/{id}/file; delete on dismiss
    -> library: optional AI enqueue (embed / tags)
```

## Module split

Download-related code is split for maintainability (façades may still re-export):

| Module | Role |
|--------|------|
| `downloader.py` | `DownloadQueue`, finalize, playlist import orchestration |
| `ytdlp_extract.py` | Download-card preview, channel feed fetch, channel search |
| `ytdlp_formats.py` | Quality preset / format-chain helpers |
| `stream_preview.py` | In-app progressive + DASH preview caches/manifests |
| `ytdlp_common.py` | Cookies, POT, extract gate, error classification |

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

On success the job links to a `videos` row (`file_path` relative to downloads, status `ready`). Replace-download flows can target an existing `replace_video_id`. Failed jobs keep `error` text plus typed `error_kind`; cancel cleans fragments.

## SSE events

`GET /api/downloads/{id}/events` (EventSource) streams progress snapshots (`progress`, status, title, `error` / `error_kind`, etc.) for the Download page and job cards. See [API overview](api-overview.md).

## Related

- [Downloads guide](../guides/downloads.md)
- [Workers](workers.md)
- [Storage layout](../ops/storage-layout.md)

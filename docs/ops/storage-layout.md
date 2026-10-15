# Storage layout

Horde splits **media** and **app state** into two roots: `DOWNLOADS_DIR` and `DATA_DIR`. Paths are configurable; see [Environment variables](environment.md).

## Downloads (`DOWNLOADS_DIR`)

Primary media library. Default in Docker: `/downloads` (host: `DOWNLOADS_PATH`).

### Downloaded videos

yt-dlp writes (into a [staging dir](#download-staging), then moved here) with this layout:

```text
<channel>/%(upload_date>%Y|Unknown year)s/%(title).150B [%(id).64B].%(ext)s
```

Free-text fields are truncated by **bytes** (Linux limits a name to 255 bytes, so emoji-heavy titles plus yt-dlp's `.f137.mp4.part` suffixes would otherwise fail), and yt-dlp's Windows filename rules are on because the library is often browsed over SMB (no trailing dots/spaces, no `: ? " < > | *`; reserved names like `CON` get a `_` prefix). Files downloaded before this layout keep their names.

Example:

```text
downloads/
  Some Channel/
    2024/
      Interesting Talk [dQw4w9wgxcq].mp4
      Interesting Talk [dQw4w9wgxcq].en.vtt
```

| Piece | Meaning |
|-------|---------|
| Channel folder | The channel the library row carries: your channel override, else the uploader / channel from yt-dlp (max 80 bytes), else `Unknown channel` |
| Year | Upload year (`upload_date`) |
| Filename | Title + YouTube (or source) id in brackets + extension |

Supported library extensions: `.mp4`, `.mkv`, `.webm`.

### Imports

```text
downloads/imports/
```

Files dropped or uploaded for the [import / review](../guides/import-review.md) queue land here (or anywhere under downloads that the scanner sees). After approval they are moved into the channel/year layout.

### Download staging

```text
downloads/.horde-staging/{job_id}/
```

Every library download (new, re-download, change quality, replace) runs in its own staging dir with the same folder layout. Only after the file is validated and post-processed is it moved into the library (a same-path replace is atomic and the old copy is restored if the database write fails), so cancelling or failing a re-download never damages the file a library row points at. Paused jobs keep their staging dir so partial files resume. If restoring a replaced file ever fails, its previous copy is kept under `.horde-staging/<job>/.displaced/` (mirroring its library path) and logged at ERROR; boot restores it when its place is empty and never deletes it. The scanner ignores it. At boot, staging dirs of finished or missing jobs are removed, and stale `.part` / `.ytdl` / ffmpeg temp files older than `HORDE_TEMP_SWEEP_HOURS` (default 6) that nothing references are swept.

### Device staging (ephemeral)

```text
downloads/_device/{job_id}/
```

Temporary output for **Download to this device** jobs. Not indexed into the library; removed when the job card is dismissed (or by startup GC for orphaned dirs).

### Sidecars and temps

| Pattern | Role |
|---------|------|
| `*.vtt` | Subtitles (FFmpegSubtitlesConvertor post-process) |
| `*.part` | In-progress yt-dlp download |
| `.fNNN.*` | Per-format fragments before merge (e.g. `.f401.mp4`) |
| `.norm.*` / `*.norm.mp4` | Intermediate loudnorm output |
| `.compat.*` / `*.compat.mp4` | Intermediate AAC/faststart remux |
| `*.horde-h264.*` | H.264 compatibility copy and its temps ([below](#h264-sidecars)) |

### H.264 sidecars { #h264-sidecars }

Next to a video, Horde can keep an H.264 compatibility copy (see [Playback compatibility](../guides/downloads.md#compatibility-codecs)):

| Pattern | Role |
|---------|------|
| `<stem>.horde-h264.mp4` | The finished copy (≤1080p, 8-bit H.264, AAC, faststart). Counted in storage stats (`compat_bytes`) |
| `<stem>.horde-h264.dl.*` | Temp while YouTube's H.264 stream downloads |
| `<stem>.horde-h264.enc.mp4` | Temp while a local encode runs |

The scanner ignores any name containing `.horde-h264.`, so copies never appear as separate videos. Deleting a video deletes its copy; renaming a manual import moves it. Temps are safe to delete when no job is running. Back up copies only if you want to skip regenerating them; they are rebuildable.

The scanner and cleanup logic ignore intermediate fragments so partial downloads do not appear as library videos.

!!! note "What to back up"
    Back up the whole downloads tree if you care about media. Temps can be deleted safely if a job is not running. See [Backup & restore](backup-restore.md).

## Data (`DATA_DIR`)

App state. Default in Docker: `/app/data` (host: `DATA_PATH`).

```text
data/
  horde.db                 # SQLite library + jobs + AI tables
  app_settings.json        # Settings UI persistence
  feed_meta_cache.json     # Channel feed metadata cache
  thumbnails/              # Cached poster images (`{id}.jpg`, `{id}_sm.jpg`, `playlist_{id}.jpg`)
  sprites/                 # Seek-preview sprite sheets (+ JSON sidecars)
  backgrounds/             # Custom UI backgrounds
  fonts/                   # Uploaded UI fonts
```

| Path | Regenerable? |
|------|----------------|
| `horde.db` | **No** — source of truth for library rows, progress, playlists, AI meta |
| `app_settings.json` | Prefer keep; otherwise reconfigure in Settings |
| `feed_meta_cache.json` | Yes — rebuilt as feeds are browsed |
| `thumbnails/` | Yes — regenerate from media / source |
| `sprites/` | Yes — regenerate on demand |
| `backgrounds/`, `fonts/` | User uploads — keep if you customized appearance |

Embeddings live **inside** `horde.db` (not as loose files). They are regenerable via AI maintenance jobs after a restore of media + DB schema, but wiping the DB loses tags, notes, watch position, and playlists.

## Related

- [Channel/year layout (design)](../design/channel-year-layout.md)
- [Backup & restore](backup-restore.md)
- [Data model](../architecture/data-model.md)

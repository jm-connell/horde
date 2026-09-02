# Storage layout

Horde splits **media** and **app state** into two roots: `DOWNLOADS_DIR` and `DATA_DIR`. Paths are configurable; see [Environment variables](environment.md).

## Downloads (`DOWNLOADS_DIR`)

Primary media library. Default in Docker: `/downloads` (host: `DOWNLOADS_PATH`).

### Downloaded videos

yt-dlp writes with this template:

```text
%(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s].%(ext)s
```

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
| Channel folder | Uploader / channel name from yt-dlp |
| Year | Upload year (`upload_date`) |
| Filename | Title + YouTube (or source) id in brackets + extension |

Supported library extensions: `.mp4`, `.mkv`, `.webm`.

### Imports

```text
downloads/imports/
```

Files dropped or uploaded for the [import / review](../guides/import-review.md) queue land here (or anywhere under downloads that the scanner sees). After approval they are moved into the channel/year layout.

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
  thumbnails/              # Cached poster images
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

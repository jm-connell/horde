# Channel / year layout

On-disk organization is a first-class feature, not an accident of yt-dlp defaults. Horde stores downloads so they remain **browsable over SMB** and so the database can treat the relative path as stable identity.

## Layout

Downloaded files use this yt-dlp output template (under `DOWNLOADS_DIR`, typically `/downloads`):

```text
%(uploader)s/%(upload_date>%Y)s/%(title)s [%(id)s].%(ext)s
```

Example:

```text
Veritasium/2024/Why Machines That Bend Are Better [abc123XYZ01].mp4
```

| Segment | Meaning |
|---------|---------|
| **Channel** (`uploader`) | Top-level folder — matches the channel sidebar |
| **Year** | From upload date (`YYYY`) — keeps huge channels navigable in a file manager |
| **Title [id].ext** | Human-readable name plus the platform id in brackets |

Sidecar assets (thumbnails, subtitles, sprites) live beside or under the same tree according to download and post-process paths; the **catalog identity** for the video row is the relative media `file_path`.

## Why this shape

1. **SMB / NFS friendly** — Open the share, walk Channel → Year → files. You do not need the web UI to find something you already know by channel and era.
2. **Stable ids in the filename** — `[id]` survives title edits and helps duplicate detection and resync against YouTube.
3. **Matches how people think about YouTube** — channel first, chronology second, title last.

Manual imports (scanner / upload) use a simpler tree when approved: `Channel/Title.ext`, or `imports/Title.ext` until a channel is set. See [Review queue](review-queue.md).

## `file_path` as identity

Each `Video` row stores `file_path` as a **unique**, indexed relative path (POSIX slashes) under the downloads root. Lookups, deletes, renames, and streaming all resolve through that key.

!!! note "Relative, not absolute"
    Absolute host paths are not stored. Remounting the dataset at a different host path (common on TrueNAS) does not invalidate the database as long as the **contents** of the downloads volume stay the same.

When a file moves (for example, assigning a channel on review), Horde renames on disk and updates `file_path` in the same transaction path so the UI and SMB tree stay aligned.

## TrueNAS tip

Mount your media dataset at `/downloads` with `PUID`/`PGID` matching the share owner so files created by the container are visible and writable over SMB. Details: [TrueNAS / Dockge](../getting-started/truenas-dockge.md) and [Storage layout](../ops/storage-layout.md).

## Related

- [Review queue](review-queue.md) — dropped files lack channel/year until you finish them
- [Import & review](../guides/import-review.md) — operator workflow
- [Data model](../architecture/data-model.md) — `Video.file_path` and friends

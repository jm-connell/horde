# 0013. Deleted videos wait in a trash: a tombstone row and moved files, not a soft-delete flag

Status: Accepted

## Context

Deleting a video removed its rows and then its media file for good, and bulk delete made a slip expensive. Users wanted deleted videos to sit somewhere for a week, restorable, with a list, a size and an "Empty trash" button.

The obvious design is a `trashed_at` column on `videos`. Every reader of `videos` would then have to filter it: the library list, FTS5 search, the tag table, the vector index and recommendations, related videos, playlists, history, the channel feed and catalog "in library" flags, stats, metadata sync, the AI and compat workers, sprites and the scanner. A single missed query shows a deleted video, plays it, spends AI tokens on it or counts it twice, and the unique `file_path` and `youtube_id` of a trashed row would block a new download of the same video.

## Decision

- **A tombstone, not a flag.** Trashing a video (`services/trash.trash_video`) runs the ordinary delete (`delete_video_cascade`), so every table forgets it exactly as before. Before that, it writes one `trash_entries` row (migration `0010_trash`) holding the original id, title, channel, YouTube id and path, the size, who deleted it and when, a list of moved files (`files_json`) and a JSON snapshot of what a restore needs: the `videos` row, `video_ai_meta`, the embeddings (base64), playlist places (and which playlists used it as cover), every user's `user_video_state` and the chat messages.
- **Files are moved, not copied.** Media, subtitles and the H.264 copy go to `DOWNLOADS_DIR/.horde-trash/<entry>/` (a rename on the same filesystem), thumbnails and sprites to `DATA_DIR/trash/<entry>/`, each under its path relative to its root. The scanner, the temp sweep and orphan cleanup ignore the folder. If a move or the commit fails, the files go back and nothing is deleted.
- **Restore** moves the files back and re-inserts the rows with the original video id, skipping playlists and users that no longer exist. `video_tags` and `videos_fts` are never written directly: they are refilled by the SQLite triggers when the `videos` and `video_ai_meta` rows are inserted, and the youtube id by the mapper listener. It refuses with 409 `trash_conflict` when the old path is occupied or a library video has the same YouTube id (downloaded again). The scanner is told the media path is busy during the move so it does not import the file as a new video.
- **Retention.** A `trash-purge` worker erases entries older than `HORDE_TRASH_DAYS` (default 7) every hour, entries whose files are gone, and folders no entry owns once they are a day old. `HORDE_TRASH_DAYS=0` turns the trash off.
- **Which deletes.** Only the user's deletes of a video together with its file (single and bulk, and one service function for callers such as future retention rules). Keeping the file, the scanner dropping rows of missing files, replacement by a re-download, factory reset and account deletion stay permanent.
- **Disk.** Trashed bytes count toward the library size limit and the Storage total; erasing them wakes held downloads. Channel auto-download treats a trashed YouTube id as already in the library.
- **Access.** Everything needs the `delete_videos` permission.

## Consequences

- No query in the application changes: a trashed video is simply not a video. The cost is a restore routine that must know every table that hangs off `videos` (a new dependent table needs adding to the snapshot, or its rows are lost on restore).
- A restore returns the same id, so links, history and playlist places work again. Rows that are history rather than ownership (download jobs, the OpenRouter cost ledger, pending AI jobs) are not restored.
- The snapshot of a video with many embedding chunks can reach a megabyte of JSON in the database for up to a week; listings never read it.
- The trash is a visible folder on the media share (see [Storage layout](../ops/storage-layout.md#trash)) and its size is not free: the library limit and the disk-space floor see it.
- A crash between moving the files and the commit leaves a library row whose files sit in a trash folder without an entry. The folder is kept for a day before the purge removes it, which is enough to move the files back by hand.

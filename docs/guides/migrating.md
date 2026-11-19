# Moving an existing archive into Horde

Already have a folder of downloaded videos, from yt-dlp, Tube Archivist, Pinchflat, ytdl-sub or anything else? Horde can take them as they are. Nothing is renamed or moved when you approve them with **Approve N ready**, and the files stay readable without Horde.

## 1. Put the files where Horde looks

Horde's media folder is the one in `DOWNLOADS_PATH` (mounted at `/downloads` in the container). Either:

- point `DOWNLOADS_PATH` at your existing archive, or
- copy or move the archive into the media folder you made during [install](../getting-started/install-docker.md).

The files must be owned by (or at least readable and writable for) the `PUID`:`PGID` user Horde runs as. Horde takes `.mp4`, `.mkv`, `.webm`, `.m4v` and `.mov`.

Keep sidecar files next to their videos: a yt-dlp `.info.json` or a Kodi/Jellyfin `.nfo` with the same name as the video is where Horde reads titles, channels, dates and descriptions from.

## 2. Scan

Open **Import** and press **Scan for new files**, or wait for the background scan (every `SCAN_INTERVAL_SEC`, 60 seconds by default). Every file appears in the import queue, already filled in from its sidecars and path ([what Horde reads](import-review.md#filled-in-for-you)).

## 3. Approve

- **Approve N ready** takes every file that already has a title and channel into the library at once.
- **Fetch N from YouTube** looks up every file whose YouTube id Horde knows but whose channel it does not, one at a time, and approves each with what YouTube says. Files stay where they are.
- The rest need a channel typed in, one by one.

Videos with a YouTube source link then pick up view counts, captions, chapters and missing thumbnails from the periodic metadata sync in the background.

## By tool

| Coming from | What to expect |
|-------------|----------------|
| **yt-dlp** with `--write-info-json` | Everything is filled in from the `.info.json`. Use **Approve N ready**. |
| **yt-dlp**, default names (`Title [id].ext`) | Title from the name, YouTube link from `[id]`. The channel comes from the folder holding the file when files sit in per-channel folders. In a flat folder, use **Fetch N from YouTube**. |
| **Horde's own layout** (`Channel/Year/Title [id].ext`, for example from another Horde) | Title, channel and YouTube link from the path. Use **Approve N ready**. |
| **Pinchflat**, **ytdl-sub** or anything that writes `.nfo` files | Title, channel, date, description and tags from the `.nfo`. Turn NFO output on in that tool before you move the files, if it is off. |
| **Tube Archivist** | Its files are named `<channel id>/<video id>.mp4`, and titles and channels live in its database, not beside the files. Horde recognizes the video id: use **Fetch N from YouTube**. It takes a few seconds per file, so a large library takes a while; you can stop it and run it again later. Videos since removed from YouTube cannot be looked up and need a title and channel typed in. |
| **Phone or camera files** | No sidecars: type a title and a channel (for example "Family"). |

## Watching on a TV afterwards

If you used Jellyfin, Kodi or Plex on the same folder, keep doing so: turn on [media-server files](media-servers.md) and Horde writes `.nfo` files and thumbnails they read.

## If something goes wrong

- **Nothing shows up in Import.** Check that `DOWNLOADS_PATH` is the folder you think it is (`docker compose exec horde ls /downloads`) and that the files have one of the supported extensions.
- **"Permission denied" when approving or deleting.** The files are not owned by `PUID`:`PGID`; see [Storage layout](../ops/storage-layout.md).
- **A folder name became a channel by mistake.** Change the channel in the form before approving; nothing is saved until then.

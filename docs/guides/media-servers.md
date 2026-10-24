# Media servers (Jellyfin, Kodi, Plex)

Horde stores downloads as `Channel/Year/Title [id].ext` (see [Storage layout](../ops/storage-layout.md)). A media server pointed at the same folder reads that as a TV library: the **channel is the show** and the **year is the season**. By default it would then guess titles from file names and find no artwork. With **media-server files** turned on, Horde writes the standard metadata files that Jellyfin, Kodi and Plex (with a plugin) read instead, so they show Horde's titles, descriptions, upload dates, tags and thumbnails.

It is off by default and administrators only: **Settings → Library → Metadata and catalog → Media-server files** (`media_server_sidecars` in `app_settings.json`, see [All settings](../settings/all-settings.md)).

## What Horde writes

| File | Where | Content |
|------|-------|---------|
| `<name>.nfo` | Beside each video | Kodi `<episodedetails>`: `title`, `showtitle` and `studio` (the channel), `plot` (the description, when there is one), `season` (the upload year), `episode`, `runtime` (minutes), `aired` / `premiered` (upload date), `tag` for every tag and `genre` for the first five, `uniqueid type="youtube"` (the YouTube id, when known), `dateadded` |
| `<name>-thumb.jpg` | Beside each video | A copy of the video's thumbnail |
| `tvshow.nfo` | In the channel folder | Kodi `<tvshow>`: `title` and `studio` (the channel) and a `uniqueid` taken from the channel URL |

`<name>` is the video's file name without its extension, so `Veritasium/2024/Why Machines Bend [abc123XYZ01].mp4` gets `Why Machines Bend [abc123XYZ01].nfo` and `Why Machines Bend [abc123XYZ01]-thumb.jpg`.

Horde knows no channel avatar or description, so there is no `poster.jpg` and no show `plot`; the show has no artwork unless your media server finds some.

### Episode numbers

A media server needs an episode number that does not change. Horde derives it from the upload date: the **day of the year times 100**, plus one for each video of the same channel uploaded that day that was added to Horde earlier. The first upload on 5 March 2024 (day 65 of a leap year) is episode 6500, the second 6501. Adding a video never renumbers another one; only deleting an earlier upload of the same day moves the later ones down by one. A video without an upload date uses the day it was added.

### When the files are written

Only videos that are in the library (not waiting in [review](import-review.md)) and whose file exists. A file is written only when its content differs from what is on disk, through a temporary file and a rename, and never outside the downloads folder. They are updated after:

- a download finishes (and when a re-download replaces a video);
- you edit the title, description, tags or thumbnail, or a metadata resync or AI tagging changes them;
- you rename a channel (done in the background);
- you move a manual import by changing its title or channel; its files move with it.

Turning the setting on queues a **backfill** for the whole library. It runs in the background, a little at a time, and shows under [System → Background activity](../settings/system.md#background-activity).

Deleting a video with its file, sending it to the [trash](library.md#trash) and restoring it take the two per-video files along. Deleting only the library entry leaves them with the media.

### Turning it off

Switching the setting off stops new writes and **leaves the files in place**. **Remove sidecar files** (enabled once the setting is off) deletes every `.nfo`, `-thumb.jpg` and `tvshow.nfo` Horde wrote, in the background; the videos are not touched. The same is available as `POST /api/settings/media-sidecars/remove` (administrators; `409 media_sidecars_enabled` while the setting is on).

While the setting is on, Horde owns these files and overwrites them when a video changes, so do not edit them by hand.

## Set up your media server

Share or mount the downloads folder where the media server can read it (over SMB, NFS or a bind mount). A **read-only** mount is enough and keeps the server from writing next to your videos. Files that Horde creates use the container's `PUID` / `PGID`; make sure the account the media server runs as can read them (see [TrueNAS / Dockge](../getting-started/truenas-dockge.md)).

### Jellyfin

1. **Dashboard → Libraries → Add Media Library**, content type **Shows**, folder: the downloads folder (or a single channel folder).
2. In the library's settings, turn **Nfo** on under **Metadata readers** and put it first.
3. Under **Metadata downloaders**, uncheck every internet provider (TheMovieDb, TheTVDB and so on), or they will replace Horde's titles with guesses.
4. Under **Image fetchers** keep local images first. Turn off **Save artwork into media folders** and the **Nfo** saver, so Jellyfin does not write its own files next to Horde's.
5. Scan the library. Each channel is a show; season and episode numbers come from the `.nfo` files.

### Kodi

1. **Videos → Files → Add videos…** and browse to the downloads folder.
2. Set the content to **TV shows** and choose the **Local information only** scraper (Kodi calls the file based information "NFO"); this makes Kodi read the `.nfo` files instead of searching the internet.
3. Let it scan. **Update library** after a lot of downloads.

### Plex

Plex does not read `.nfo` files by itself. It needs the third-party **XBMCnfoTVImporter** agent (`XBMCnfoTVImporter.bundle`), which is not part of Horde and not tested by it. Install it in Plex's plug-in folder, then add a library of type **TV Shows** and pick that agent. Which agents your Plex version still supports is up to Plex and the agent's own documentation.

## Limits

- Horde's [H.264 compatibility copies](downloads.md#compatibility-codecs) (`*.horde-h264.mp4`) sit beside the originals. A media server lists them as files of their own, so you may want to exclude them or not use that mode together with a media server.
- A channel renamed in Horde changes the show title in the files, but the downloaded files stay in their old folder.

## Related

- [Storage layout](../ops/storage-layout.md#media-server-files)
- [Channel/year layout (design)](../design/channel-year-layout.md)
- [Library](library.md)

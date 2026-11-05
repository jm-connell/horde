# Import & review

Import is how local files enter the library without a YouTube download: drag-and-drop upload, or files dropped into the media tree by a scanner.

## Routes

| Path | Behavior |
|------|----------|
| `/import` | Import & review UI |
| `/review` | **Redirects** to `/import` (legacy URL) |

## Adding files

### Upload

On `/import`, drop or choose files. Accepted extensions:

- `.mp4`
- `.mkv`
- `.webm`
- `.m4v`
- `.mov`

Unsupported types are rejected with a toast.

### Scanner drops

Files that appear under the configured media/import paths (watchdog + poll scanner) are picked up automatically and appear in the same review queue. Active download outputs are ignored so the downloader and scanner don’t fight over the same path. See [Storage layout](../ops/storage-layout.md) and [Review queue design](../design/review-queue.md).

### Scan for new files

**Scan for new files** walks the media folder immediately instead of waiting for the watchdog or poll interval. It queues any video that is not already in the library, including files that were in the import queue and then **Skip**ped (or otherwise removed) without being approved into Horde. Library videos with a channel are left alone. The background poller does not undo Skip — only this button does.

## Review queue

Each pending item needs metadata before it becomes a first-class library video.

### Filled in for you

Horde reads what the files on disk already say and fills in the form; nothing is saved until you approve. A line above the form says where the values came from. In order of trust:

| Source | What Horde reads |
|--------|------------------|
| yt-dlp `.info.json` beside the video (same name, `.info.json` instead of the extension) | Title, channel and channel link, description, upload date, tags, thumbnail, source link |
| Kodi / Jellyfin `.nfo` beside the video | `title`, `showtitle` or `studio` (channel), `plot` (description), `aired` / `premiered`, `tag`, and a `uniqueid type="youtube"` |
| The path | The title is the file name without a `[id]` token. The channel is the folder above a year folder (`…/Channel/2024/file`), or the folder holding a file with a yt-dlp `[id]` (`…/Channel/Title [id].mp4`). A YouTube id from `[id]`, or Tube Archivist's `<channel id>/<video id>.mp4`, becomes the source link and thumbnail |

Only empty fields are filled: a title you typed, or a channel you set, is kept. Sidecars over 5 MB, files that do not parse and sidecars that link outside the media folder are ignored. Folders named for where files were put rather than who made them (`Downloads`, `YouTube`, `Videos`, `Inbox`, `Imports`, `Archive`, `Media`, …) are not taken for a channel. A `[...]` of 11 letters and digits is read as a YouTube id even when a camera wrote it, so check the source link on such files.

### Approve everything that is ready

When more than one file is waiting and some already have a title and channel (from the table above), **Approve N ready** moves all of those into the library at once, as suggested. Files stay where they are on disk, under their own names, and keep the thumbnail they have (a video with a YouTube link gets YouTube's later, from the metadata sync). Files without a channel stay in the queue. Needs the `edit_metadata` permission.

**Save & approve** on a single file that has no YouTube link and no `[id]` in its name (a camera file, or one known only from an `.nfo`) moves it to `Channel/Title.ext`, as for any manual import; files with a YouTube link or `[id]` stay where they are.

The form list shows 20 files at a time (**Show more** adds the next 20), because each form takes frame grabs from its video.

### Fetch details from YouTube

On a file whose YouTube id Horde knows (from its name, a sidecar or the Tube Archivist layout), **Fetch details from YouTube** fills the form from YouTube: title, channel, date, description, tags and thumbnail. Check the result, then **Save & approve**. Without internet on the server the lookup fails with a "could not reach" message; the rest of the form still works. Needs `edit_metadata`.

After approval, a video with a YouTube source link gets its view count, captions, chapters and (if it had none) thumbnail from the periodic [metadata sync](../settings/library.md).

### Approve

**Save & approve** requires a **channel** (and typically a title). Without a channel, the item stays in review — Horde’s library model is channel-centric ([channel/year layout](../design/channel-year-layout.md)).

### Skip

**Skip** removes the item from the import queue **without** assigning a channel. The file stays on disk. Prefer approve with a real channel for normal browsing. **Scan for new files** puts skipped items back in the queue.

### Delete

Delete removes the review item and can delete the file on disk (confirm in the UI).

## Duplicate groups

Horde groups **possible duplicates** (same or near-same content / ids / heuristics) on the Import page.

| Action | Notes |
|--------|--------|
| Open watch | Title links to the watch page |
| **Keep this** | Deletes the other files in the group (confirm lists titles) |
| Delete | Remove one video from disk + DB |
| **Not a duplicate** | Hides the group in this browser (`localStorage`) |
| **AI duplicate confirmation** | Optional — scores borderline pairs when AI is enabled |

Enable **AI duplicate confirmation** under [Settings → AI](../settings/ai.md) (`ai_duplicates`). Scoring runs **on demand from the Import API** when the groups endpoint loads — not as a background batch job.

## After approval

Approved videos show up in the [Library](library.md), participate in [Search](search.md), and can be added to [Playlists](playlists.md). Optional AI jobs (embed, enrich tags, summary) may enqueue depending on [AI settings](../settings/ai.md).

## Related

- [Moving an existing archive into Horde](migrating.md)
- [Downloads](downloads.md) — URL-based ingestion
- [Library](library.md) — browsing approved videos
- [AI features](ai-features.md) — duplicate confirmation
- [Review queue](../design/review-queue.md) — why review exists
- [Storage layout](../ops/storage-layout.md)

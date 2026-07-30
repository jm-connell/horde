# Playlists

Playlists group library videos for binge sessions, curated mixes, or archived YouTube lists. Horde keeps **local** playlist creation on `/playlists` and **YouTube playlist import** on the Download page so URL ingestion and the download queue stay in one place.

## Create a playlist

1. Open **Playlists** (`/playlists`).
2. Enter a name in the create field and press Enter / create.
3. Open the new playlist to manage items, or add videos from the library (below).

Empty local playlists are always created here — not on Download.

## Add videos from the library

Bulk-add is the fastest path for large sets:

1. Open the [Library](library.md).
2. Click **Select**.
3. Click cards to toggle; **Shift**-click to select a **range**.
4. Open **Add to playlist** in the bulk bar and choose the target list.

You can also add from individual video edit / detail flows where the UI exposes playlist membership.

## Import from YouTube

To bring in a remote playlist:

1. Go to [Downloads](downloads.md) (`/download`).
2. Paste the **playlist** URL (not a single video).
3. Wait for the entry list to load; select all or a subset.
4. Optionally set a **playlist name** (defaults apply if blank).
5. Choose a quality [preset](downloads.md#quality-presets) and import.

Horde:

- Creates a playlist marked as imported from YouTube (`source_type` youtube)
- Queues downloads for the selected entries into the FIFO download queue

The playlist detail page notes when a list was imported from YouTube.

!!! tip "Already have the files?"
    If videos are already in your library, prefer creating a local playlist and bulk-adding — no need to re-download via YouTube import.

## Play all

**Play all** loads playlist items into the player queue.

| Detail | Value |
|--------|--------|
| Storage | `sessionStorage` key `horde.queue` |
| Lifetime | Cleared when the browser tab/session ends |
| Advance | Next item plays when the current one ends |

See [Video player](player.md) for queue vs related autoplay (queue wins; related countdown only when the queue is empty).

## Managing a playlist

On a playlist detail page you can:

- Browse members in order
- Open any item in the [watch](watching.md) player
- Remove items you no longer want in the list
- See source hints for YouTube-imported lists

Deleting a playlist does not delete the underlying library videos (only the list membership), unless a separate delete-video action says otherwise.

## Related

- [Downloads](downloads.md) — YouTube playlist import and presets
- [Library](library.md) — select mode and bulk add
- [Video player](player.md) — `horde.queue`, shortcuts, modes
- [Watching](watching.md) — resume and related autoplay

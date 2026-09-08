# Playlists

Horde playlists group library videos for binge sessions, curated mixes, archived YouTube lists, and **subscribed** YouTube playlists that stay in sync as new parts appear.

## Create a playlist

1. Open **Playlists** (`/playlists`).
2. Enter a name in the create field and press Enter / create.
3. Click the new playlist row to expand it and manage items, or add videos from the library (below).

Empty local playlists are always created here — not on Download.

## Subscribe to a YouTube playlist

Use this for series that grow over time (for example “2026 PC Build Log” with later parts).

1. On **Playlists**, paste a YouTube playlist URL under **Subscribe to YouTube** and pick a max resolution (same presets as [Download](downloads.md)).
2. Horde creates a local playlist, downloads videos that are not already in your library, and attaches ones that are.
3. On a schedule (the metadata-sync worker tick, about hourly), Horde rescans the YouTube playlist, appends new entries, and keeps YouTube order.

You can also subscribe from the [Download](downloads.md) page when a playlist URL is detected.

Subscribed lists show a **Subscribed** tag under the source line. Expand a row to **Sync now**, **Stop subscribing** (the list stays), or turn a one-shot YouTube import into a subscription with **Subscribe to updates**.

Removed YouTube entries are **not** dropped from Horde. Video files are never deleted by playlist sync. Existing library files are not re-downloaded; titles and views still follow [metadata sync](../settings/library.md).

## Add videos from the library

Bulk-add is the fastest path for large sets:

1. Open the [Library](library.md).
2. Click **Select**.
3. Click cards to toggle; **Shift**-click to select a **range**.
4. Open **Add to playlist** in the bulk bar and choose the target list.

You can also add a single video from **Recent downloads** on the [Download](downloads.md) page (**+ Playlist**), or from individual video edit / detail flows where the UI exposes playlist membership.

## Import from YouTube

To bring in a remote playlist **once** (no ongoing sync):

1. Go to [Downloads](downloads.md) (`/download`).
2. Paste the **playlist** URL.
3. Choose **Import playlist**.
4. Select all or a subset, optionally set a name, pick a quality preset, and import.

Horde:

- Creates a playlist marked as imported from YouTube (`source_type` youtube, not subscribed)
- Queues downloads for the selected entries (skips YouTube ids already in the library)

Use **Subscribe** on that same page if you want future videos as well.

!!! tip "Already have the files?"
    If videos are already in your library, prefer creating a local playlist and bulk-adding — or subscribe/import anyway; Horde will attach matching YouTube ids without re-downloading.

## Play all

**Play all** loads playlist items into the player queue.

| Detail | Value |
|--------|--------|
| Storage | `sessionStorage` key `horde.queue` |
| Lifetime | Cleared when the browser tab/session ends |
| Advance | Next item plays when the current one ends |

See [Video player](player.md) for queue vs related autoplay (queue wins; related countdown only when the queue is empty).

## Managing a playlist

Click a playlist row on `/playlists` to expand it (or open `/playlists?open=<id>`). From there you can:

- Browse members in order (drag the grip on the left to reorder)
- Open any item in the [watch](watching.md) player
- Remove items you no longer want in the list
- The pencil beside the expand chevron turns the playlist title into an input and shows cover options (first video by default, any member's thumbnail, or an uploaded image). Uploads open a 16:9 editor so you can zoom, rotate, and position the crop before saving.
- See source hints for YouTube-imported and subscribed lists
- Sync or stop a YouTube subscription

Drag the grip on the far left of a playlist row to change the order of lists.

Deleting a playlist does not delete the underlying library videos (only the list membership), unless a separate delete-video action says otherwise.

## Related

- [Downloads](downloads.md) — YouTube playlist import, subscribe, and presets
- [Library](library.md) — select mode and bulk add
- [Video player](player.md) — `horde.queue`, shortcuts, modes
- [Watching](watching.md) — resume and related autoplay

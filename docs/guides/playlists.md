# Playlists

Horde playlists group library videos for binge sessions, curated mixes, archived YouTube lists, and **subscribed** YouTube playlists that stay in sync as new parts appear.

## Create a playlist

1. Open **Playlists** (`/playlists`).
2. Enter a name in the create field and press Enter / create.
3. Click the new playlist row to expand it and manage items, or add videos from the library (below).

Empty local playlists are always created here — not on Download.

## Who can see a playlist

Every playlist is **App-wide** or **Private**, and the create form has a switch for it (it applies to new playlists and to YouTube subscriptions made on this page).

| | App-wide | Private |
|---|---|---|
| Seen by | Everyone who signs in | Only you. Nobody else, administrators included, can see it or tell it exists |
| Created by | Members with the **Manage playlists** permission (administrators always) | Any account |
| Edited and deleted by | Its owner, and anyone with **Manage playlists** | Its owner |

New playlists start as App-wide for accounts that may share and Private for the rest. The owner can switch a playlist with the pencil (**Edit playlist**) at any time; making a Private playlist App-wide needs **Manage playlists**. Other people's App-wide playlists show "by <name>" and, without **Manage playlists**, can be opened and played but not changed. When you have your own playlists and shared ones from others, the page lists them under **Your playlists** and **Shared with everyone**; each list is dragged into order on its own.

The **+ Playlist** menus (on the watch page, the Download page and the library's bulk bar) offer only the playlists you can add to. Choosing a playlist you cannot change as the target of a download is refused. If an account is deleted, its Private playlists are deleted with it and its App-wide ones go to the administrator who deleted it. Playlists that existed before accounts could own them belong to the first administrator and stay App-wide.

## Subscribe to a YouTube playlist

Use this for series that grow over time (for example “2026 PC Build Log” with later parts).

1. On **Playlists**, paste a YouTube playlist URL under **Subscribe to YouTube** and pick a max resolution (same presets as [Download](downloads.md)).
2. Horde creates a local playlist, downloads videos that are not already in your library, and attaches ones that are.
3. On a schedule (the metadata-sync worker tick, about hourly), Horde rescans the YouTube playlist, appends new entries, and keeps YouTube order.

You can also subscribe from the [Download](downloads.md) page when a playlist URL is detected.

Subscribing, and **Sync now**, download videos, so they need the **Download** permission even on a playlist you own. Subscribed lists show a **Subscribed** tag under the source line. Expand a row to **Sync now**, **Stop subscribing** (the list stays), or turn a one-shot YouTube import into a subscription with **Subscribe to updates**.

Removed YouTube entries are **not** dropped from Horde. Video files are never deleted by playlist sync. Existing library files are not re-downloaded; titles and views still follow [metadata sync](../settings/library.md).

## Add videos from the library

Expand a playlist and click **Add Video**. The field searches downloaded titles and channels as you type; pick a result to append it. You can also paste a video URL: if it is already in the library it is added as is, otherwise it joins the playlist **without downloading** (see below). On a streamed video's watch page, **+ Playlist** beside the download button does the same.

## Downloaded and streamed videos

A playlist can mix videos on the server with videos that are only streamed. Streamed ones are marked **Not downloaded**, play through the stream preview like any other not-downloaded video, and keep their place, title and channel.

- **Download** on a streamed row, or **Download all (N)** at the top, downloads them to the server (needs the **Download** permission and edit rights on the playlist). Each one stays where it is in the list and plays from the server once it finishes.
- **Remove from server** deletes the playlist's downloaded videos from the server (needs **Delete videos**) and keeps them in the playlist as streamed entries, so the list stays useful for reference and you get the space back. Videos that are also in another playlist (anyone's) stay downloaded; the confirmation says how many and how much space is freed. With the trash on, they go to the trash first and **Undo** brings them back in place.
- Deleting a video anywhere else works the same way: its playlist entries stay as streamed ones when it came from a link, and are dropped when it was a local file with nothing to stream from.

Bulk-add is still the fastest path for large sets:

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
- Queues a normal download job for each selected entry that is not already in the library (they respect the queue's concurrency and pause, survive a restart, and join the playlist in YouTube order as they finish)

Use **Subscribe** on that same page if you want future videos as well.

!!! tip "Already have the files?"
    If videos are already in your library, prefer creating a local playlist and bulk-adding — or subscribe/import anyway; Horde will attach matching YouTube ids without re-downloading.

## Play all

**Play all** loads playlist items into the player queue, streamed ones included.

| Detail | Value |
|--------|--------|
| Storage | `sessionStorage` key `horde.queue` |
| Lifetime | Cleared when the browser tab/session ends |
| Advance | Next item plays when the current one ends |

See [Video player](player.md) for queue vs related autoplay (queue wins; related countdown only when the queue is empty).

## Managing a playlist

Click a playlist row on `/playlists` to expand it (or open `/playlists?open=<id>`). From there you can:

- Browse members in order (drag the grip on the left to reorder)
- Add videos with **Add Video** (library search, or a link to add without downloading)
- **Download all** or **Remove from server** (see [Downloaded and streamed videos](#downloaded-and-streamed-videos))
- Open any item in the [watch](watching.md) player
- Remove items you no longer want in the list
- The pencil beside the expand chevron turns the playlist title into an input and shows cover options (first video by default, any member's thumbnail, or an uploaded image). Uploads open a 16:9 editor so you can zoom, rotate, and position the crop before saving.
- See source hints for YouTube-imported and subscribed lists
- Sync or stop a YouTube subscription
- Choose who can see it (its owner only)

Drag the grip on the far left of a playlist row to change the order of lists.

Deleting a playlist does not delete the underlying library videos (only the list membership), unless a separate delete-video action says otherwise.

## Related

- [Downloads](downloads.md) — YouTube playlist import, subscribe, and presets
- [Library](library.md) — select mode and bulk add
- [Video player](player.md) — `horde.queue`, shortcuts, modes
- [Watching](watching.md) — resume and related autoplay

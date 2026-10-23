# Library

The Library is Horde’s home screen: a video grid (or channel feed), channel sidebar, search, tags, sorting, and bulk actions. Open `/` or click **Library** in the nav.

## Layout

| Region | What it does |
|--------|----------------|
| **Channel sidebar** | Filter by channel; search local + remote channels |
| **Main grid** | Your library videos (home) or a channel feed |
| **Toolbar** | Sort, select mode, layout toggles (search is in the nav bar, on every page; see [Search](search.md)) |
| **Continue watching** | Row of in-progress videos (home only) |
| **Home tabs** | **Library** / **Recommended** when AI is ready |

On a channel page, the main area switches to that channel’s feed (downloaded videos, and optionally undownloaded catalog entries). See [Channels](channels.md).

## Sorting

Use the sort control in the toolbar. Options:

| Label | Field |
|-------|--------|
| Recently added | `added_at` |
| Publish date | `published_at` |
| Title | `title` |
| Duration | `duration` |
| File size | `file_size` |
| View count | `view_count` |
| Random | seeded shuffle |

Toggle ascending/descending with the arrow button. For **Random**, that button reshuffles (new seed).

### Session persistence

Your current sort (and random seed) is stored in `localStorage` for **3 hours**. After that, Horde falls back to the default sort from [Settings → Library](../settings/library.md).

!!! tip "Default vs temporary"
    Settings define the long-term default. Changing the toolbar sort only overrides it for the current session window (3h TTL).

## Tags

Tag chips appear above the grid when tags exist with **count &gt; 3** (or the currently active tag). Click a chip to filter; click again to clear.

Tags can come from downloads, manual edits, or [AI enrich](ai-features.md).

## Select mode

Click **Select** in the toolbar to enter multi-select:

1. Click cards to toggle selection.
2. Hold **Shift** and click to select a **range** between the last selected index and the current one.
3. Use the bulk bar at the bottom for actions on the selection.

### Bulk actions

| Action | Effect |
|--------|--------|
| **Add to playlist** | Append selected videos to a playlist |
| **Notes** | Apply the same note text to all selected |
| **Resync** | Refresh metadata (titles, thumbnails, captions, etc.) |
| **Download** | Queue undownloaded / catalog items for download |
| **Delete** | Remove selected videos from the library and move their files to the [trash](#trash) |

Exit with **Cancel** or by leaving select mode.

## Trash { #trash }

Deleting a video does not erase it at once. The video disappears from the library, search, playlists and history, and its files move into a **trash** where it stays for **7 days** (`HORDE_TRASH_DAYS`, see [Environment variables](../ops/environment.md)). After that Horde erases it for good. Until then you can:

- **Restore** it: the video comes back under the same id with its tags, summary, chapters, playlist places, everyone's watch progress and AI chats, and its files return to their old folder.
- **Delete forever** or **Empty trash** to free the disk space now.

The trash lists each video with its size, who deleted it and when it will be erased, and shows the total size. Anyone who may delete videos (the `delete_videos` permission, and administrators) can see and use it.

Things to know:

- **Trashed videos still use disk.** They count toward the [library size limit](../settings/system.md), and emptying the trash frees that space (held downloads then start).
- **A restore can be refused** (409 `trash_conflict`) when its original file path is taken or the same YouTube video was downloaded again in the meantime. Delete the newer copy first, or erase the trashed one.
- **Auto-download skips trashed videos**, so a channel with auto-download does not fetch a video you just deleted.
- Choosing to **keep the file** when removing a video from the library has nothing to trash; the video is only dropped from the library, as before.
- `HORDE_TRASH_DAYS=0` turns the trash off: deletes are immediate and permanent. Anything already in the trash is erased the next time the hourly purge runs.
- Videos Horde removes by itself stay permanent: a library entry whose file vanished from disk, a re-download replacing the old copy, a [factory reset](../settings/system.md) that erases media (it also empties the trash), and deleting an account.

For API clients: the `204` of `DELETE /api/videos/{id}?delete_file=true` and of `POST /api/videos/bulk-delete` carries the entry id in the `X-Horde-Trash-Entry` (bulk: `X-Horde-Trash-Entries`, comma separated) header, which `POST /api/trash/{id}/restore` takes. See [Trash design](../adr/0013-trash-tombstones.md).

## Continue watching

On the home Library tab (not Recommended, not a channel page), Horde shows a **Continue watching** row for videos with meaningful in-progress playback. Resuming opens the [watch page](watching.md) at the saved position.

!!! note "Window vs expiry"
    The continue-watching list uses a fixed backend window of **7 days** (not user-configurable). Separate from that, [progress expiry](history.md) (`progress_expiry_days`, default **14**) clears stale `last_position_sec` values.

## Library vs Recommended

When AI providers are ready and recommendation categories exist, the home page shows two tabs:

- **Library** — your normal grid, tags, continue watching, and search results.
- **Recommended** — category shelves of suggestions based on embeddings and watch history, in recommendation order (no sort control).

See [AI features](ai-features.md) for setup and what powers Recommended.

## Channel sidebar

The left sidebar lists channels from your library. Sort order is controlled in [Settings → Library](../settings/library.md) (recent download, video count, alphabetical, subscriber count). Searching the sidebar also discovers remote YouTube channels when the query is long enough — details in [Channels](channels.md).

## Search from the library

The search box on the library **home** page searches your collection (and streamable catalog hits) as you type. **YT** inside the box (also in [Settings → Library](../settings/library.md)) turns live YouTube results on or off after you pause typing, or immediately on Enter. Each result section can be collapsed; **Load more** at the bottom of **On YouTube** fetches another page. On a **channel page**, the header searches that channel’s indexed uploads and downloads instead; **YT** in that box queries YouTube for that channel only. Full behavior is documented in [Search](search.md).

## Related settings

- [Library settings](../settings/library.md) — default sort, channel sidebar sort, catalog max videos, show undownloaded
- [Playback settings](../settings/playback.md) — related videos, autoplay, channel feed options
- [Appearance](../settings/appearance.md) — card density and UI chrome

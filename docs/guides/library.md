# Library

The Library is Horde’s home screen: a video grid (or channel feed), channel sidebar, search, tags, sorting, and bulk actions. Open `/` or click **Library** in the nav.

## Layout

| Region | What it does |
|--------|----------------|
| **Channel sidebar** | Filter by channel; search local + remote channels |
| **Main grid** | Your library videos (home) or a channel feed |
| **Toolbar** | Search, sort, select mode, layout toggles |
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
| **Delete** | Remove selected videos from the library |

Exit with **Cancel** or by leaving select mode.

## Continue watching

On the home Library tab (not Recommended, not a channel page), Horde shows a **Continue watching** row for videos with meaningful in-progress playback. Resuming opens the [watch page](watching.md) at the saved position.

!!! note "Window vs expiry"
    The continue-watching list uses a fixed backend window of **7 days** (not user-configurable). Separate from that, [progress expiry](history.md) (`progress_expiry_days`, default **14**) clears stale `last_position_sec` values.

## Library vs Recommended

When AI providers are ready and recommendation categories exist, the home page shows two tabs:

- **Library** — your normal grid, tags, continue watching, and search results.
- **Recommended** — category shelves of suggestions based on embeddings and watch history.

See [AI features](ai-features.md) for setup and what powers Recommended.

## Channel sidebar

The left sidebar lists channels from your library. Sort order is controlled in [Settings → Library](../settings/library.md) (recent download, video count, alphabetical, subscriber count). Searching the sidebar also discovers remote YouTube channels when the query is long enough — details in [Channels](channels.md).

## Search from the library

The search box on the library **home** page searches your collection (and streamable catalog hits). Results group into sections such as **In your library**, **Other videos**, and **Available to stream**. On a **channel page**, the header searches that channel’s indexed uploads and downloads instead. Full behavior is documented in [Search](search.md).

## Related settings

- [Library settings](../settings/library.md) — default sort, channel sidebar sort, catalog max videos, show undownloaded
- [Playback settings](../settings/playback.md) — related videos, autoplay, channel feed options
- [Appearance](../settings/appearance.md) — card density and UI chrome

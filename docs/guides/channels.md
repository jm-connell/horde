# Channels

Channels organize your library on disk and in the UI. Every approved video belongs to a channel; the sidebar and channel pages are how you browse by creator.

## Sidebar

On the [Library](library.md) page, the left sidebar lists channels from your collection.

### Sort order

Configure in [Settings → Library](../settings/library.md):

| Sort | Behavior |
|------|----------|
| **Recent download** | Channels with the newest downloads first (default) |
| **Video count** | Most library videos first |
| **Alphabetical** | A–Z by channel name |
| **Subscriber count** | Highest subscriber count first; channels without data sort last |

Ascending/descending follows the matching order preference in settings.

### Discovering channels

Type in the sidebar search:

- **Local matches** — channels already in your library
- **Remote YouTube discovery** — when the query is **≥ 2 characters**, Horde can search YouTube for channels you don’t have yet

Pick a remote result to open that channel’s page and start catalog work / downloads.

## Channel pages

Open a channel from the sidebar to see its **feed**:

- Videos already in your library for that channel
- Optionally **undownloaded** catalog entries (titles from the remote channel index)

### Header and channel settings

The header shows who the channel is (its `@handle`, how many of its videos are in your library and its subscriber count) and three actions:

- **Follow** / **Following** (YouTube channels): see [Following and live streams](#following-and-live-streams).
- **Download…** (YouTube channels, needs the `download` permission): opens the [Download](downloads.md) page with the channel's link filled in, so you can pick which of its videos to download.
- The gear, **Channel settings**: everything that sticks to this channel, in one panel (a side sheet on wide screens, a full-height sheet on phones). Its sections are **Automatic downloads**, **Clean up old videos**, **Live & following**, **Search** (whether searching this channel also asks YouTube) and **Manage** (rename the channel, build its search index).

Small chips under the name sum up what is active, for example **Auto-download on · 1080p**, **Keeps latest 20** or the search index state (**Not indexed**, **Fully indexed (1000)**). Click a chip to open the settings at that section. Sections you lack the permission for are shown read-only: automatic downloads need `download`, cleanup needs `delete_videos`, renaming and the YouTube search choice need `edit_metadata`.

Above the feed, one toolbar holds the quick view controls: the channel search box, **Videos** / **Live**, **Recent** / **Popular** with the ↑/↓ direction, the **Undownloaded** switch, grid or list layout and **Tags**.

### Feed search

The channel header search box looks across **indexed uploads** (titles, and descriptions for the newest ~200) and **downloaded videos** for that channel.

- Multi-word queries require **all keywords** as whole words (stopwords like *the* / *to* / *his* are ignored). `paint fix` matches *I painted his House to Fix his WiFi*; `car` does not match *graphics card*. Home library search uses the same matcher.
- Natural-language phrasing also uses catalog and library search indexes when those embeddings are ready (including captions on downloads).
- While a query runs, the feed shows **Searching indexed catalog…** then **Finding related matches…**. If indexing is still in progress, results may be incomplete.
- With the **YT** control in the channel search box on (default from Settings → Library **Direct YouTube search**; **Channel settings → Search** sets it per channel or back to the server default), Horde also queries YouTube for extra matches from that channel. Local and YouTube cards are then sorted together by **Recent / Popular** (and the ↑/↓ direction) at the top of the page. A quiet **Loading YouTube results…** line appears until that call finishes.

See [Search](search.md).

### Show undownloaded

Toggle **Undownloaded** in the channel page toolbar (also available under [Playback / Library settings](../settings/playback.md) as `showUndownloadedOnChannel`). When on, catalog-only uploads appear so you can download or preview them without leaving the feed. Cards show views when Horde has them. Publish time is a calendar day only when yt-dlp has a real upload date; otherwise the card keeps YouTube’s wording (`3 years ago`) or a year (`2013`) — Horde does not invent a month and day from that.

### Feed layout

Switch between **grid** and **list** layouts for the channel feed. The preference is stored in the browser.

### Channel download panel

From a channel page you can open the download panel to queue undownloaded items (quality preset, selection, etc.), similar in spirit to the [Downloads](downloads.md) page but scoped to that channel’s feed. The floating card stays in the bottom-right (or above the mini player when one is open) as the window resizes. Queued items count down a few seconds so you can edit or cancel; leaving the page (for example opening Downloads) **confirms** anything still counting down instead of dropping it. The panel’s **Best available** default still fetches the highest source tier; once the job is in the download queue it is labeled with that actual resolution (for example 4K), which you can change mid-download.

### Autodownload

On a YouTube channel, **Channel settings → Automatic downloads** turns automatic library downloads on or off for that channel: switch on **Download new uploads automatically**, choose the options and **Save automatic downloads**.

| Setting | Behavior |
|---------|----------|
| **Older videos: None, only new uploads** | New uploads discovered after you enable autodownload |
| **Older videos: The latest N** | Also queue the newest **N** indexed uploads that are not already in the library (N is 1–500) |
| **Older videos: All indexed videos** | Queue every indexed upload still missing from the library, then keep downloading new ones |
| **Resolution** | Quality preset used for autodownloaded jobs (default **1080p**) |
| **Include finished livestreams** | Off by default. Livestreams are **never** downloaded while live or upcoming. When on, finished stream recordings are included |

The section always warns that this can use a lot of storage. **All indexed videos** is limited by the [catalog max videos](#max-videos-per-channel) cap (default 1000) and says so.

While autodownload is on, the header shows an **Auto-download on · 1080p** chip that opens this section. Switching it off and saving does **not** cancel jobs already in the download queue.

Horde finds new uploads from the channel catalog (opening the feed, periodic catalog refresh, and a dedicated autodownload poll every 15 minutes). YouTube Shorts are not autodownloaded.

## Cleaning up old videos { #retention }

News and daily channels pile up. A channel can have a **retention rule** that moves its old videos to the [trash](library.md#trash) on its own, so a removal can be undone for 7 days (`HORDE_TRASH_DAYS`). Use any mix of three limits:

| Limit | What it removes |
|-------|-----------------|
| **Keep the newest N** | Everything but the newest N videos of the channel (by publish date; a video without one, such as a local import, counts as published when it was added) |
| **Older than D days** | Videos added to Horde more than D days ago |
| **Finished more than D days ago** | Videos someone watched to the end more than D days ago, on any account, provided nobody has watched it since |

A video that matches any limit goes. Whatever the limits say, these **stay**:

- videos in any playlist;
- videos with notes;
- videos someone is partway through right now (watched in the last 7 days, not finished);
- videos added in the last 24 hours;
- videos you restored from the trash (they are never taken again, even if the rule would match).

Set a rule under **Channel settings → Clean up old videos**: tick the limits you want, enter the numbers, switch on **Clean up this channel automatically** and **Save cleanup rule**. The exceptions are listed in small print under the limits. Before you save, a line under the limits says how much the rule would remove and updates as you type ("Right now this would move 12 videos (4.3 GB) to the trash.") and how many videos the exceptions keep. A channel with an enabled rule shows a chip such as **Keeps latest 20** in its header. A saved, enabled rule runs at once and then about every hour. Each removal shows in **Settings → Library → Trash** with the reason ("Retention: keep latest 20"), no name under "deleted by", and **Restore**. Retention does not free disk by itself: the trash still counts toward the [library size limit](../settings/system.md) until it is erased.

A removed video is not downloaded again by [autodownload](#autodownload), just like a video you delete by hand. The rule follows the channel when you rename it (if the new name already has a rule, that one stays). Renaming onto a name that already has videos merges two channels, so the rules involved are **turned off** instead of applying to videos they were not written for; review and switch them on again. With `HORDE_TRASH_DAYS=0` no rule removes anything, because an unattended permanent delete is never the fallback.

Watched videos count from the update that introduced retention: the date a video was finished was not recorded before, so earlier views do not make a video removable. Only playing a video to its end counts as finishing it: opening it, seeking back to the start or leaving at 90 % does not.

Anyone may see a channel's rule; saving one needs the `delete_videos` permission. The API is `GET` / `PUT /api/channels/retention` and `POST /api/channels/retention/preview`.

## Following and live streams

Follow a channel to see when it is live. You follow a channel automatically when a download you queued from it finishes, and an administrator starts out following every channel in the library. To follow a channel by hand, even one with no videos on the server, use **Follow** in the channel's header (or **Channel settings → Live & following**), or add its URL or `@handle` under **Settings → Library → Followed channels**. Unfollowing sticks: a later download from that channel does not follow it again.

A YouTube channel's page has two tabs. **Videos** lists its uploads. **Live** lists its live streams, newest first: past broadcasts are ordinary videos you can watch or download, and the **Filter streams** box filters the loaded list by title. When the channel is live right now, its broadcast is the first card on either tab, with a red **LIVE** badge and **Live now** in place of the download button.

Downloading a past livestream longer than two hours asks first, because a recording that long can take a while and use a lot of storage (the watch page shows the estimated size at the chosen quality). **Download anyway** queues it as usual.

When followed channels are live, a small **Live** list appears at the top of the sidebar, with each channel, the stream title, the game and the viewer count. It is not there when nobody is live. Click a stream to watch it. The seek bar covers the stream so far, up to the last 4 hours by default, so you can scrub back. The **LIVE** readout shows how far behind you are; click it to jump back to live. Turn the list off with **Settings → Library → Show live streams**. How it works: [Live streams](../design/live-streams.md).

## Catalog indexing

Catalog indexing is **YouTube only**. When you open a YouTube channel feed or download from a YouTube channel, Horde indexes that channel’s uploads in the background so feed search and “Available to stream” work without paging YouTube live every time. Non-YouTube sources skip catalog indexing.

Progress shows as a chip in the channel header (for example **Fully indexed (1000)**) and under **Channel settings → Manage → Search index**. **Index channel** there appears only when this catalog is missing, incomplete, or failed — a complete catalog does not need a manual re-walk. Age-restricted, members-only, and private uploads are skipped so the rest of the channel can still index; the channel page shows a toast when that happens.

### Phases

Indexing runs in phases:

| Phase | What happens |
|-------|----------------|
| **flat** | Flat upload list (ids, titles, basic metadata) up to the max-videos cap |
| **descriptions** | Fetch descriptions for the newest uploads (used for richer search / chapters later) |
| **embed** | Queue catalog video embeddings when AI embed is available |

Progress appears in status UI / AI queue breakdown as catalog indexing jobs.

!!! warning "YouTube rate limits"
    Large catalogs and high concurrency can trigger bot checks. Prefer modest [max videos](#max-videos-per-channel) and low [`MAX_DOWNLOAD_CONCURRENCY`](../ops/environment.md) if you see access issues. See [YouTube access](../ops/youtube-access.md).

### Max videos per channel

| Setting | Range | Default |
|---------|-------|---------|
| `channel_catalog_max_videos` | **100–5000** | **1000** |

Set this under [Settings → Library](../settings/library.md). Values above 1000 take longer and can slow other YouTube work while indexing.

### Maintenance

[Settings → System](../settings/system.md) (and related library tools) can **refresh catalogs** (catch new channels / uploads) or **full reindex** (re-walk every channel). Details also appear in the catalog tips in the settings UI.

## Related

- [Library](library.md) — sidebar and home grid
- [Search](search.md) — “Available to stream” catalog hits
- [Downloads](downloads.md) — queueing quality presets
- [Watching](watching.md) — stream preview vs library playback
- [Storage layout](../ops/storage-layout.md) — channel/year on disk

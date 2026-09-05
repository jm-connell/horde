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

### Feed search

The channel header search box looks across **indexed uploads** (titles, and descriptions for the newest ~200) and **downloaded videos** for that channel.

- Multi-word queries require **all keywords** as whole words (stopwords like *the* / *to* / *his* are ignored). `paint fix` matches *I painted his House to Fix his WiFi*; `car` does not match *graphics card*. Home library search uses the same matcher.
- Natural-language phrasing also uses catalog and library search indexes when those embeddings are ready (including captions on downloads).
- While a query runs, the feed shows **Searching indexed catalog…** then **Finding related matches…**. If indexing is still in progress, results may be incomplete.
- With **Direct YouTube search** on (Settings → Library, or the per-channel toggle), Horde also queries YouTube for extra matches. Local and YouTube cards are then sorted together by **Recent / Popular** (and the ↑/↓ direction) at the top of the page. A quiet **Loading YouTube results…** line appears until that call finishes.

See [Search](search.md).

### Show undownloaded

Toggle **Show undownloaded** on the channel page (also available under [Playback / Library settings](../settings/playback.md) as `showUndownloadedOnChannel`). When on, catalog-only uploads appear so you can download or preview them without leaving the feed. Cards show views when Horde has them. Publish time is a calendar day only when yt-dlp has a real upload date; otherwise the card keeps YouTube’s wording (`3 years ago`) or a year (`2013`) — Horde does not invent a month and day from that.

### Feed layout

Switch between **grid** and **list** layouts for the channel feed. The preference is stored in the browser.

### Channel download panel

From a channel page you can open the download panel to queue undownloaded items (quality preset, selection, etc.), similar in spirit to the [Downloads](downloads.md) page but scoped to that channel’s feed. Queued items count down a few seconds so you can edit or cancel; leaving the page (for example opening Downloads) **confirms** anything still counting down instead of dropping it. The panel’s **Best available** default still fetches the highest source tier; once the job is in the download queue it is labeled with that actual resolution (for example 4K), which you can change mid-download.

## Catalog indexing

Catalog indexing is **YouTube only**. When you open a YouTube channel feed or download from a YouTube channel, Horde indexes that channel’s uploads in the background so feed search and “Available to stream” work without paging YouTube live every time. Non-YouTube sources skip catalog indexing.

Progress shows in the channel header (for example **Fully indexed**). **Index channel** appears only when this catalog is missing, incomplete, or failed — a complete catalog does not need a manual re-walk.

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

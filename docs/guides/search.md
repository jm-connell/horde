# Search

Horde uses a **single search box** on the Library home page, plus a separate **channel-page search** when a channel is open. There is no separate Search screen and no UI toggle for “semantic” vs “keyword” mode — hybrid ranking runs on the backend whenever AI search indexes are available.

## Where to search

Open the [Library](library.md) (`/`) and type in the search field in the toolbar (desktop) or the mobile search control. Library and catalog results update as you type (debounced). A compact **YouTube** toggle sits next to the home search box (and under [Settings → Library](../settings/library.md)). With it on, YouTube itself is queried after you pause typing (or immediately if you press Enter). Search text is sent to YouTube.

On a **channel page**, the box in the header searches that channel’s **indexed catalog** and **downloaded library videos**. When [Direct YouTube search](../settings/library.md) is on, it also queries YouTube for extra matches. Combined results follow the page’s **Recent / Popular** sort. That in-channel fallback is separate from home **YouTube video search**.

## Result sections

Matches are grouped into up to four sections. The first three always appear while you are searching (empty sections keep a short message). **On YouTube** appears once YouTube search is on, the query has settled, and Horde has live hits.

| Section | Meaning | Empty copy |
|---------|---------|------------|
| **In your library** | Videos already downloaded / approved into your library | No matching videos found in library |
| **Available to stream** | Undownloaded catalog hits from channels you’ve indexed or already downloaded from | No matching videos from indexed channels |
| **On YouTube** | Live YouTube video search (not limited to channels you already follow) | Hidden when empty |
| **Other videos in library** | Downloaded library videos that did not match the query | No other videos in library |

Each section heading has a **▼** control to collapse or expand that group. **On YouTube** includes **Load more** at the bottom of the grid when another page of live hits is available.

Catalog rows come from background [channel catalog indexing](channels.md). You can stream a preview or queue a download without leaving search. **On YouTube** cards use the same feed layout (thumbnail, duration, channel, date, views, Download). Click a channel name to open that creator in Horde. Changing the typed query hides live hits until the new query settles (or you press Enter).

While YouTube search is in flight, a quiet **Loading YouTube results…** line appears. Live hits are not written into channel catalogs; opening or downloading a result starts indexing as usual.

!!! tip "Empty catalog section"
    If **Available to stream** always shows the empty message, catalogs may still be indexing, disabled, or the channel hasn’t been opened/downloaded yet. See [Channels](channels.md) and [Library settings](../settings/library.md).

## Hybrid search (backend)

When embeddings are ready, the API runs **hybrid** search: keyword matching combined with embedding similarity. The UI does not expose a semantic-only switch; one query drives both.

Keyword matching splits the query into tokens (ignoring small stopwords) and requires **each** token to appear as a **whole word** in the metadata — so `paint fix` matches *I painted his House to Fix his WiFi*, not only the contiguous phrase `paint fix`, but `car` does not match *graphics card* or *carriers*. Light stemming still treats `paint` / `painted` / `painting` as the same token (short words only add a plural, so `car` can match `cars`). Library home search and channel-page search share this matcher. Keyword lookups (`hyprland`, `hyprland install guide`) stay keyword-only. Embeddings run only for sentence-like queries that still contain stopwords (`that episode about house wifi`). Without an embed provider / indexes, search falls back to this keyword-style matching.

### Channel page search

The channel header search:

1. Matches tokens against indexed titles and descriptions (SQL, fast).
2. Merges downloaded videos for that channel via the same library hybrid path (captions included when search indexes exist).
3. Then looks for **related** catalog embeddings so natural-language phrasing can surface uploads that don’t share the same words.
4. If Direct YouTube search is enabled for that channel, queries YouTube’s in-channel search and adds videos that are not already on screen. Empty dates/views on local cards are filled from those hits when known. Approximate YouTube ages (`3 years ago`) stay as that wording instead of a made-up calendar day; **Recent** sort still uses the approximate timestamp under the hood. The combined list is then sorted by **Recent** (publish date) or **Popular** (view count) using the controls at the top of the page. While that call is in flight, the feed shows a quiet **Loading YouTube results…** line.

Status copy shows **Searching indexed catalog…**, then **Finding related matches…** while embeddings run, plus a match count when local results settle. If the catalog is still indexing, the feed notes that results may be incomplete.

When a hit is **not** obvious from the title, a **?** appears on the thumbnail. Hover (or tap) the **?** for a short explanation: a description/tags/notes snippet, a caption quote on downloaded videos, “related by search index,” or “Found on YouTube” for Direct YouTube search extras.

### What gets indexed

Search indexes are built from video metadata (title, channel, description, tags, notes) and, optionally, **subtitle/caption text**.

Control that in [Settings → AI](../settings/ai.md):

| Setting | Effect |
|---------|--------|
| **Use subtitles in search indexes** (`use_subtitles`) | Include caption text when building embeddings and related corpora |

!!! note "Rebuild after changes"
    Changing the embedding model or subtitle inclusion means re-indexing so semantic search, related videos, and category shelves stay consistent. Horde prompts when the embed model changes.

## Filters while searching

Search works together with library filters:

- Active **channel** (sidebar)
- Active **tag** chip
- Current **sort** for library result ordering where applicable

Clear the search box to return to the normal library or channel feed.

## Related

- [Library](library.md) — home grid and tags
- [Channels](channels.md) — catalog indexing that powers “Available to stream”
- [AI features](ai-features.md) — embeddings, Recommended, related videos
- [AI setup](../ops/ai-setup.md) — providers and models
- [AI settings](../settings/ai.md) — `use_subtitles` and feature toggles

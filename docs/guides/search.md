# Search

Horde uses a **single search box** on the Library home page, plus a separate **channel-page search** when a channel is open. There is no separate Search screen and no UI toggle for “semantic” vs “keyword” mode — hybrid ranking runs on the backend whenever AI search indexes are available.

## Where to search

Open the [Library](library.md) (`/`) and type in the search field in the toolbar (desktop) or the mobile search control. Results update as you type (debounced).

On a **channel page**, the box in the header searches that channel’s **indexed catalog** and **downloaded library videos** (not a live YouTube video search).

## Result sections

Matches are grouped into up to three sections:

| Section | Meaning |
|---------|---------|
| **In your library** | Videos already downloaded / approved into your library |
| **Other videos** | Related library hits that don’t fit the primary library grouping (e.g. secondary matches) |
| **Available to stream** | Channel **catalog** entries — indexed remote uploads you can preview or download |

Catalog rows come from background [channel catalog indexing](channels.md). You can stream a preview or queue a download without leaving search.

!!! tip "Empty catalog section"
    If **Available to stream** never appears, catalogs may still be indexing, disabled, or the channel hasn’t been opened/downloaded yet. See [Channels](channels.md) and [Library settings](../settings/library.md).

## Hybrid search (backend)

When embeddings are ready, the API runs **hybrid** search: keyword matching combined with embedding similarity. The UI does not expose a semantic-only switch; one query drives both.

Keyword matching splits the query into tokens (ignoring small stopwords) and requires **each** token to appear as a **whole word** in the metadata — so `paint fix` matches *I painted his House to Fix his WiFi*, not only the contiguous phrase `paint fix`, but `car` does not match *graphics card* or *carriers*. Light stemming still treats `paint` / `painted` / `painting` as the same token (short words only add a plural, so `car` can match `cars`). Library home search and channel-page search share this matcher. Queries whose longest token is under 4 letters stay keyword-only (embeddings for `car` / `gpu` are too vague). Without an embed provider / indexes, search falls back to this keyword-style matching.

### Channel page search

The channel header search:

1. Matches tokens against indexed titles and descriptions (SQL, fast).
2. Merges downloaded videos for that channel via the same library hybrid path (captions included when search indexes exist).
3. Then looks for **related** catalog embeddings so natural-language phrasing can surface uploads that don’t share the same words.

Status copy shows **Searching indexed catalog…**, then **Finding related matches…** while embeddings run, plus a match count when results settle. If the catalog is still indexing, the feed notes that results may be incomplete.

When a hit is **not** obvious from the title, a **?** appears on the thumbnail. Hover (or tap) the **?** for a short explanation: a description/tags/notes snippet, a caption quote on downloaded videos, or “related by search index.” Undownloaded catalog rows cannot cite captions (indexes are title + description only). This shows on **library search cards** and **channel-page search** (not on title-only matches).

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

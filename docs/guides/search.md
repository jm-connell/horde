# Search

Horde uses a **single search box** on the Library page. There is no separate Search screen and no UI toggle for “semantic” vs “keyword” mode — hybrid ranking runs on the backend whenever AI search indexes are available.

## Where to search

Open the [Library](library.md) (`/`) and type in the search field in the toolbar (desktop) or the mobile search control. Results update as you type (debounced).

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

Without an embed provider / indexes, search falls back to keyword-style matching over library metadata.

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

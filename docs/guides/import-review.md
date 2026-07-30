# Import & review

Import is how local files enter the library without a YouTube download: drag-and-drop upload, or files dropped into the media tree by a scanner.

## Routes

| Path | Behavior |
|------|----------|
| `/import` | Import & review UI |
| `/review` | **Redirects** to `/import` (legacy URL) |

## Adding files

### Upload

On `/import`, drop or choose files. Accepted extensions:

- `.mp4`
- `.mkv`
- `.webm`

Unsupported types are rejected with a toast.

### Scanner drops

Files that appear under the configured media/import paths (watchdog + poll scanner) are picked up automatically and appear in the same review queue. Active download outputs are ignored so the downloader and scanner don’t fight over the same path. See [Storage layout](../ops/storage-layout.md) and [Review queue design](../design/review-queue.md).

## Review queue

Each pending item needs metadata before it becomes a first-class library video.

### Approve

**Save & approve** requires a **channel** (and typically a title). Without a channel, the item stays in review — Horde’s library model is channel-centric ([channel/year layout](../design/channel-year-layout.md)).

### Skip

**Skip** keeps the file associated with the library flow **without** assigning a channel (use when you want to park an item). Prefer approve with a real channel for normal browsing.

### Delete

Delete removes the review item and can delete the file on disk (confirm in the UI).

## Duplicate groups

Horde groups **possible duplicates** (same or near-same content / ids / heuristics) on the Import page.

| Action | Notes |
|--------|--------|
| Review group | Compare paths, channels, titles |
| Keep / delete | Remove extras from disk + DB |
| **AI duplicate confirmation** | Optional — scores borderline pairs when AI is enabled |

Enable **AI duplicate confirmation** under [Settings → AI](../settings/ai.md) (`ai_duplicates`). Scoring runs **on demand from the Import API**, not as a reliable background batch.

!!! warning "`score_duplicates` job kind"
    The AI worker job kind `score_duplicates` is a **placeholder no-op**. Real duplicate scoring is invoked on-demand from the Import/review API when you use AI confirmation. Do not expect the background queue counter for `score_duplicates` to process work.

## After approval

Approved videos show up in the [Library](library.md), participate in [Search](search.md), and can be added to [Playlists](playlists.md). Optional AI jobs (embed, enrich tags, summary) may enqueue depending on [AI settings](../settings/ai.md).

## Related

- [Downloads](downloads.md) — URL-based ingestion
- [Library](library.md) — browsing approved videos
- [AI features](ai-features.md) — duplicate confirmation
- [Review queue](../design/review-queue.md) — why review exists
- [Storage layout](../ops/storage-layout.md)

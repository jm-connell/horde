# Review queue

Files that appear on disk without a full download metadata pass — dropped over SMB, uploaded in the UI, or otherwise discovered by the scanner — enter a **review** state (`needs_review=True`) instead of pretending they already belong in the library grid.

## Why review exists

Horde’s library and disk tree are organized primarily by **channel** (see [Channel / year layout](channel-year-layout.md)). A raw dump of `something.mkv` in `/downloads` has:

- No reliable channel folder
- No upload year
- Often a useless or wrong title (filename stem)
- No tags, description, or source URL

If those files were listed as normal library items immediately, the channel sidebar, sorting, SMB tree, and AI index would fill with junk that is hard to clean up later. Review is the deliberate pause: **ingest the bytes, then require a human to place them.**

## What clears review

Editing a review item and saving with both a **title** and a **channel** clears `needs_review`. For manual imports, Horde also renames the file into `Channel/Title.ext` when those fields change.

You can **skip** review without a channel: the file stays playable and leaves the review list, keeping a filename-derived title. That is an escape hatch for one-offs; it is a weaker archive story than assigning a channel.

!!! tip "Channel is the organizing key"
    Prefer assigning a real channel (even a personal bucket like `Imports` or `Music Videos`) so the sidebar and disk tree stay useful.

## How files get into review

| Path | Behavior |
|------|----------|
| **Folder scanner** | Watchdog + poll interval discovers new `.mp4` / `.mkv` / `.webm` (and configured extensions) under downloads |
| **Upload** | Streams into `imports/…` and creates a review row |
| **Active downloads** | Intermediate yt-dlp fragments are ignored so partial files never become review items |

Completed yt-dlp jobs normally insert library rows with metadata already filled and `needs_review=False`.

## Duplicates

The review / library area can surface heuristic duplicate groups (same YouTube id in path/URL, or same channel + similar title + close duration). Optional AI can score borderline cases. Review is a natural place to catch “I dropped this twice” before tags and embeddings proliferate.

## Operator guide

Day-to-day steps: [Import & review](../guides/import-review.md).

## Related design

- [Channel / year layout](channel-year-layout.md)
- [Why Horde](why-horde.md) — archive-first organization
- [Single-flight AI](single-flight-ai.md) — review items are skipped by most AI jobs until cleared

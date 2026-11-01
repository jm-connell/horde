# 0025. History shows every watch, and each can be removed or kept out of recommendations

Status: Accepted (amends [0020](0020-youtube-history-from-takeout.md))

## Context

[ADR 0020](0020-youtube-history-from-takeout.md) kept imported YouTube views out of History and Continue watching so those stayed "what you watched in Horde". Streamed videos were missing from History as well. Recommendations read all three (library, streamed, imported), so users could not see, or correct, what shaped them: a one-off, a video a guest watched, an old import. The only correction was forgetting the whole import.

## Decision

- **One timeline.** `GET /api/history/watches` lists library watches, streamed watches and imported views as one list, one entry per video at its latest watch, keyed like recommendations (`services/watch_history.py`). The three tables stay separate; only the listing merges them.
- **Remove means gone.** Removing an entry deletes every record of that video for the user (resume position, streamed watch, every imported view), so it counts as unwatched. Watch time (`user_watch_time`) stays: it is a record of time spent, and it already outlives deleted videos.
- **Excluding is a separate, reversible choice.** "Don't use for recommendations" keeps the entry, still counted as watched, but drops it from the taste every shelf reads (Recommended+, its gatherer, For you). It is stored as `rec_feedback` kind `taste` and is not listed with hidden channels.
- **Continue watching may show YouTube views.** Takeout has no progress, so any view in the Continue watching window counts, at most five, after the library's own picks and never for a downloaded video.

## Consequences

- An imported view no longer sits apart in the UI; the rest of 0020 (Takeout as the source, separate storage, what reads it) stands.
- Removal is permanent; the UI asks first. Excluding is undone from the same menu.
- The listing pages by offset over a `UNION ALL` of the three tables grouped by key; a watch recorded while paging can shift a later page by one.

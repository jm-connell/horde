# 0023. Saved comments: the top threads per video, fetched slowly, read live past that

Status: Accepted

## Context

YouTube comments carry what a video's own text does not: corrections and links the creator pins, the questions viewers ask, and how a video was received. They are useful to search and to the video chat, and an archive loses them when a video goes private. A video can have hundreds of thousands of comments. YouTube serves them about 20 at a time, each reply thread behind a request of its own, and yt-dlp cannot continue a listing where an earlier call stopped (it exposes no continuation token).

## Decision

- **Save a fixed slice per library video.** The top 100 top-level comments in YouTube's "top" order, and replies to the highest-ranked threads: yt-dlp's `max_comments` caps replies per thread (10) and across all threads (100), and threads are read in rank order, so the reply budget goes to the most popular discussions and lower threads cost no request. Rows in `video_comments` (with `parent_comment_id`), an external-content FTS5 index kept by triggers, and `video_comment_state` for the outcome and the next attempt (revision `0023_video_comments`). A refetch replaces the rows; a later "disabled" or "unavailable" keeps what was saved.
- **One background fetcher.** `services/comments/worker.py` fetches one video per pass: one without saved comments (newest added first; a finished download wakes it), else a due retry or the one-week refresh of a new upload. Each fetch is one unprocessed extract (`process=False`, no manifests) plus the comment pages, inside the extract gate at background priority, at most one every 30 s; a rate limit or bot check pauses it for an hour. `save_comments` turns it off.
- **Read live past the slice, never save it.** `GET /api/comments/youtube/{id}?limit=` reads the top 100, 300 or 1000 from the start at interactive priority, keeps the result in memory for 30 minutes (`CommentsRuntime` on the `AppContext`), and is how a streamed video gets comments. The responses are whole objects (`items` plus `next_limit`), not cursor pages: there is no cursor to give.
- **Search and chat use them as a weaker signal.** Library search appends videos found only through a comment (every query word in one comment) after the metadata and semantic hits, with a `comments` match reason. The video chat gets about 3,000 characters of top comments and the creator's replies, labelled as viewers'.

## Consequences

- About 30–60 KB of database per video, multiplied by the backups; a large library takes about a day to fill in once, at one fetch per 30 s.
- Each fetch is a full page extract plus about 15 comment requests, all at background priority behind downloads and previews.
- Replies to threads outside the top ones, and comments past the first 1000, are only on YouTube.
- Comment dates are approximate ("3 years ago"), as YouTube gives them.

Detail: [Comments](../guides/comments.md).

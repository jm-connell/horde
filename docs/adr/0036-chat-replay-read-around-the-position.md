# 0036: Chat replay is read around the playback position and never saved

Status: Accepted

## Context

A past livestream's chat is part of the stream: it is how it felt at the time, and YouTube replays it in step with the video. Horde showed a video's comments but never its chat. YouTube serves chat replay from internal endpoints in small pieces (50–100 messages, from under a minute to several minutes of video each), so a long, busy stream is hundreds of requests and several MB. yt-dlp can download it, but only from the start, as a blocking read. The browser cannot call YouTube itself (no CORS headers, the reason live streams already go through Horde, [ADR 0009](0009-live-streams-hls-proxy.md)). Library videos did not record whether they were streams.

## Decision

- **Never saved.** Chat replay is read from YouTube while someone watches, for library and streamed videos alike. Nothing is stored with downloads.
- **Read around the position.** `services/chat_replay` opens a video's chat once (the watch page, then the chat replay page: the first chunk and two tokens) and keeps it on `AppContext.chat_replay`. A position is one request with YouTube's seek token (`playerSeekContinuationData` plus `playerOffsetMs`); the stretch after a page is one request with its replay token. Chunks are kept in memory for 30 minutes, keyed by video and position bucket or token, so going back or a second viewer costs nothing. `GET /api/chat-replay/youtube/{id}?at_ms=` / `?cursor=` answers `{status, items, next_cursor}` (`none` when the video has no chat replay), behind the stream guard.
- **Horde carries the request loop.** It is the loop yt-dlp's `YoutubeLiveChatFD` runs, with yt-dlp's page helpers (cookies, consent, client headers), started from any position instead of the beginning. Messages are parsed into a small, bounded shape (text, Super Chats, Super Stickers, memberships, gifts); images only from YouTube's image hosts; anything unknown is dropped.
- **Only finished streams.** Chat shows for `live_status == was_live`. While YouTube is still processing a recording (`post_live`) it serves only the last hours on a timeline of their own, which would put chat out of step. `videos.live_status` (revision `0036_video_live_status`) records it for library videos: from the download, the metadata refresh, the channel video lists, and the first chat check of a video whose value is unknown.
- **A rate limit pauses every read** for 30 minutes without asking YouTube again.
- **Its own place on the page.** Chat sits beside the player (the top of the right column, related videos under it; beside the description in theater; above the AI panel on phones; side by side with the video on a phone turned sideways), not with the comments. Each user can hide it (`showChatReplay`).

## Consequences

- A viewer costs about one request per stretch of chat they watch (one to a few a minute), plus two to open; a jump anywhere in a 12-hour stream is one request.
- Chat is gone once YouTube stops showing the video, and is not there offline.
- When YouTube changes these endpoints, chat replay breaks until the loop is patched; yt-dlp breaks at the same moment and its fix can be copied.
- Clips (saved as their own videos without the stream's YouTube id) show no chat; adding it would need the source id and the clip's start on `videos`.
- Chat during a stream that is live now is not covered; it would build on the live session.

Detail: [Watching → Live chat replay](../guides/watching.md#live-chat-replay).

# Live chat on streams that are live now

Worked out in conversation on 2026-11-21. Builds on chat replay
(`2026-11-21-chat-replay-design.md`, ADR 0036). Calls marked *(builder's
call)* or *(proposal)* were not asked for by the user.

## Why

The user asked for chat on both past and active livestreams and chose replays
first. This is the second half: a YouTube broadcast that is live right now
shows its live chat beside the player, in the same places chat replay uses.

## Goals

- A live YouTube broadcast played in Horde shows its live chat in every layout
  chat replay uses (sidebar, beside the description in theater, inline on
  phones and narrow windows, phone sideways, touch fullscreen), with the same
  panel, autoscroll pause, Hide and settings toggle (`showChatReplay`).
- **Chat follows the viewer's position** (user's decision): scrubbed back in
  the DVR window, chat shows what was said at the moment being watched; at the
  live edge, the newest messages.
- One poll of YouTube per broadcast, shared by everyone watching it.

## Non-goals

- Saving chat. Messages are held in memory while someone watches, then dropped.
- Posting messages, polls, banners, the ticker, avatars (as for replay).
- Chat older than what Horde has seen: YouTube gives a live broadcast's chat
  only from about the last 75 messages onward.
- A chat overlay on the video.

## Anti-goals

- Polling YouTube for a broadcast nobody is watching.
- Any change to playback or to videos that are not live broadcasts.

## What YouTube serves (checked on 2026-11-21)

- The watch page of a live broadcast with chat has the same
  `conversationBar.liveChatRenderer` reload token as a replay. Some broadcasts
  have none (both NASA ISS streams, Sky News): chat is off.
- `https://www.youtube.com/live_chat?continuation=…` returns the last ~75
  messages (35–55 minutes on the slow chats tried) and an
  `invalidationContinuationData` token with `timeoutMs` (10 000).
- `POST youtubei/v1/live_chat/get_live_chat` with that token and
  `currentPlayerState.playerOffsetMs` returns the new actions and the next
  token. On Al Jazeera, messages arrived 5–8 s after they were sent.
- Actions are `addChatItemAction` directly (no `replayChatItemAction` wrapper);
  each renderer carries `timestampUsec` (send time, UTC). `removeChatItemAction`
  (`targetItemId`) deletes a message.
- yt-dlp's `downloader/youtube_live_chat.py` (`parse_actions_live`) shows the
  same loop.

## Approaches

1. **One shared poller per broadcast on the server** (chosen). It keeps a
   bounded buffer of parsed messages with their send times; viewers read from
   the buffer, never from YouTube. Following the position is a filter on send
   time.
2. Poll YouTube per viewer request. Multiplies requests by viewers and cannot
   serve the past a viewer scrubs back to. Rejected.
3. yt-dlp's live chat downloader in the background. It blocks until the
   broadcast ends and writes a file. Rejected.

## Design

### Server

- `services/chat_replay/live.py` *(builder's call on the module name)*:
  `open_live_chat(yt_id)` reads the watch page and the `live_chat` page with
  the same yt-dlp helpers, cookie rule and error classification as
  `youtube.open_chat`; `poll_live_chat(handle, token, offset_ms)` posts to
  `get_live_chat`. Parsing reuses `parse._item`, with `offset_ms` set to the
  message's send time in epoch milliseconds (`timestampUsec // 1000`) *(builder's
  call: field name kept so the frontend model and panel work unchanged)*.
  `removeChatItemAction` removes the message from the buffer.
- **The poller:** one per broadcast, a daemon thread owned by a
  `LiveChatRuntime` on the `AppContext` (`ctx.live_chat`) *(builder's call: thread
  or the live session's asyncio loop; threads must be joinable in tests)*. It
  polls at YouTube's `timeoutMs` (clamped to 2–30 s), and stops when no viewer
  has read for 60 s, when YouTube sends no further token (the broadcast ended),
  on a rate limit (which also pauses every chat read for 30 minutes through the
  existing pause), or at shutdown. A new read after it stopped opens it again.
- **The buffer:** messages in send order, each with an increasing sequence
  number; at most `HORDE_LIVE_DVR_HOURS` (default 4 h) of send time and at most
  20 000 messages *(builder's call)*, oldest dropped first.
- **API:** `GET /api/live/{video_id}/chat?behind_ms=&after=` on the live router
  (its `stream_guard` applies). Answers `{status, items, next_after, earliest_ms}`:
  `status` `ok` / `none` (no chat or not live) / `unavailable`; `items` the
  messages sent at or before `server_now - behind_ms`, after sequence `after`,
  at most 300 (the newest 300 when more qualify); `next_after` the last
  sequence returned; `earliest_ms` the send time of the oldest message held.
  Same error codes as chat replay. Under `HORDE_E2E` it answers `none` without
  reaching YouTube. `response_model` declared, OpenAPI and `schema.d.ts`
  regenerated.

### Frontend

- `chatTarget` also returns a live target for a stream whose
  `meta.is_live` is true *(builder's call on the shape, e.g. `{youtubeId, known,
  live: true}`)*.
- `useLiveChat(youtubeId, getBehindLiveSec)`: every 2 s reads
  `/api/live/{id}/chat` with the current `behind_ms` (from
  `getStreamBehindLive()`, 0 at the edge) and `after`, and appends. When the
  viewer moves back past the newest message shown (a scrub back), it reads
  afresh with `after=0`. Keeps at most `CHAT_KEEP` messages. Same state shape
  as `useChatReplay`, so `ChatReplayPanel` and the placement code are reused
  unchanged; Watch picks the hook by target.
- When the viewer is earlier than `earliest_ms`, the panel shows a one-line
  note: "Chat from before HH:MM isn't available." *(proposal: wording)*
- Nothing new in Settings: `showChatReplay` and Hide cover live chat too
  *(proposal; the toggle's label becomes "Show live chat")*.

## Testing

- Parsing of live actions and removals from a trimmed, anonymised fixture.
- The poller with YouTube faked: shared by two readers, stops when idle, stops
  at the end of the broadcast, rate limit pauses, buffer bounds, threads joined.
- The API: the `behind_ms` cutoff, `after`, the 300 cap, `none`, errors,
  parental guard, `HORDE_E2E`.
- Playwright with the route mocked: chat beside a live stream, following a
  scrub back, the "not available" note.

## Docs

- The guide's Live chat replay section becomes "Live chat" covering both;
  `docs/design/live-streams.md` gets a Live chat section; ADR 0037.

## Left to the builder

Module and field names, buffer sizes, polling clamps, thread vs. asyncio for
the poller, the exact refresh cadence in the browser.

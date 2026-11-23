# Live chat replay on past streams

Worked out in conversation on 2026-11-21. Calls marked *(builder's call)* or
*(proposal)* were not asked for by the user.

## Why

When someone watches a past livestream, the chat is part of it: it is how the
stream felt at the time. YouTube replays it in step with the video. Horde shows
the comments of a video but has never shown its chat. This adds chat replay for
past streams, downloaded or only streamed. Chat during a stream that is live
now is a later phase.

## Goals

- A past stream with a chat replay on YouTube shows that chat in step with
  playback, for library videos and streamed (not downloaded) videos alike.
- Chat has its own place on the page, different from comments:
  - **Standard view:** chat takes the top of the right-hand column, and the
    queue (when open) and "More like this" move underneath it.
  - **Theater mode:** chat sits under the video, to the right of the AI panel
    and description.
  - **Phones, portrait:** chat is a box under the video title and details,
    above the AI section.
  - **Phones, sideways:** turning the phone sideways on a past stream with chat
    fills the screen with the video on the left and chat on the right.
- Comments stay where they are, unchanged.
- Chat can be hidden, and the choice is remembered.

## Non-goals

- **Saving chat.** It is never saved with downloads. It is read from YouTube
  while someone watches, so it is gone once YouTube stops showing the video.
- Chat during a stream that is live now (next phase, on top of the live
  session).
- A translucent chat overlay on the video (maybe later).
- Posting messages, polls, banners, the ticker, author avatars.
- Searching chat, or using it in AI features.
- Chat in offline playback (it needs the server and YouTube).
- Chat on clips, for now. A clip is saved as its own library video with no
  YouTube id, and its start is kept only on the download job
  (`downloads/clips.py`), so clips show no chat. Adding it later needs the
  source stream's id and the clip's start on `videos` (decided 2026-11-21).

## Anti-goals

- Reading a whole chat from the start. A long stream is hundreds of requests;
  a viewer should only cost requests for what they watch.
- Any change to the page for videos that are not past streams with chat.
- Chat slowing down or stalling playback.

## Constraints

- **YouTube is read from the server.** YouTube's chat endpoints send no CORS
  headers, so the browser cannot call them (the same reason live streams go
  through Horde, ADR 0009).
- **Library videos do not record whether they were streams.** `videos` has no
  `live_status`; only `channel_catalog_videos` and `discovery_videos` do.
  Streamed videos know it from the preview (`StreamPreviewMeta.was_live`).
- **iPhone Safari has no element fullscreen.** On iPhone only Safari's own video
  player goes fullscreen, and nothing can be drawn over or beside it
  (`useFullscreen.ts` falls back to `webkitEnterFullscreen`). Android and iPad
  fullscreen the Horde player root, so anything inside the root comes along.
  Horde's manifest is `display: standalone`, so opened from the home screen a
  page that fills the viewport has no browser bars.
- **"Chat" already means the AI chat in the code** (`setChatDocked`,
  `VideoAiPanel`, help chat). This feature is "live chat" / "chat replay" in the
  interface and `chat_replay` in code, routes and settings.
- Project rules in `CLAUDE.md`: state on the `AppContext`, coded error envelope,
  `{items, next_cursor}` lists, regenerated `openapi.json` / `schema.d.ts`, an
  Alembic revision for the schema change, docs and an ADR in the same change.

## What YouTube serves (checked on 2026-11-21)

Probed with yt-dlp 2026.10.26's helpers against real past streams:

- A watch page with a chat replay carries a `conversationBar.liveChatRenderer`
  continuation in `ytInitialData`. Some past streams have none (every recent
  NASA stream tried, one chess stream): no chat replay.
- `https://www.youtube.com/live_chat_replay?continuation=…` returns the first
  chunk and two continuations: `liveChatReplayContinuationData` (the next chunk)
  and `playerSeekContinuationData` (jump).
- `POST youtubei/v1/live_chat/get_live_chat_replay` with the seek token and
  `currentPlayerState.playerOffsetMs = 7200000` on a 3.6-hour stream returned
  messages from 7,007,450 to 7,401,682 ms. **Seeking to any point works.**
- Each request took about 0.1 s and returned 50–100 actions, covering from
  under a minute to several minutes depending on how busy chat is. Every action
  is a `replayChatItemAction` with `videoOffsetTimeMsec`, wrapping YouTube's
  live chat renderers (`liveChatTextMessageRenderer`, placeholders, …).
- yt-dlp's own `YoutubeLiveChatFD` (`downloader/youtube_live_chat.py`) shows the
  request shape: `context` from `ytcfg.INNERTUBE_CONTEXT`, the API key, headers
  from `generate_api_headers`, `clickTracking` params.

## Approaches

1. **Read around the playback position** (chosen). The server opens a video's
   chat once (watch page, then the chat page) and keeps its tokens. The browser
   asks for chat from a position; the server fetches just that stretch with the
   seek token, or the next stretch with the replay token, and keeps recent
   stretches in memory so going back, or a second viewer, costs nothing. Seeking
   is near-instant anywhere, and a viewer only costs requests for what they
   watch. Horde carries its own copy of the small request loop yt-dlp uses
   (reusing yt-dlp's page parsing), so a YouTube change can break it until it
   is patched; yt-dlp breaks at the same time and its fix can be copied.
2. **yt-dlp reads the whole chat in the background** into a temporary file and
   the panel shows what has been read. Least new code, but it only reads from
   the start: jumping to hour 3 waits for every request before it (a minute or
   more), every open of a long stream costs the full read, and temporary files
   need cleaning up. Rejected.
3. **The browser reads YouTube directly.** Impossible (no CORS).

## Design

### Which videos show chat

- New nullable column **`videos.live_status`** (yt-dlp's value: `not_live`,
  `was_live`, `post_live`, …). Filled from:
  - the download's info dict at finalize (`entry_live_status`);
  - the revision itself, from `channel_catalog_videos.live_status` by
    `youtube_id`, where known;
  - the comments fetcher's extract, which already reads the video's page
    (`live_status` is in its unprocessed info) — set when it differs;
  - the chat replay check below, when a library video's value is unknown.
- `VideoRead` exposes `live_status`, and `StreamPreviewMeta` gains `live_status`
  (its `was_live` is also true for `post_live`, so it cannot tell them apart).
- The watch page asks for chat when the video has a YouTube id and its
  `live_status` is `was_live`, or it is a library video whose `live_status` is
  still null.
- **Only `was_live`, never `post_live`** *(builder's call)*. While YouTube is
  still processing a recording (`post_live`) it serves only the last hours, on
  a timeline of their own (`downloads/runner.py`), but chat offsets count from
  the start of the broadcast, so chat would play out of step. A library file
  downloaded during `post_live` keeps that value for good: the file itself is
  the partial window, so it never shows chat. A streamed `post_live` video gets
  chat once YouTube reports it as `was_live`.
  The server's answer `none` (no chat replay) hides chat and the page keeps its
  usual layout. *(proposal: a column instead of asking YouTube on every library
  video open, which would also shift the layout on every past stream.)*

### Server

- **Runtime on the `AppContext`** (`ctx.chat_replay`, like `ctx.comments`): per
  YouTube id, an open chat (API key, innertube context, visitor data, the
  latest seek token) closed after 30 idle minutes, and a bounded in-memory
  cache of fetched chunks *(builder's call: TTL and size)*. One lock per video
  so viewers of the same video share fetches. A `none` / `unavailable` answer
  is remembered for a while so reopening a stream without chat does not ask
  again *(builder's call: how long)*.
- **Opening** reads the watch page and the chat page with yt-dlp's
  `YoutubeBaseInfoExtractor` helpers (`_download_webpage`,
  `extract_yt_initial_data`, `extract_ytcfg`, `generate_api_headers`), with the
  same cookie handling as comments (`url_cookie_required`, `apply_cookie_opts`,
  retry with cookies). For a library video with unknown `live_status` it
  records what the page says.
- **Fetching** posts to `get_live_chat_replay` with the seek token and
  `playerOffsetMs` for a jump, or the replay token for the next chunk.
- **Normalizing** turns YouTube's renderers into a small, bounded shape (text
  and author lengths capped):
  - `text`: author, badges (`owner`, `moderator`, `member`, `verified`), runs of
    text and emoji (standard emoji as their character, custom emoji as an image
    URL on YouTube's image host and its shortcut as alt text);
  - `paid` (Super Chat): as text plus the amount and YouTube's tier colour;
  - `sticker` (Super Sticker): amount, sticker image and its alt text;
  - `membership`: new member or milestone, with its header text and message;
  - `gift`: membership gift purchase announcements.
  Placeholders, engagement messages, polls, banners, ticker items and mode
  changes are dropped. Each item has a stable `id` and `offset_ms`.
- **API** *(names are the builder's call)*:
  `GET /api/chat-replay/youtube/{yt_id}?at_ms=` reads from a position;
  `?cursor=` continues after the last chunk. Response `{status, items,
  next_cursor}` with `status` one of `ok`, `none` (no chat replay),
  `unavailable` (private, removed, members-only or age-restricted without
  cookies). Errors use the envelope with the codes comments already use
  (`youtube_rate_limited`, `youtube_unreachable`). Guards as for comments: the
  stream guard (parental controls: only allowed channels), `current_user`.
  `response_model` declared, `openapi.json` and `schema.d.ts` regenerated.
- **Rate limits:** a 429 or bot check pauses all chat replay reads for a while
  and answers `youtube_rate_limited` meanwhile *(builder's call: how long; live
  checks use 30 minutes)*.
- No server-wide switch *(proposal: reads happen only while someone watches a
  past stream, and each user can hide chat)*.

### The chat panel

- Reads the playback position from `PlaybackActions.getCurrentPosition()` /
  `getStreamPosition()` a few times a second.
- Shows the messages up to the current position, newest at the bottom, and
  keeps a few hundred at most in the list. Paused playback freezes it.
- Asks for the next chunk before the position reaches the end of what is
  loaded. A seek outside the loaded stretch clears the list and reads from the
  new position; a seek inside it just re-renders.
- Stays on the newest message. When the viewer scrolls up to read while chat
  is moving, autoscroll pauses and the list stays put under them while new
  messages keep arriving below. A down-arrow **Jump to latest** button appears;
  pressing it (or scrolling back to the bottom) resumes autoscroll (asked for by
  the user).
- No avatars *(proposal: a busy chat would load hundreds of images from
  Google, and the list stays compact)*. Owner and moderator names are marked
  the way comments mark the uploader. Super Chats stand out with the amount;
  colours follow `DESIGN.md` roles, YouTube's tier colour at most as an accent
  *(builder's call within DESIGN.md)*. Links in messages are plain text.
- States: loading, a short note when YouTube cannot be reached or is limiting
  requests (with retry), and nothing at all for `none`.
- Header "Live chat" with a **Hide** button.

### Placement

```
Standard view (xl and up)                    Theater mode
┌──────────── player ───────────┐ ┌ Chat ──┐  ┌──────── player, full width ────────┐
│                               │ │ ana: hi│  └────────────────────────────────────┘
└───────────────────────────────┘ └────────┘   Title / actions
 Title / actions                   Queue        AI panel      │ Live chat
 AI panel                          More like    Description   │ ...
 Description                       this         Comments      │ Queue (if any)
 Comments

Phone, portrait   Phone, sideways
┌──────────┐      ┌────────────────────┬─────────┐
│  player  │      │                    │ ana: hi │
├──────────┤      │       player       │ bo: GG  │
│ Title    │      │                    │ $5 cy   │
│ Chat ▢▢▢ │      └────────────────────┴─────────┘
│ AI panel │
```

- **Standard view (`xl` and up):** the right column (`WatchSidebar`) shows for
  a past stream with chat even when "Show related videos" is off or there are
  no related items. Chat is first, a fixed height about the player's *(proposal)*,
  then the queue, then "More like this".
- **Standard view narrower than `xl`** (no right column today): chat takes the
  phone-portrait slot *(proposal)*.
- **Theater:** chat takes the right column of `WatchInfoPanels` (where the queue
  goes today), with the queue under it.
- **Phone portrait:** first thing in `WatchInfoPanels`, above the AI panel, a
  fixed-height box.
- **Phone sideways** (`useIsMobile` true and landscape) on a past stream with
  chat showing: the video and chat fill the viewport side by side, chat about a
  third of the width, the player controls on the video part. Other videos turn
  sideways as they do today. The player is hosted for the mini-player
  (`context/playback/miniHost.ts`); how the sideways layout hosts it is the
  builder's call.
- **Fullscreen on touch devices** (coarse pointer, element fullscreen: Android,
  iPad): with chat showing, chat is inside the player root on the right. Desktop
  fullscreen stays video-only *(proposal, like YouTube)*. iPhone's fullscreen
  button keeps Safari's own player.

### Hiding

- Per-user setting `showChatReplay` (default on), synced like
  `showRelatedVideos`, with a toggle in Settings → Playback beside "Show related
  videos" and an entry in `help_catalog.json`.
- **Hide** turns it off. A slim "Show live chat" bar takes the panel's place so
  it can come back; in the sideways view a chat button on the player does that,
  and hiding gives the whole screen to the video *(builder's call on the exact
  controls)*.

## Testing

- Parsing: unit tests from trimmed real responses saved as fixtures (each kind,
  dropped kinds, caps).
- API: `TestClient` with the YouTube layer faked: `ok` / `none` /
  `unavailable`, jump and continue, shared fetch for two viewers, rate-limit
  pause and its error code, parental guard, `live_status` recorded for a library
  video.
- Schema: the revision passes `tests/test_database_migrate.py`; the backfill
  from the channel catalog is tested.
- Playwright: an E2E stub chat source for a seeded past stream (`HORDE_E2E`),
  covering the standard, theater, phone portrait and phone sideways layouts,
  hide and show, and chat following a seek.

## Docs

- A guide section on chat replay (`docs/guides/watching.md` or its own page),
  the data-model change, `docs/architecture/api-overview.md`.
- ADR 0036: chat replay is read around the playback position and never saved.
- `DESIGN.md` if the chat list adds a component pattern.

## Left to the builder

Route and field names, cache sizes and lifetimes, polling cadence, how far
ahead to prefetch, the exact hide/show controls, how the sideways layout hosts
the player, and the Super Chat styling within `DESIGN.md`.

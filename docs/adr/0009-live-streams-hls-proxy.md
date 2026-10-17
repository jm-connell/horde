# 0009. Live streams through a server-side HLS proxy with a probed DVR window

Status: Accepted

## Context

Users want to watch broadcasts of the channels they follow, with scrubbing back like on YouTube, and only if playback stays up for hours. YouTube's live media URLs are bound to the server's IP, send no CORS headers, expire after about 6 hours, and occasionally start answering 403 or stall on one CDN edge. The normal stream preview builds a DASH manifest from adaptive formats, but for live broadcasts the adaptive formats are the ones most exposed to SABR and PO-token changes. yt-dlp documents that live HLS does not need a PO token. YouTube's HLS playlists only list the newest few segments.

## Decision

- Play live broadcasts as **HLS through Horde** (`/api/live/{id}/...`). Horde writes the master playlist from yt-dlp's HLS formats, re-renders each variant playlist with its own segment URIs, and streams segments through. The browser uses Shaka's HLS build.
- Keep **one session per broadcast**, shared by viewers and held on `AppContext.live`. It refreshes the upstream URLs on 403, ahead of `expire`, and when the playlist stalls. The player never sees a YouTube URL, so a refresh is invisible to it.
- Build the **DVR window** from the sequence number in YouTube's segment URLs. Probe how far back the broadcast still serves segments, and list up to `HORDE_LIVE_DVR_HOURS` of them. Fall back to the segments seen since the session opened when probing fails.
- Detect live channels with **one `/live` page fetch per followed channel** (`HORDE_LIVE_POLL_SEC`), not a yt-dlp extraction. yt-dlp is only the fallback for an unreadable page, and a 429 pauses checks for 30 minutes.
- Follows are **per user** (`channel_follows`). A finished download follows its channel for the user who queued it (`download_requesters`), and an unfollow is kept as a tombstone so it sticks.

## Consequences

- Each viewer's stream passes through the server, which costs server bandwidth. In return the stream survives URL expiry and edge failures without the player reloading.
- The DVR window relies on YouTube keeping sequence-numbered segment URLs. If that changes, scrubbing shrinks to what the session has seen, and playback is unaffected.
- The live check parses YouTube's page JSON. A layout change degrades the list (no game or viewer count) before it breaks it, and the yt-dlp fallback covers an unreadable page.
- Starting a stream still depends on yt-dlp extraction, like every other YouTube feature. Details: [Live streams](../design/live-streams.md).

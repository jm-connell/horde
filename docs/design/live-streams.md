# Live streams

Followed channels that are live show up, quietly, at the top of the library sidebar. Clicking one plays the broadcast in the normal player, with a seek bar you can scrub back through and a **LIVE** control that jumps to the edge. This page explains how it works and why it stays up for hours.

## Following

`channel_follows` holds one row per user and channel (`services/follows.py`, `api/follows.py`):

- A library download a user queued follows its channel when it finishes. The download API records the requester in `download_requesters`, and `finalize` calls `follows.follow_from_download`. Automatic jobs (auto-download, imports without a user) follow nothing.
- At startup, an administrator who has no follow rows yet follows every library channel. Every download before follows existed was theirs.
- Anyone can subscribe to a channel (the code calls this following) by name, URL or `@handle` on the **Subscriptions** page, or with the **Subscribe** button on a channel page. The channel does not need any videos in the library.
- Unfollowing keeps the row with `followed = 0`. A later download from that channel does not follow it again, and the admin seed does not run again.

Follows are YouTube-only, because only YouTube's live pages are checked.

## Who is live

The `live-poller` worker (`services/live/directory.py`) checks every channel that anybody follows. Each check is one GET of `https://www.youtube.com/<channel>/live`. When the channel is live, that URL serves the broadcast's watch page, and the embedded player response and page data carry the video id, title, viewer count and the game card (`services/live/page.py`). A full yt-dlp extraction per channel would cost seconds and a player download, so it is used only when the page names a watch URL but its JSON cannot be read (a layout change).

- Checks run `HORDE_LIVE_POLL_SPACING_SEC` (2 s) apart, and a channel is re-checked once its last check is older than `HORDE_LIVE_POLL_SEC` (300 s). With many channels a pass takes longer than the interval, and each channel is simply checked less often.
- A 429 from YouTube pauses all live checks for 30 minutes, so live checks never get the server's IP rate-limited for downloads.
- A failed check keeps the previous answer. A live entry that has not been confirmed for 20 minutes is dropped.
- Following a channel checks it at once, so the list does not wait for the next pass.
- `GET /api/live` reads this directory, filtered to the user's follows. The SPA polls it every 60 s, and only while **Show live streams** is on.
- `GET /api/live/channel?url=` answers for one channel (its channel page). It reads the directory when the channel's last check is recent (a followed channel), and otherwise checks the channel's `/live` page once and keeps the answer for two minutes. It fetches nothing while live checks are off or paused after a 429, and a broadcast not confirmed for 20 minutes is not reported. YouTube URLs only. The channel page shows the broadcast as the first card, marked **LIVE**.

## Playing: the HLS proxy

YouTube serves live broadcasts as HLS. Older broadcasts come as MPEG-TS variants with audio and video muxed together; most now come as video-only TS variants plus audio-only formats (itags 233/234) whose segments are packed AAC with an ID3 timestamp. The session uses the muxed variants when there are any, otherwise the video-only variants with the best audio-only format as one shared audio rendition (`EXT-X-MEDIA TYPE=AUDIO` in the master playlist). yt-dlp's PO-token guide notes that live HLS does not need a PO token (the iOS client aside), which is what makes this path more dependable than adaptive playback of normal videos. The browser cannot fetch YouTube's URLs itself, because they are bound to the server's IP and send no CORS headers. So the server proxies everything (`api/live.py`, `services/live/sessions.py`):

| URL | Served from |
|---|---|
| `/api/live/{id}/master.m3u8` | A master playlist Horde writes from yt-dlp's HLS formats, one variant per height, plus the 1440p and 2160p variants (below) |
| `/api/live/{id}/v/{key}.m3u8` | YouTube's variant playlist, re-rendered with Horde segment URIs and the DVR window |
| `/api/live/{id}/seg/{key}/{sq}.ts` | A video (or muxed) segment, streamed through from googlevideo |
| `/api/live/{id}/seg/{key}/{sq}.aac` | A segment of the separate audio rendition (`audio/aac`) |
| `/api/live/{id}/seg/{key}/{sq}.webm` | A segment of a 1440p or 2160p variant (`video/webm`); HEAD answers the type without fetching it |

One `LiveSession` per broadcast is shared by every viewer. Sessions live on `AppContext.live` and are closed after 10 idle minutes. The player is Shaka's HLS build (`useShakaDash` with `live`), which transmuxes TS and packed AAC in the browser.

### 1440p and 2160p

YouTube's live HLS ladder stops at 1080p (H.264). Taller live formats exist only as adaptive VP9 streams in WebM, and YouTube lists those only to clients that run its player JavaScript ([ADR 0038](../adr/0038-live-1440p-and-2160p-need-deno.md)). When `YTDLP_JS_RUNTIME` names a JavaScript runtime (the Docker image ships Deno for this), opening a session runs a second extraction with yt-dlp's `tv_samsung` client, which needs no PO token (`services/live/extract.py`, cached on its own). The session adds its VP9 formats taller than the HLS ladder as extra variants:

- **No playlist of their own.** Segment `n` of such a format is its signed URL plus `&sq=n`, numbered and timed like the HLS segments. So a VP9 variant's playlist lists the tallest HLS variant's segments (DVR window and discontinuities included) under `.webm` URIs, and the session fetches `url&sq=n`. Past the newest segment YouTube answers 204, which the session reports as a missing segment.
- **Video only.** They play beside the HLS audio rendition, so only broadcasts with split audio get them; a muxed ladder stays as it is.
- **The player.** HLS has no way to name WebM, so Shaka asks for the type with HEAD once. Shaka switches between the H.264 TS and VP9 WebM variants like any others. Live keeps Shaka's default codec preference, since preferring H.264 would drop the VP9 variants. A browser that cannot decode VP9 never sees them.
- **Falling back.** If the extra extraction fails, the stream plays as before, up to 1080p. A later URL refresh tries again, but the player reads the master playlist only once, so variants found then reach only viewers who open the stream afterwards. A VP9 variant that a refresh does not list keeps its old URLs, and a 403 on those no longer starts a refresh of its own. HDR formats are left out. Clips are cut from the HLS variants.

### What keeps it stable

- **The player only sees Horde URLs.** YouTube's URLs expire after about 6 hours and can start answering 403 earlier. When that happens, the session re-extracts the stream (one extraction at a time, debounced), re-reads the playlist and retries the request. URLs are also refreshed 20 minutes before their `expire` time. The player keeps re-reading the same playlist URL every few seconds and never notices.
- **Stall watchdog.** If the newest segment does not advance for 30 seconds (or 6 target durations), the session re-extracts, which usually lands on a healthy CDN edge.
- **Brief outages are absorbed.** A failed playlist refresh serves the last good playlist for up to 30 seconds. Shaka retries segments and playlists six times with backoff. After a critical error it resumes streaming in place, with growing delays, up to six times before showing an error.
- **Coming back after time away.** With the page hidden (screen locked, app in the background) the browser stops refreshing playlists and the session may close after 10 idle minutes. On return to a stream that was playing, or on Play after a pause that spanned time hidden, the player (`useLiveResume`) reloads the stream once it has been away 60 seconds or more and seeks to `edge - (behind when left + time away)`, clamped to the seek range; a shorter absence just plays on. A stream that kept playing in a background tab is left alone.
- **Sound stays with the picture.** The player appends live segments back to back (Shaka's HLS `sequenceMode`) rather than pinning each one to its playlist time. The playlists give whole seconds (5.0 s, or 1.0 s on low-latency broadcasts), but YouTube's audio segments hold whole AAC frames (at 44.1 kHz, 4.992 or 5.016 s; 0.9985 s). Pinned to the playlist, the short ones leave gaps of a few milliseconds, and Chrome plays through the gaps, so the sound drifted ahead of the picture by about a second every 10 minutes until a seek reset it. After a seek Shaka lines both tracks up with the playlist again, and so it does at an encoder reconnect: when YouTube marks one (`#EXT-X-DISCONTINUITY`), every Horde playlist carries the marker at the same segment, with an `EXT-X-DISCONTINUITY-SEQUENCE` that counts the markers the window has slid past. A quality change on a live stream (from the menu, or the automatic step down when frames drop) keeps what is buffered and takes over where it ends, a few segments ahead: after a manual buffer clear Shaka would append the new segments where the cleared ones ended, away from the playhead, and playback would stall.
- **Shared upstream fetches.** A playlist is fetched from YouTube at most once per half target duration, however many people watch.
- **A clean end.** When the broadcast ends, the playlist gets `EXT-X-ENDLIST` and the player shows **Stream ended**. If a stream is opened after it ended, the API answers 409 `not_live` and the player says so.

### Scrubbing back (DVR)

Every YouTube segment URL carries its sequence number (`/sq/<n>/`), the same number across a broadcast's audio and video formats. Segments of a broadcast stay addressable by number for as long as YouTube keeps them: from the first segment of a broadcast five hours old, and at least 120 hours back on a 24/7 stream. After the first playlist, the session builds a template from the newest segment URL (`hls.segment_template`). The template leaves out `govp/lmt=…` (`goap` on audio): YouTube changes that value every so often during a broadcast, and an earlier segment asked for with the current one is a 404, which once held the window to about 30 minutes; without it, every kept segment is served. It then probes how far back the broadcast still serves segments, trying the full window, then half, a quarter and so on, one request each. Every variant's first playlist waits for that one probe, and all playlists share one start floor: with a separate audio rendition the player reads two playlists at once and lines them up by sequence number, so they must start at the same segment. Once probed, playlists list every segment from that point (capped at `HORDE_LIVE_DVR_HOURS`, default 24 hours, and at 17 280 segments: a day of 5 s segments, about 40 KiB of gzipped playlist per refresh, which the player re-reads without a stall) to the live edge. Earlier segments are fetched through the template, signed with the current extraction's URL. The probe repeats every 30 minutes.

When the probe finds nothing (a broadcast with DVR turned off, or a URL layout without a sequence number), the playlist lists what the session has seen since it opened. The stream still plays; it just cannot go back further than that.

The seek bar maps onto Shaka's seek range (`useLiveWindow`), so it grows as the broadcast goes on. Hovering shows the time behind live. The readout shows **LIVE** with a red dot at the edge, or `LIVE -12:34` in grey when behind; clicking it jumps back to live.

## Live chat

`GET /api/live/{id}/chat?behind_ms=&after=` serves a broadcast's live chat from a buffer Horde fills while anyone reads it (`services/chat_replay/live.py`, `live_runtime.py`, `AppContext.live_chat`). The first read opens the chat (the watch page, then YouTube's `live_chat` page: about the last 75 messages and a continuation token) and starts one daemon thread per broadcast that posts to `youtubei/v1/live_chat/get_live_chat` at the pace YouTube asks (`timeoutMs`, clamped to 2–30 s). Each message keeps its send time; the buffer holds at most the DVR window of send time and 20 000 messages, with sequence numbers for `after`.

- **Following the viewer.** The cutoff is `now - behind_ms - 3 target durations`: the player's live edge trails the newest segment by the HLS hold-back (`LiveSession.edge_lag_sec`). YouTube's own encoder delay remains as a lead of a few seconds. The browser reads every 2 s and reads afresh (`after=0`) when it moves more than 5 s further behind live (a scrub back). `earliest_ms` against `cutoff_ms` gives the "not available" note.
- **Stopping.** Polling stops 60 s after the last read, when YouTube sends no further token (the broadcast ended), on a rate limit (which pauses every chat read for 30 minutes) and at shutdown. The buffer is still served, and a later read restarts polling with the same sequence; a buffer nobody has read for 10 minutes is dropped. Deleted messages (`removeChatItemAction`) are removed and reported in `removed`.
- Top chat (YouTube's default view), as chat replay. Under `HORDE_E2E` the route answers `none`.

## Limits

- **Extraction can break.** When YouTube changes something, starting a stream can fail until yt-dlp is updated (the same is true of normal stream previews). Once a stream plays, playback no longer goes through yt-dlp, except for the URL refreshes described above.
- **Members-only and age-restricted** broadcasts need cookies (`YTDLP_COOKIE_FILE`), as for downloads.
- **Bandwidth.** Each viewer pulls the stream through the server: about 3 to 6 Mbit/s at 720p to 1080p, 9 Mbit/s at 1440p60 and 18 Mbit/s at 2160p60.
- **1440p and 2160p** need `YTDLP_JS_RUNTIME`, which the Docker image sets. The extra extraction adds about 2 seconds the first time a broadcast is opened.
- **Casting is off for live streams.** A Chromecast cannot reach the proxied playlist the way it reaches a library file.
- Live playback does not touch watch history.

## Checking a real broadcast

`python -m app.live_probe` (`backend/app/live_probe.py`) runs the same session code against a broadcast that is live now, without a browser. It plays one variant the way a player does for as long as you ask, then reports failed segments, URL refreshes, the longest stall at the edge and how far back the DVR window reaches:

```bash
docker compose exec horde python -m app.live_probe "https://www.youtube.com/watch?v=VIDEO_ID" --minutes 60
```

Exit status 0 means every segment arrived.

## Turning it off

- **Per user:** **Settings → Library → Show live streams** off hides the section and stops the polling of `/api/live`.
- **Server-wide:** `HORDE_LIVE_POLL_SEC=0` stops the background checks, and `/api/live` then reports `enabled: false`. A live URL opened by hand still plays.

# Live streams

Followed channels that are live show up, quietly, at the top of the library sidebar. Clicking one plays the broadcast in the normal player, with a seek bar you can scrub back through and a **LIVE** control that jumps to the edge. This page explains how it works and why it stays up for hours.

## Following

`channel_follows` holds one row per user and channel (`services/follows.py`, `api/follows.py`):

- A library download a user queued follows its channel when it finishes. The download API records the requester in `download_requesters`, and `finalize` calls `follows.follow_from_download`. Automatic jobs (auto-download, imports without a user) follow nothing.
- At startup, an administrator who has no follow rows yet follows every library channel. Every download before follows existed was theirs.
- Anyone can follow a channel by URL or `@handle` in **Settings → Library → Followed channels**, or with the **Follow** button on a channel page. The channel does not need any videos in the library.
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
| `/api/live/{id}/master.m3u8` | A master playlist Horde writes from yt-dlp's HLS formats, one variant per height |
| `/api/live/{id}/v/{key}.m3u8` | YouTube's variant playlist, re-rendered with Horde segment URIs and the DVR window |
| `/api/live/{id}/seg/{key}/{sq}.ts` | A video (or muxed) segment, streamed through from googlevideo |
| `/api/live/{id}/seg/{key}/{sq}.aac` | A segment of the separate audio rendition (`audio/aac`) |

One `LiveSession` per broadcast is shared by every viewer. Sessions live on `AppContext.live` and are closed after 10 idle minutes. The player is Shaka's HLS build (`useShakaDash` with `live`), which transmuxes TS and packed AAC in the browser.

### What keeps it stable

- **The player only sees Horde URLs.** YouTube's URLs expire after about 6 hours and can start answering 403 earlier. When that happens, the session re-extracts the stream (one extraction at a time, debounced), re-reads the playlist and retries the request. URLs are also refreshed 20 minutes before their `expire` time. The player keeps re-reading the same playlist URL every few seconds and never notices.
- **Stall watchdog.** If the newest segment does not advance for 30 seconds (or 6 target durations), the session re-extracts, which usually lands on a healthy CDN edge.
- **Brief outages are absorbed.** A failed playlist refresh serves the last good playlist for up to 30 seconds. Shaka retries segments and playlists six times with backoff. After a critical error it resumes streaming in place, with growing delays, up to six times before showing an error.
- **Coming back after time away.** With the page hidden (screen locked, app in the background) the browser stops refreshing playlists and the session may close after 10 idle minutes. On return to a stream that was playing, or on Play after a pause that spanned time hidden, the player (`useLiveResume`) reloads the stream once it has been away 60 seconds or more and seeks to `edge - (behind when left + time away)`, clamped to the seek range; a shorter absence just plays on. A stream that kept playing in a background tab is left alone.
- **Shared upstream fetches.** A playlist is fetched from YouTube at most once per half target duration, however many people watch.
- **A clean end.** When the broadcast ends, the playlist gets `EXT-X-ENDLIST` and the player shows **Stream ended**. If a stream is opened after it ended, the API answers 409 `not_live` and the player says so.

### Scrubbing back (DVR)

Every YouTube segment URL carries its sequence number (`/sq/<n>/`), the same number across a broadcast's audio and video formats. Segments of a broadcast stay addressable by number for as long as YouTube keeps its DVR window. After the first playlist, the session builds a template from the newest segment URL (`hls.segment_template`). It then probes how far back the broadcast still serves segments, trying the full window, then half, a quarter and so on, one request each. Every variant's first playlist waits for that one probe, and all playlists share one start floor: with a separate audio rendition the player reads two playlists at once and lines them up by sequence number, so they must start at the same segment. Once probed, playlists list every segment from that point (capped at `HORDE_LIVE_DVR_HOURS`, default 4 hours) to the live edge. Earlier segments are fetched through the template, signed with the current extraction's URL. The probe repeats every 30 minutes.

When the probe finds nothing (a broadcast with DVR turned off, or a URL layout without a sequence number), the playlist lists what the session has seen since it opened. The stream still plays; it just cannot go back further than that.

The seek bar maps onto Shaka's seek range (`useLiveWindow`), so it grows as the broadcast goes on. Hovering shows the time behind live. The readout shows **LIVE** with a red dot at the edge, or `LIVE -12:34` in grey when behind; clicking it jumps back to live.

## Limits

- **Extraction can break.** When YouTube changes something, starting a stream can fail until yt-dlp is updated (the same is true of normal stream previews). Once a stream plays, playback no longer goes through yt-dlp, except for the URL refreshes described above.
- **Members-only and age-restricted** broadcasts need cookies (`YTDLP_COOKIE_FILE`), as for downloads.
- **Bandwidth.** Each viewer pulls the stream through the server: about 3 to 6 Mbit/s at 720p to 1080p.
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

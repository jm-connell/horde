# Watching

Horde plays library videos and remote stream previews in the same player shell. Resume, related videos, autoplay, and download handoff are all part of the watch experience.

## Routes

| URL | Mode |
|-----|------|
| `/watch/:id` | Play a **library** video by id |
| `/watch?url=…` | **Stream preview** a remote URL (catalog / paste) without downloading first |

Library playback uses local files (progressive). Stream preview uses adaptive **DASH** when available (see [Player](player.md)).

## Starting a stream sooner

Rest the mouse on a video that isn't downloaded (a feed card, a related video, a playlist entry) for a moment, or tab to it with the keyboard, and Horde starts loading it: its details and its stream are ready by the time you click, so it plays sooner. Cards the mouse only passes over on the way are left alone, and a video you click goes ahead of any of these still waiting their turn. It loads one video at a time, the one you last pointed at, and the same video at most once every 3 minutes. Phones and tablets don't do this, because touching a card also starts a scroll.

## Resume position

Your playback position belongs to your account, not to the device: it is
stored per user on the server (`user_video_state`, read back as
`last_position_sec` on the video). Start a video on your phone, open it on
your PC, and it carries on where the phone stopped; someone else signed in
to Horde has their own position in the same video.

| Behavior | Detail |
|----------|--------|
| **Save interval** | Progress is persisted about every **5 seconds** while playing, and where you stopped is saved within 5 seconds of pausing or seeking |
| **Leaving** | Hiding the tab, switching apps or closing the page saves the position at once |
| **Near end** | At **≥ 90%** of duration, progress is **cleared** (treated as finished; next open starts from the beginning) |
| **Resume** | Reopening `/watch/:id` seeks to the saved position when it is meaningful, as saved by any of your devices (no reload needed) |
| **Coming back to a paused tab** | If you moved on in the same video on another device meanwhile, the paused player jumps to that position when the tab or window comes back to the front. It does not start playing, and a playing video is never moved |
| **Mini-player** | Expanding the mini-player (or opening the video it is playing) carries on from the playhead, unless another device of yours has saved a newer position since |

Continue watching on the [Library](library.md) and [History](history.md) pages uses the same progress fields.

A **stream preview** (a video you watch without downloading it) resumes too: where you left it is kept for your account (`user_stream_state.position_sec`) and reopening it, on any device, carries on from there. It is saved once 20 seconds have played, then about every 30 seconds and when you close the video or leave the page, and a stream watched to 90% starts over. `?t=` in the link wins over the saved position. Live broadcasts are not resumed.

!!! note "Expiry"
    Stale positions are cleared by `progress_expiry_days` (default **14**). The continue-watching *list* only includes recent activity within a fixed **7-day** backend window. See [History](history.md).

## Comments

Under the description, a YouTube video shows its saved top comments, with the most popular discussions' replies; more can be read from YouTube on request, and a stream loads its comments when asked. See [Comments](comments.md).

## Live chat replay

A past livestream from YouTube shows its chat replay, in step with the video: messages appear as the moment they were sent comes up, pause when the video pauses and jump when you seek. It works for downloaded videos and for streams you watch without downloading. Chat is read from YouTube while you watch and never saved, so it needs YouTube to be reachable and is gone once YouTube stops showing the video.

- **Where it shows.** In the normal view, at the top of the right-hand column, with related videos under it. In theater mode, beside the description. On a phone, or a window too narrow for the right column, in a box under the title, above the AI section.
- **Phone turned sideways.** The video and the chat fill the screen side by side. Opened from the home screen icon there are no browser bars, so it looks like fullscreen; on Android and iPad, the player's fullscreen button also keeps the chat beside the picture. (iPhone Safari's own fullscreen player cannot show anything beside the video.)
- **Reading back.** Chat follows the newest message. Scroll up to read and it stops moving; the down-arrow button (or scrolling back to the bottom) picks up again.
- **Hide.** **Hide** removes it on every past stream until you bring it back with **Show live chat**, or with **Show live chat** in [Settings → Playback](../settings/playback.md).
- **What it shows.** Messages, Super Chats and Super Stickers with their amount, new members and membership gifts. No profile pictures; links show as text.
- **Not shown** for a stream YouTube is still processing (right after it ends; chat appears once the recording is finished), for clips, for other sites' past streams, or offline. If YouTube is limiting requests, chat says so and waits for **Retry**.

Comments stay under the description. How chat is read: [ADR 0036](../adr/0036-chat-replay-read-around-the-position.md).

## Live chat

A YouTube broadcast that is live right now shows its live chat in the same places, with the same **Hide** and reading back. It follows where you are: at the live edge you see the newest messages; scrub back and you see what was said at the moment you are watching. Horde collects a broadcast's chat while anyone watches it (one read of YouTube every few seconds, shared by everyone watching) and keeps it in memory only. When you first open a broadcast it starts with roughly the last 75 messages, so going back further than Horde has seen shows a note instead: *Chat from before HH:MM isn't available.* Messages deleted on YouTube disappear. When the broadcast ends the chat already collected stays while you keep watching; once YouTube has finished the recording, the past stream gets [chat replay](#live-chat-replay). How it works: [ADR 0037](../adr/0037-live-chat-follows-the-viewer.md).

## Related videos

When enabled in [Settings → Playback](../settings/playback.md), the watch page shows a **related videos** sidebar (library recommendations / neighbors). Related suggestions improve when AI embeddings are available ([AI features](ai-features.md)): they rank by how similar the videos are as a whole (title, description, tags, then captions), favour the same channel and shared distinctive tags, and push down videos you have already watched.

When the channel's [next part](#autoplay-the-next-part) of the series is known, it leads the related list (on a library video only when it is downloaded). On a **stream preview** the related list also includes videos from channels you have indexed that are not downloaded yet; each downloaded one is marked **Downloaded** and opens the library copy, the others open as streams. On a **live** stream, the channel's other broadcasts that are live right now come first, marked **Live now**, so switching between a tournament's A and B streams is one click (read from the channel's Streams tab, cached for a few minutes). A stream also gets the Summary section and AI chapters, and Ask answers questions about it; see [AI features](ai-features.md#streamed-videos).

A related list is mostly, not only, about the video you are watching. Every fourth place goes to a pick from your [Recommended](library.md#library-and-recommended) feed that is about something else: under a Counter-Strike stream, three Counter-Strike videos, then something from another of your interests, and so on. Such a pick is never from the playing video's channel, and with AI embeddings it must be clearly less close to the video than the video's nearest neighbours are; a library video's list takes downloaded picks only. The first three places stay on the video's topic, and [autoplay](#autoplay-related) takes the first video in the list you have not just watched, so it normally stays on the topic too; after several in a row it can move on to another interest. Someone with no watch history yet has no other interests to show, and their lists stay as they were. Why: [ADR 0041](../adr/0041-related-lists-keep-other-interests.md).

## Autoplay related

If **Autoplay related** is on and the play queue is empty when a video ends, Horde shows an up-next overlay with an **8-second countdown**, then starts the suggested related video.

- Cancel or play immediately from the overlay controls
- Turning autoplay off mid-countdown cancels the overlay
- Items already in the [player queue](player.md) advance immediately without the related countdown


## Autoplay the next part

With **Autoplay related** on (Settings → Playback or the player controls, on by default), a video that ends with an empty queue first looks for the channel's **next part** of the series. If there is one, the up-next countdown plays it, downloaded or not ("Next part · not downloaded" on the card); otherwise a library video falls back to a related video as above, and a stream preview stops.

"Next part" is strict, because a wrong guess plays something unrelated. Shorts, live streams and premieres are skipped. Among the channel's next 50 uploads, the first whose title is the next numbered part wins, even past unrelated uploads in between: either the same title with a number one higher ("Day 12" → "Day 13", "Part 3" → "Part 4"), or the same series name of 2+ words or 5+ letters right before a number one higher, whatever the episode is called ("I Created A City Full Of Intersections | Cities: Skylines #2" → "The Biggest Roundabout of All Time | Cities Skylines #3"). Failing that, the very next upload still counts when it shares the same series tag set off by `|`, `:`, `-` or brackets ("GTA RP | …"). A tag that names the channel, or one the channel puts on more than 40% of its recent uploads (a format such as "| xQc Reacts"), does not count. The uploads are read from the channel's index when the channel is indexed, otherwise (library videos only) from its downloaded videos in publish order. A stream preview needs its channel indexed. The API is `GET /api/videos/{id}/next-part`, and `GET /api/preview/next-part?url=…` for a stream.
## Title / description drift

If you customized a library video’s title and a metadata resync finds that the **source (YouTube) title** now differs, the watch page shows a banner:

> Source title changed…

You can adopt the new source title or keep your custom title. This appears when `title_is_custom` is set and `source_title` ≠ current `title`. A similar banner appears for custom descriptions when `source_description` drifts.

Redownload (“Change resolution”) and auto-replace of the same YouTube id keep curated title/description/notes (and locked tags); only the media file and non-custom metadata refresh. A download replaces a video only when it is a fresh copy of the same source: the old file's name must end in the same `[id]` yt-dlp wrote when it was first downloaded. Anything else, such as a manual import whose source URL was set or edited by hand, is added as a separate video and the old one is left untouched; delete whichever you no longer want (it goes to the trash).

## Watch overflow menu

On library videos, **•••** includes edit, notes, **Change resolution**, **Save a clip…** (YouTube videos; see [Clips](#clips-of-a-stream)), normalize volume, download file, open source (labeled **Open on YouTube** / site when known), and delete.

## Stream → library handoff

While watching a **stream preview** (`/watch?url=…`), you can start a download at the chosen quality. You can change that resolution while the download is still queued or in progress (progress is discarded and the job restarts). When the download **completes**, Horde hands off to the new library item so playback continues from the local file (keeping your place where possible) instead of the temporary stream. The player remounts for that switch so Shaka’s DASH MediaSource is not reused on the file URL.

On the watch page you’ll also see messaging about downloading at the selected resolution and preserving title, notes, and other metadata.

## Clips of a stream

On a **live** or **past** YouTube stream, and on a **downloaded** video that came from YouTube, the **•••** button under the description has **Save a clip…**. For a downloaded video the clip is still fetched from YouTube, at the same times as your copy (a copy that is not the whole video, such as one recorded part-way into a live stream, may not line up). The page scrolls back up to the video and the clip picker opens right under it, so you keep watching while you choose. Pick the start and end (**Use current time** takes the player's position; on a past stream you can also type `h:mm:ss`), then **Save clip**. While the picker is open the chosen start and end are marked on the seek bar (amber handles and the span between them); playback is not moved there. Drag a handle to move that end, and the time in the picker follows; a focused handle also moves with the arrow keys (1 s, or 10 s with Shift). It needs the *download* permission.

The clip is downloaded on its own and saved to your library as a **separate video**, titled like *Stream title (clip 1:02:03–1:05:00)*, with a line at the top of its description saying what it was cut from. It is not treated as a copy of the full stream: you can save several clips of one stream, and still download the whole stream as well. A clip has no source link, so it has no subtitles, SponsorBlock segments or **Change resolution**.

- **Past streams** are cut by yt-dlp on the nearest keyframes, so a clip can start or end a second or two away from the times you picked.
- **Live streams** are cut from the broadcast's own segments while it is still live. You can clip as far back as the player lets you scrub (the DVR window); the positions are matched to the broadcast's timeline from the player's distance behind live, so they can be off by a few seconds. Play the stream before saving a clip of it. If the stream ends before the clip runs, it is cut from the finished video instead; while YouTube is still processing the recording the clip fails with a message, and **Retry** on the Download page tries again later.

The API is `POST /api/downloads/clips` with `url` and either `start_sec`/`end_sec` (a past stream's own timeline) or `start_behind_live_sec`/`end_behind_live_sec` (live). Clips are at most 6 hours long.

## Chapters, subtitles, casting

Those controls live in the shared [video player](player.md): chapters from descriptions, yt-dlp, or optional AI captions, VTT subtitles, SponsorBlock, PiP, Chromecast / AirPlay, and layout modes.

## Related

- [Video player](player.md) — modes, shortcuts, quality, mini player
- [Library](library.md) — continue watching row
- [History](history.md) — watched list and progress expiry
- [Downloads](downloads.md) — queueing the handoff download
- [Playback settings](../settings/playback.md) — related, autoplay, SponsorBlock

# Watching

Horde plays library videos and remote stream previews in the same player shell. Resume, related videos, autoplay, and download handoff are all part of the watch experience.

## Routes

| URL | Mode |
|-----|------|
| `/watch/:id` | Play a **library** video by id |
| `/watch?url=…` | **Stream preview** a remote URL (catalog / paste) without downloading first |

Library playback uses local files (progressive). Stream preview uses adaptive **DASH** when available (see [Player](player.md)).

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

!!! note "Expiry"
    Stale positions are cleared by `progress_expiry_days` (default **14**). The continue-watching *list* only includes recent activity within a fixed **7-day** backend window. See [History](history.md).

## Related videos

When enabled in [Settings → Playback](../settings/playback.md), the watch page shows a **related videos** sidebar (library recommendations / neighbors). Related suggestions improve when AI embeddings are available ([AI features](ai-features.md)): they rank by how similar the videos are as a whole (title, description, tags, then captions), favour the same channel and shared distinctive tags, and push down videos you have already watched.

On a **stream preview** the related list also includes videos from channels you have indexed that are not downloaded yet; each downloaded one is marked **Downloaded** and opens the library copy, the others open as streams. On a **live** stream, the channel's other broadcasts that are live right now come first, marked **Live now**, so switching between a tournament's A and B streams is one click (read from the channel's Streams tab, cached for a few minutes). A stream also gets the AI panel (summary, chat, chapters); see [AI features](ai-features.md#streamed-videos).

## Autoplay related

If **Autoplay related** is on and the play queue is empty when a video ends, Horde shows an up-next overlay with an **8-second countdown**, then starts the suggested related video.

- Cancel or play immediately from the overlay controls
- Turning autoplay off mid-countdown cancels the overlay
- Items already in the [player queue](player.md) advance immediately without the related countdown


## Autoplay the next part

With **Autoplay the next part** on (Settings → Playback, off by default), a library video that ends with an empty queue first looks for the channel's **next upload**. If that upload clearly continues the series, the up-next countdown plays it, downloaded or not ("Next part · not downloaded" on the card); otherwise Horde falls back to a related video as above.

"Clearly continues" is strict, because a wrong guess plays something unrelated. Only the very next upload counts (Shorts, live streams and premieres are skipped), and its title must either repeat the previous one with a number one higher ("Day 12" → "Day 13", "Part 3" → "Part 4") or share the same series tag set off by `|`, `:`, `-` or brackets ("GTA RP | …"). A tag that names the channel, or one the channel puts on more than 40% of its recent uploads (a format such as "| xQc Reacts"), does not count. The next upload is read from the channel's index when the channel is indexed, otherwise from its downloaded videos in publish order. The API is `GET /api/videos/{id}/next-part`.
## Title / description drift

If you customized a library video’s title and a metadata resync finds that the **source (YouTube) title** now differs, the watch page shows a banner:

> Source title changed…

You can adopt the new source title or keep your custom title. This appears when `title_is_custom` is set and `source_title` ≠ current `title`. A similar banner appears for custom descriptions when `source_description` drifts.

Redownload (“Change resolution”) and auto-replace of the same YouTube id keep curated title/description/notes (and locked tags); only the media file and non-custom metadata refresh.

## Watch overflow menu

On library videos, **•••** includes edit, notes, **Change resolution**, normalize volume, download file, open source (labeled **Open on YouTube** / site when known), and delete.

## Stream → library handoff

While watching a **stream preview** (`/watch?url=…`), you can start a download at the chosen quality. You can change that resolution while the download is still queued or in progress (progress is discarded and the job restarts). When the download **completes**, Horde hands off to the new library item so playback continues from the local file (keeping your place where possible) instead of the temporary stream. The player remounts for that switch so Shaka’s DASH MediaSource is not reused on the file URL.

On the watch page you’ll also see messaging about downloading at the selected resolution and preserving title, notes, and other metadata.

## Chapters, subtitles, casting

Those controls live in the shared [video player](player.md): chapters from descriptions, yt-dlp, or optional AI captions, VTT subtitles, SponsorBlock, PiP, Chromecast / AirPlay, and layout modes.

## Related

- [Video player](player.md) — modes, shortcuts, quality, mini player
- [Library](library.md) — continue watching row
- [History](history.md) — watched list and progress expiry
- [Downloads](downloads.md) — queueing the handoff download
- [Playback settings](../settings/playback.md) — related, autoplay, SponsorBlock

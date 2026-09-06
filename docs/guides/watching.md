# Watching

Horde plays library videos and remote stream previews in the same player shell. Resume, related videos, autoplay, and download handoff are all part of the watch experience.

## Routes

| URL | Mode |
|-----|------|
| `/watch/:id` | Play a **library** video by id |
| `/watch?url=…` | **Stream preview** a remote URL (catalog / paste) without downloading first |

Library playback uses local files (progressive). Stream preview uses adaptive **DASH** when available (see [Player](player.md)).

## Resume position

Playback position is stored as `last_position_sec` on the video.

| Behavior | Detail |
|----------|--------|
| **Save interval** | Progress is persisted about every **5 seconds** while playing |
| **Near end** | At **≥ 90%** of duration, progress is **cleared** (treated as finished; next open starts from the beginning) |
| **Resume** | Reopening `/watch/:id` seeks to the saved position when it is meaningful |

Continue watching on the [Library](library.md) and [History](history.md) pages uses the same progress fields.

!!! note "Expiry"
    Stale positions are cleared by `progress_expiry_days` (default **14**). The continue-watching *list* only includes recent activity within a fixed **7-day** backend window. See [History](history.md).

## Related videos

When enabled in [Settings → Playback](../settings/playback.md), the watch page shows a **related videos** sidebar (library recommendations / neighbors). Related suggestions improve when AI embeddings are available ([AI features](ai-features.md)).

## Autoplay related

If **Autoplay related** is on and the play queue is empty when a video ends, Horde shows an up-next overlay with an **8-second countdown**, then starts the suggested related video.

- Cancel or play immediately from the overlay controls
- Turning autoplay off mid-countdown cancels the overlay
- Items already in the [player queue](player.md) advance immediately without the related countdown

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

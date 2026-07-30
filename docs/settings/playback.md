# Playback

Controls under **Settings → Playback** (`?tab=playback`). All of these keys sync through the server [`ui` blob](index.md#three-layer-persistence) unless noted in [All settings](all-settings.md).

## Watch page

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Show description | `showDescription` | `true` | Description block on the watch page |
| Show related videos sidebar | `showRelatedVideos` | `true` | Desktop normal view: recommendations to the right of the player |
| Autoplay related | `autoplayRelated` | `true` | When a video ends and the queue is empty, count down and play a related video (also toggled in player controls) |
| Show undownloaded on channel pages | `showUndownloadedOnChannel` | `true` | Include uploads not yet in the library; off = downloaded only |
| Default stream quality | `defaultStreamQuality` | `auto` | Starting quality for streamed (not downloaded) video |

### Stream quality values

| Value | Label |
|-------|--------|
| `auto` | Auto (ABR within device cap) |
| `2160` | 4K (2160p) |
| `1440` | 1440p |
| `1080` | 1080p |
| `720` | 720p |
| `480` | 480p |

You can still change quality in the player for the current session.

## Subtitles

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Subtitle size | `subtitleSize` | `medium` | `small` \| `medium` \| `large` |

Drag captions on the player to reposition. Placement is stored as:

| Key | Default | Notes |
|-----|---------|--------|
| `subtitleLeft` | `20` | Horizontal position (% from left) |
| `subtitleOffset` | `12` | Vertical position (% from bottom) |

Those two are not separate Settings rows; they sync with the `ui` blob when the player updates them.

## SponsorBlock

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| SponsorBlock enabled | `sponsorBlockEnabled` | `true` | Skip sponsored / non-content segments on YouTube sources |
| Show skip notice | `sponsorBlockShowNotice` | `true` | Toast/notice when a segment is skipped |

## Default playback rate

| Setting | Key | Default | Steps |
|---------|-----|---------|--------|
| Default playback rate | `defaultPlaybackRate` | `1` | `0.25`, `0.5`, `0.75`, `1`, `1.25`, `1.5`, `2`, `2.5`, `3` |

Applied as the starting speed for new playback sessions.

## See also

- [Settings overview](index.md)
- [Video player](../guides/player.md)
- [Watching](../guides/watching.md)
- [Appearance](appearance.md) — backgrounds / chrome while watching (`pauseBackgroundWhileWatching`)
- [All settings](all-settings.md)

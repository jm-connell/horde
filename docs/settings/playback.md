# Playback

Controls under **Settings → Playback** (`?tab=playback`). All of these keys sync through the server [`ui` blob](index.md#three-layer-persistence) unless noted in [All settings](all-settings.md).

## Watch page

| Setting | Key | Default | Notes |
|---------|-----|---------|--------|
| Show description | `showDescription` | `true` | Description block on the watch page |
| Show related videos in sidebar | `showRelatedVideos` | `true` | Desktop normal view: recommendations to the right of the player |
| Autoplay related | `autoplayRelated` | `true` | When a video ends and the queue is empty, count down and play the [next part](../guides/watching.md#autoplay-the-next-part) of a series if there is one, otherwise a related video (also toggled in player controls) |
| Show undownloaded on channel pages | `showUndownloadedOnChannel` | `true` | Include uploads not yet in the library; off = downloaded only |
| Default stream quality | `defaultStreamQuality` | `auto` | Starting quality for streamed (not downloaded) video |

### Stream quality values

| Value | Label |
|-------|--------|
| `auto` | Auto (ABR within device cap) |
| `2160` | 4K |
| `1440` | 1440p |
| `1080` | 1080p |
| `720` | 720p |
| `480` | 480p |

You can still change quality in the player for the current session.

## Autoplay previews on hover

`previewOnHover` (default `true`) plays a muted preview on video cards: on hover with a mouse or trackpad, and on the card centered on screen on phones and tablets. One setting covers both. It does not affect the watch page player.

## Subtitle size

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
| SponsorBlock enabled | `sponsorBlockEnabled` | `true` | **YouTube only** — skip (or prompt to skip) non-content segments; no-op for other sources |
| Skip behavior | `sponsorBlockSkipMode` | `auto` | `auto` jumps to the end of a segment; `prompt` shows a notice with a Skip button |
| Show skip notice | `sponsorBlockShowNotice` | `true` | After an auto-skip, toast with **Go back**. Hidden when skip mode is **Ask to skip** (the prompt *is* the notice) |
| Categories | `sponsorBlockCategories` | see below | Per-category on/off; extra categories are collapsed in Settings |

Playback-only — files on disk are unchanged. Skips can be undone from the skip notification.

### Skip modes

| Value | Behavior |
|-------|----------|
| `auto` | Seek to the end of a matching segment on forward playback |
| `prompt` | Keep playing and show **Skip** until you click it or the segment ends |

### Categories

| Id | Label | Default | Group |
|----|-------|---------|--------|
| `sponsor` | Sponsor | on | Common |
| `selfpromo` | Self-promo | on | Common |
| `interaction` | Interaction | on | Common |
| `intro` | Intro | on | Common |
| `outro` | Outro | on | Common |
| `preview` | Preview / recap | off | Extra |
| `filler` | Filler / tangents | off | Extra |
| `music_offtopic` | Non-music | off | Extra |

Common categories are always listed. Extra categories sit behind **More categories** (with explanation tooltips). Settings search for an extra name expands that list.

Missing keys in an old `ui` blob keep these defaults (existing installs keep the original five categories on).

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

## Hotkeys

**Settings → Playback → Hotkeys** lists every keyboard shortcut. Click an action's key and press a new one to rebind it (++escape++ cancels); a key moves off any other action that used it, so one key never does two things. **Reset** puts one action back on its default, **Reset all hotkeys** all of them. Rebound keys are stored in `hotkeys` (only the changed actions). **Single-character hotkeys** (`playerShortcuts`) turns the letter, symbol and ++space++ keys off. See [Keyboard shortcuts](../reference/keyboard-shortcuts.md).

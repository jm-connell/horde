# Player architecture

Horde does not embed a stock video.js/Plyr skin as the primary experience. Playback is a **custom React player** (`VideoPlayer`) driven by a persistent **PlaybackContext** so watching survives navigation the way a desktop media app would.

## Custom player surface

Library playback uses a native `<video>` element with Horde controls for:

- Standard / theater / windowed (in-page fullscreen) modes
- Subtitles (WebVTT), chapters, SponsorBlock cues
- Speed, volume, seek preview sprites
- Picture-in-Picture and Chromecast hooks
- Queue auto-advance and “play next related”

Keyboard shortcuts are documented in [Keyboard shortcuts](../reference/keyboard-shortcuts.md).

## DOM reparenting for mini-player continuity

When you leave the Watch page, playback continues in a floating **mini player**. That is not a second `<video>` and not a React portal remount.

`PlaybackContext` keeps a stable host node and **`appendChild`s** it between:

- The Watch page dock
- `document.body` for windowed mode
- `document.body` with fixed positioning for the mini player

Moving the same DOM node keeps the media element alive: **no reload, no seek reset, no flicker** from tearing down React trees. Width, position, and mobile vs desktop defaults are applied as styles on that host.

!!! note "Shortcuts in mini mode"
    Global player hotkeys that would fight browsing are suppressed while the mini player is active; see the shortcuts reference.

## Shaka DASH for stream preview

**Downloaded library files** play as progressive media from Horde’s static/range endpoints.

**In-app YouTube stream preview** (watch before download) uses a different path: the backend exposes preview APIs, and the client loads **Shaka Player** for adaptive **DASH** when available. If DASH is unsupported or fails critically, playback falls back to a progressive (≤720p-class) proxy URL.

That split keeps archive watching simple (one file, one codec path) while preview can adapt bitrate on live extracts. Subtitle handling differs slightly under MSE/Shaka (cues rendered via overlays / text tracks as needed) compared to native library playback.

## Casting and CORS

Cast receivers fetch media cross-origin; the API enables wide CORS for GET/HEAD/Range — see [No authentication](no-auth.md).

## Related

- [Watching](../guides/watching.md)
- [Video player](../guides/player.md)
- [Frontend architecture](../architecture/frontend.md)

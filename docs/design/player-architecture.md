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

**In-app YouTube stream preview** (watch before download) uses a different path: the backend exposes preview APIs (`stream_preview` + `api/preview.py`), and the client loads **Shaka Player** via `useShakaDash` for adaptive **DASH** when available. If DASH is unsupported or fails critically, playback falls back to a progressive (≤720p-class) proxy URL.

That split keeps archive watching simple (one file, one codec path) while preview can adapt bitrate on live extracts. Subtitle handling differs slightly under MSE/Shaka (cues rendered via overlays / text tracks as needed) compared to native library playback.

After player refactors, use the [Video player smoke checklist](../reference/video-player-smoke.md).

## Casting and CORS

Cast receivers fetch media cross-origin; the API enables wide CORS for GET/HEAD/Range — see [No authentication](no-auth.md).

## Manual stability checklist

After player or playback changes, verify:

1. Desktop theater: toggle on, navigate away to mini, expand back — theater layout should still apply if that mode is saved.
2. Hold-to-2x: mouse and touch — release restores previous rate; short tap still toggles play on mobile.
3. Mini player on phone-width: play/pause and close hit targets (≥44px) remain usable.
4. Library file playback and one DASH stream preview each play once without media errors.

## Related

- [Watching](../guides/watching.md)
- [Video player](../guides/player.md)
- [Frontend architecture](../architecture/frontend.md)

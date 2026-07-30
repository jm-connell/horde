# Video player

Horde’s player is shared across library watch and stream preview. It supports layout modes, keyboard shortcuts, adaptive quality (stream), subtitles, chapters, scrub sprites, casting, SponsorBlock, and a session play queue.

## Layout modes

| Mode | Behavior |
|------|----------|
| **Standard** | Inline player in the watch page layout |
| **Theater** | Wider player, reduced chrome |
| **Windowed** | Immersive fullscreen-style layout (page scroll locked) |

!!! important "Mobile"
    On mobile viewports, Horde **forces standard** mode — theater and windowed are desktop-only.

Leave windowed with ++escape++ (or the UI control).

## Keyboard shortcuts

Shortcuts apply when focus is not in a text field:

| Key | Action |
|-----|--------|
| ++space++ or ++k++ | Play / pause |
| ++c++ | Toggle subtitles |
| ++t++ | Theater mode |
| ++f++ | Windowed mode |
| ++escape++ | Exit windowed |
| ++arrow-left++ / ++arrow-right++ | Seek **−5s** / **+5s** |
| ++arrow-up++ / ++arrow-down++ | Volume **±5%** |
| <kbd>&gt;</kbd> or <kbd>.</kbd> | Speed up |
| <kbd>&lt;</kbd> or <kbd>,</kbd> | Speed down |
| ++n++ | Next chapter |

See also the [keyboard shortcuts reference](../reference/keyboard-shortcuts.md).

## Playback speed

Supported speeds: **0.25× through 3×** (steps: 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3).

**Hold to 2×:** press and hold the play surface for **250ms** to temporarily play at 2×; release to restore the previous speed.

Default speed is configurable under [Settings → Playback](../settings/playback.md).

## Subtitles

External **VTT** tracks (downloaded captions / uploaded) can be toggled with ++c++. Cue styling supports size options in settings. Subtitle overlays are **draggable** so you can reposition them on screen.

## Chapters

Chapters are parsed from timestamp lines in the video **description** (YouTube-style). When two or more valid ascending timestamps exist, chapter markers appear on the scrubber; ++n++ jumps to the next chapter. Timestamp lines may be hidden from the description panel when chapters are shown separately.

## Scrub sprites

For library videos with generated sprite sheets, hovering the scrubber shows a **preview thumbnail** for that time. Sprites are lazy-loaded during playback.

## Stream quality (DASH)

Stream preview uses adaptive **DASH** (Shaka) when available. Quality choices:

| Choice | Meaning |
|--------|---------|
| **Auto** | ABR within capability |
| **2160** | Cap at 4K |
| **1440** | Cap at 1440p |
| **1080** | Cap at 1080p |
| **720** | Cap at 720p |
| **480** | Cap at 480p |

Library files typically play as progressive local media; if DASH fails on a stream, Horde falls back to a progressive URL when possible.

## Picture-in-Picture

Use the PiP control (or browser PiP) to keep video visible while browsing. When PiP (or iOS native fullscreen) owns the pixels, Horde switches to native text tracks so captions still work.

## Mini player

Navigate away from the watch page while a session is active and the player becomes a **floating mini player**:

- **Drag** to reposition
- **Resize** width between **160px and 960px**
- Session starts bottom-right after close/reopen of the mini shell

Floating UI (download panel / queue) avoids overlapping the mini player bounds when possible.

## Casting

| Target | Notes |
|--------|-------|
| **Chromecast** | Cast library/stream media when the Cast SDK is available |
| **AirPlay** | Show the AirPlay picker on supported Safari / Apple environments |

Remote playback syncs position where the cast session reports it; ending a cast session can restore local position.

## SponsorBlock

When enabled in [Settings → Playback](../settings/playback.md), SponsorBlock segments are skipped during playback (playback-only — files on disk are unchanged). Skips can be **undone** from the skip notification / control so you can watch a segment you didn’t want skipped.

## Play queue

The watch queue is stored in **`sessionStorage`** under the key `horde.queue`.

- Queue from playlists (**Play all**), related picks, or UI queue actions
- Queue advances immediately when the current item ends
- Closing the browser tab clears `sessionStorage` (queue is session-scoped)

## Related

- [Watching](watching.md) — routes, resume, autoplay, handoff
- [Playlists](playlists.md) — play all into the queue
- [Playback settings](../settings/playback.md)
- [Player architecture](../design/player-architecture.md)
- [Keyboard shortcuts](../reference/keyboard-shortcuts.md)

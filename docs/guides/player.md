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

On phones, a tap on the picture shows or hides the controls, and the large button in the middle of the picture plays and pauses.

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

These are the defaults; rebind them under **Settings → Playback → Hotkeys**. See also the [keyboard shortcuts reference](../reference/keyboard-shortcuts.md).

## Playback speed

Supported speeds: **0.25× through 3×** (steps: 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3).

**Hold to 2×:** press and hold the play surface for **250ms** to temporarily play at 2×; release (including outside the video / on blur) restores the previous speed. On phones a short tap shows or hides the controls instead.

Default speed is configurable under [Settings → Playback](../settings/playback.md).

Theater mode is remembered in playback settings and should survive leaving watch for the mini player and expanding back on desktop.

## Subtitles

External **VTT** tracks (downloaded captions / uploaded) can be toggled with ++c++. Cue styling supports size options in settings. YouTube auto captions (word-timed) clear 2.5 seconds after the last word, so a line does not stay up through a long silence; manual subtitles keep their own timing. Subtitle overlays are **draggable** so you can reposition them on screen. On phones they sit centred near the bottom, sized to the player, and are not draggable.

## Chapters

Chapters come from, in order: timestamp lines in the video **description**, yt-dlp native chapters saved at download, or an optional **AI** pass over captions when those are missing (queued after download, or from a Watch button). When two or more valid ascending timestamps exist, chapter markers appear on the scrubber; ++n++ jumps to the next chapter. Timestamp lines may be hidden from the description panel when chapters are shown separately. Stream preview still uses description timestamps only.

## Resizing the panels under the video

On desktop, the AI summary, the AI chat input, the description and the chapters can be resized: hover a panel and drag the faint bar on its bottom edge (on the chat box this sizes the message input), or drag the gap between the description and chapters to change their widths. Double-click a handle to go back to the default size; with a handle focused, the arrow keys nudge it. Sizes are remembered per device (in the browser), not per account, and apply to every video. The description and the chapters beside it share one height.

## Scrub sprites

For library videos with generated sprite sheets, hovering the scrubber shows a **preview thumbnail** for that time. Sprites are lazy-loaded during playback. A **streamed** video that is not downloaded uses YouTube's own storyboard images instead (loaded from YouTube, like its thumbnails), when YouTube has them: finished videos and past broadcasts do, a broadcast that is still live does not.

## Stream quality (DASH)

Stream preview uses adaptive **DASH** (Shaka) when available. Quality choices:

| Choice | Meaning |
|--------|---------|
| **Auto** | ABR within what this device decodes smoothly (below) |
| **2160** | Cap at 4K |
| **1440** | Cap at 1440p |
| **1080** | Cap at 1080p |
| **720** | Cap at 720p |
| **480** | Cap at 480p |

Library files typically play as progressive local media; if DASH fails on a stream, Horde falls back to a progressive URL when possible.

On a live broadcast a new quality takes over a few seconds after you pick it, where the already buffered part ends.

YouTube offers H.264 only up to 1080p; 1440p and 4K come as AV1 or VP9 (every video above 1080p has VP9, only some have AV1), and both are heavy to decode without a hardware decoder. So on **Auto**, a video that isn't downloaded plays:

1. AV1, where your browser reports hardware AV1 decoding and the video has AV1;
2. otherwise VP9, where your browser reports hardware VP9 decoding and the video has VP9 above 1080p;
3. otherwise H.264, up to 1080p.

Auto goes only as high as the codec that loaded decodes in hardware. A live broadcast goes above 1080p only where VP9 decodes in hardware.

Every quality your device can decode at all stays in the quality menu, so 1440p and 4K are there even when Auto stays at 1080p. Picking one loads that video again in the codec that has it (VP9 where it decodes that quality in hardware, otherwise AV1 if your browser supports AV1, otherwise VP9) for as long as you watch it, and picking **Auto** goes back. A quality whose codecs your browser says it cannot decode at all (VP9 and AV1 on an older iPhone, say) is not listed.

Chrome on Linux has no hardware video decoding by default, so there Auto stays on H.264 at 1080p; the higher qualities are in the menu, and playing them is up to your processor.

When the browser keeps dropping frames for several seconds, Horde lowers the quality ceiling one step ("Reduced quality for smooth playback") for the rest of that video, and if the frames were dropping in AV1 or VP9 it skips that codec for the rest of that video and plays another codec your device decodes in hardware if the video has one, otherwise H.264 (a quality you picked by hand falls back straight to H.264); a live broadcast lowers its quality in place without reloading; the next video starts on its full ladder again, and picking a quality other than **Auto** in the menu lifts it. This only happens while Horde's window has focus: frames dropped while you are in another window, such as a fullscreen game on the other monitor, say nothing about what your device can play. Shaka's own bandwidth-based quality changes on **Auto** still apply.

A stream that freezes restarts itself. When it should be playing but the clock has stood still (5 seconds with video buffered, 20 seconds while it waits for video and none arrives), the player reloads the stream at the same position, staying in fullscreen; after two reloads that do not get it moving it switches to the progressive URL. This covers Safari on iPad and iPhone leaving a stream stuck after the sound moves between devices (AirPods switching to a phone and back).

## Picture-in-Picture

Use the PiP control (or browser PiP) to keep video visible while browsing. When PiP (or iOS native fullscreen) owns the pixels, Horde switches to native text tracks so captions still work.

## Mini player

Navigate away from the watch page while a session is active and the player becomes a **floating mini player**:

- **Drag** to reposition
- **Resize** width between **160px and 960px**
- Session starts bottom-right after close/reopen of the mini shell
- Stays pinned to that corner when the window resizes (a dragged player is clamped on-screen)

Floating UI (the feed's download toast, the queue) tracks the mini player on resize and avoids overlapping it when possible.

## Casting

| Target | Notes |
|--------|-------|
| **Chromecast** | Cast library/stream media when the Cast SDK is available |
| **AirPlay** | Show the AirPlay picker on supported Safari / Apple environments |

A Chromecast gets a video's H.264 copy when it has one ([Playback compatibility](downloads.md#compatibility-codecs)), because most Chromecasts cannot play AV1; without a copy it gets the original file. If casting AV1 videos fails, turn on **AV1 + H.264 copy** in Settings → Library.

Remote playback syncs position where the cast session reports it, and while a Chromecast plays, the position it reports is saved to your account like local playback (every few seconds), so your other devices resume from where the TV got to. Ending a cast session restores that position locally. AirPlay plays through the page's own player, so its progress is saved as usual.

## SponsorBlock

When enabled in [Settings → Playback](../settings/playback.md), SponsorBlock segments apply during **YouTube** library playback (playback-only — files on disk are unchanged). Non-YouTube sources ignore the setting. Stream preview does not use SponsorBlock.

You can turn individual categories on or off (sponsors, self-promo, interaction, intro, outro, plus extra types such as filler). **Auto skip** jumps over matching segments; **Ask to skip** shows a notice with a **Skip** button instead. Auto-skips (and skips you confirm from the prompt) can be **undone** with **Go back** so you can watch a segment you did not want skipped.

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

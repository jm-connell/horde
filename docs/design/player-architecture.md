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

Moving the same DOM node keeps the media element alive: **no reload, no seek reset, no flicker** from tearing down React trees. Width, position, and mobile vs desktop defaults are applied as styles on that host. Until the user drags it, the mini player is pinned with `right`/`bottom` so it stays in the corner when the window resizes; a dragged frame uses `left`/`top` and is clamped back on-screen. Floating channel-feed UI (download toast, queue) reads those live bounds and repositions with the viewport.

!!! note "Shortcuts in mini mode"
    Global player hotkeys that would fight browsing are suppressed while the mini player is active; see the shortcuts reference.

## Shaka DASH for stream preview

**Downloaded library files** play as progressive media from Horde’s static/range endpoints. After download, Horde remuxes to **MP4 + AAC + faststart**. The default archive **copies** the video bitstream (AV1 stays AV1).

Each video can have two files: the **original** and an optional ≤1080p **H.264 sidecar** (`<stem>.horde-h264.mp4`). The client, not the server, chooses. It asks `MediaCapabilities.decodingInfo` about the original's real codec string (stored from ffprobe) and plays the original if that is smooth, the sidecar via `?rendition=compat` if the original is unsupported or rough and a copy exists. With no playable file, `CompatGate` covers the player: in `sidecar` mode it requests the copy automatically and polls progress, otherwise it offers **Create compatible copy** or **Try playing the original anyway**. An original that fails before it has played falls back the same way. One that fails part-way through was decoding fine (a phone can take the decoder away for a call or while the app is in the background), so the player loads it again at the playhead and falls back only when it keeps failing at the same spot. [Offline saves](../guides/offline.md) run the same choice and store that rendition.

Copies are produced ahead of time (a YouTube H.264 download or an ffmpeg encode), so this is still **not** a live per-client transcode, HLS ladder, or adaptive stream. See [Playback compatibility](../guides/downloads.md#compatibility-codecs).

**In-app YouTube stream preview** (watch before download) uses a different path: the backend exposes preview APIs (`stream_preview` + `api/preview.py`), and the client loads **Shaka Player** via `useShakaDash` for adaptive **DASH** when available. If DASH is unsupported or fails critically, playback falls back to a progressive (≤720p-class) proxy URL. Preview → library download handoff remounts the player (and the `<video>` element) so the file URL is never applied to an element that still has Shaka’s MediaSource attached.

Opening a stream waits for a yt-dlp lookup (`/api/preview/meta`) and then the manifest's CDN probes (`/api/preview/manifest`), one after the other; the server caches both. A **hover warm-up** starts them early: when the mouse rests 400 ms on a stream link, a mouse button goes down on it, or the keyboard focuses it, `StreamWarmer` (`queries/streamWarmup.ts`, one per `QueryClient`) loads the details and then requests the manifest, through the existing endpoints (no warm endpoint). The server runs YouTube lookups one at a time, so a rest asks with `background=true`, which queues behind the videos people are opening, and sends it outside the watch page's query: a click while it waits sends the page's own full-priority request instead of joining it, and the answer fills that query only if nothing touched it since the request went out and no page shows it. A mouse button going down asks at full priority through the watch page's query, since the click follows. One warm-up runs at a time and only the newest waiting one is kept; touch never warms. The watch page uses warmed details as they are (a refetch on mount would start the stream twice) and marks them stale when left. The server builds a manifest once per URL at a time: a request that finds a build under way waits for it, because two concurrent builds would each store a new token and the second would evict the one a player already holds.

Shaka keeps one codec's ladder per load (`preferredVideo` drops the other codecs' variants), and YouTube's H.264 stops at 1080p. The server's manifest (`build_dash_manifest`) offers up to three video sets in the order `av01`, `vp09`, `avc1`. The `vp09` set is `video/webm` (SDR, profile 0), taken only from a video whose VP9 top height is above 1080p, so a 1080p video's manifest is unchanged; its init and index ranges come from the WebM header (`_probe_webm_ranges` reads the EBML elements up to `Cues`). A manifest for a 4K video took about 0.22 s longer at the median (five videos).

`streamLoadLimits` (`hooks/useShakaDash.ts`) decides each load and returns Shaka's codec preference in order, from what `decodeCapability` reports as hardware decoding (`powerEfficient`): `["av01", "vp09", "avc1"]` where both are hardware, `["av01", "avc1"]`, `["vp09", "avc1"]`, or `["avc1"]`. Shaka falls through the list only when a codec has no variants, so a video with no AV1 plays VP9 on a hardware-AV1 device. Once a video has loaded, `loadedCodecCeiling` caps Auto at the hardware height of the codec that loaded (the manifest, not the list, decides which that was). `qualitiesInOtherCodecs` reads the manifest text for the qualities above the loaded ladder that only AV1 or VP9 offer and lists them in the menu, each with the codec to load for it (VP9 where it decodes in hardware, else AV1); a quality whose codecs the browser reports as unsupported is left out. Picking one reloads with that codec (`pickedCodec`), and Auto goes back. A frame-drop step-down skips the codec that was dropping frames (`skipCodecs`: AV1 or VP9, never H.264, never for live) for the rest of that video. Both live in one per-stream state (`useStreamQuality`): a reload of the same stream keeps them, the next stream starts afresh, and nothing about them is stored in the browser. The reasons are in [ADR 0040](../adr/0040-streams-choose-a-codec-by-hardware-decoding.md).

That split keeps archive watching simple (one file per rendition, no server work while watching) while preview can adapt bitrate on live extracts. Subtitle handling differs slightly under MSE/Shaka (cues rendered via overlays / text tracks as needed) compared to native library playback.

After player refactors, use the [Video player smoke checklist](../reference/video-player-smoke.md).

## Casting and CORS

Cast receivers fetch media cross-origin; only the media routes send CORS headers (GET/HEAD/Range) — see [Security](../ops/security.md).

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

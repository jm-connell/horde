# 0040: A stream plays AV1, then VP9, then H.264, by what the device decodes in hardware

Status: Accepted

## Context

A video that isn't downloaded should start smoothly on every device and still reach 1440p or 4K where the device can decode it without dropping frames. Streams could use only H.264 (YouTube stops it at 1080p) and AV1, which is smooth above 1080p only with a hardware decoder. Software decoding of AV1 or VP9 drops frames at the start of every high-quality video. The design is in the [VP9 stream tier design](../superpowers/specs/2026-11-24-vp9-stream-tier-design.md). Measured on 34 varied videos:

- All 16 videos above 1080p had a full VP9 ladder; 6 of those had no AV1, so they streamed at 1080p at most.
- On 8 videos, all at 1080p or below, VP9 stops at 360p while H.264 reaches 720p or 1080p, so VP9 cannot stand in for H.264 at 1080p and below.
- YouTube serves VP9 for direct download only as WebM, with a fixed layout (header, `Cues`, then clusters). yt-dlp reports it as just `vp9`, without byte ranges.
- `MediaCapabilities.decodingInfo().powerEfficient` is the usable signal for hardware decoding in Chrome, Firefox and Safari; `smooth` is not (Firefox always says true). Chrome on Linux has no hardware video decoding by default, so it reports none.
- Adding the WebM set made the manifest of a 4K video 0.22 s slower at the median (five videos), within the 0.5 s budget.

Shaka keeps one codec's ladder per load, so the codec is chosen per load.

## Decision

- **One codec per load, ordered by hardware decoding.** The server adds a `vp09` WebM set (SDR, profile 0) between `av01` and `avc1`, only when the video's VP9 top height is above 1080p. The client gives Shaka its codec preference as the codecs this device decodes in hardware, in the order AV1, VP9, H.264. The probe is `powerEfficient` through the Media Capabilities API.
- **Auto stops at the hardware height of the codec that loaded**, since the manifest, not the preference list, decides which loaded.
- **The menu lists every quality the device can decode at all.** Picking one that another codec has loads that codec for the rest of the video (VP9 where it decodes that quality in hardware, else AV1 if the browser supports AV1, else VP9); Auto goes back. A quality only codecs the browser reports unsupported is not listed (the abandoned alternative listed it and silently played H.264).
- **A step-down skips a codec for that video only.** Frames dropped on AV1 or VP9 skip that codec for the rest of the video, never persisted and never for live, because frames dropped by a game on another monitor say nothing about the device.
- **Rejected: a mixed ladder** (H.264 up to 1080p, VP9 above, in one load). It needs fewer VP9 representations, but ABR would switch codec at 1080p on every bandwidth change, and Shaka's codec switching has stalled before on VOD. **Rejected: VP9 as a menu entry only**, because Auto would still stop at 1080p on most devices.

## Consequences

- Videos with no AV1 reach 1440p and 4K on devices with hardware VP9 (Intel from 2016, NVIDIA from the GTX 950, AMD from Raven Ridge, Apple M1 and later). The manifest is the same for every device and now carries the WebM set for videos with VP9 above 1080p; an H.264-only device plays as before because the player filters that set out, and a hardware-AV1 device still plays AV1.
- Chrome on Linux has no hardware decoding by default, so Auto stays on H.264 at 1080p there; higher qualities are in the menu.
- The server reads one more file head per VP9 representation of a video above 1080p, and a WebM without `Cues` before its first cluster fails that representation, as an MP4 without `sidx` does. If every VP9 probe fails the manifest has no VP9 set.
- A device with hardware VP9 but no AV1 plays VP9 on a video whose AV1 ladder stopped lower; none was seen, and the menu would still list the higher VP9 qualities.
- Downloads, the compatibility renditions, live broadcasts (which already use VP9 above 1080p through the HLS proxy), HDR VP9 and casting are unchanged.

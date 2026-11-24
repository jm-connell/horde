# VP9 as the middle step for streams: design

Date: 2026-11-24. Status: proposed, awaiting approval.

## Intent

A video that isn't downloaded should start smoothly on every device and still reach 1440p or 4K wherever the device can decode it without dropping frames. Today the only codecs a stream can use are H.264 (YouTube stops it at 1080p) and AV1 (smooth above 1080p only with a hardware decoder, which only recent devices have). VP9 fills the gap: far more devices decode it in hardware, and YouTube offers it on every video above 1080p.

This covers streams of videos that are not downloaded (the DASH preview). Downloads are a separate piece, to be considered later.

## What was measured

34 varied videos, read with Horde's own yt-dlp options; two of them checked against the format list youtube.com gives its own web player.

- H.264 is on every video and never above 1080p.
- All 16 videos above 1080p had a full VP9 ladder (144p to the top height).
- 6 of those 16 had no AV1 at all (very long videos, tiny channels, fresh uploads). Today they stream at 1080p at most.
- Where a video had AV1, it reached the video's top height on all 22; no AV1 ladder stopped below the VP9 one.
- On 8 of 34 videos, all at 1080p or below, VP9 stops at 360p while H.264 goes to 720p or 1080p. VP9 cannot be relied on at 1080p and below.
- YouTube serves VP9 for direct download only in WebM (video only, itags 242-248, 271, 302-315). Its layout is fixed: EBML header, then inside the Segment: SeekHead, Info, Tracks, Cues, then the Clusters. Cues started at byte 219 and 221 in the two files read; its size was 2 KB for a 10 minute video and 164 KB for a 12 hour one.
- yt-dlp reports the codec of these formats as just `vp9` and does not give the init or index byte ranges.
- Hardware VP9 decoding: Intel from Kaby Lake (2016-17), NVIDIA GTX 950/960 and 10-series on, AMD from Raven Ridge, Apple M1 and later. Hardware AV1: Intel Tiger Lake on, RTX 30 on, most RX 6000 on, Apple M3 / A17 Pro on.
- `MediaCapabilities.decodingInfo().powerEfficient` is the usable signal for hardware decoding in Chrome, Firefox and Safari. `smooth` is not: Firefox always answers true and Chrome answers true with no history.
- Chrome on Linux has no hardware video decoding by default, so it reports no hardware VP9 or AV1.

## Goals

- On Auto, a stream plays AV1 where AV1 decodes in hardware, otherwise VP9 where VP9 decodes in hardware and the video offers it above 1080p, otherwise H.264 up to 1080p.
- 1440p and 4K become available on videos that have no AV1.
- Every quality the device can decode at all stays in the quality menu; picking one plays it. A quality whose only codecs the browser reports as unsupported (`supported: false`, such as VP9 and AV1 on an older iPhone) is not listed. (My call; the paused branch lists them and silently plays H.264.)

## Non-goals

- Downloads, the playback compatibility modes and the setup wizard.
- Live broadcasts (they already use VP9 above 1080p through the HLS proxy).
- VP9 profile 2 (HDR) formats.
- Casting.

## Anti-goals

- No regression for a device that plays today's stream well: an H.264-only device gets exactly today's manifest behaviour, and a hardware-AV1 device still plays AV1.
- Nothing learned from dropped frames outlives the video it happened on (a game on the other monitor drops frames that say nothing about the device).
- Opening a stream must not get noticeably slower. Budget (my call): the manifest for a video above 1080p takes at most 0.5 s longer at the median than today, measured on five such videos. If more probe workers and leaving out 144p/240p do not meet it, stop and report; probing VP9 lazily or a second manifest are out of scope here.

## Constraints

- This builds on the uncommitted work in the `claude/stream-warmup-quality-cap` branch (Jon: use it if it is good work worth continuing. It is: hardware-only AV1 on Auto and a step-down that ends with the video are both things this design needs, so it is finished and merged first as its own change, and this is built on top) (`streamLoadLimits`, per-stream `StreamQualityState`, `qualitiesOnlyInAv1`, the VP9 probe in `decodeCapability`). That work lands first; this design changes those pieces.
- Shaka keeps one codec's ladder per load (`preferredVideo` drops the other codecs' variants), so the codec is chosen per load and changing it means loading the stream again.
- The preview is SegmentBase DASH over single-file URLs proxied by `/api/preview/media`; each representation needs an init range and an index range, found by reading the head of the file.

## Approaches

1. **One codec per load, chosen by hardware decoding (chosen).** The server adds a VP9 AdaptationSet; the client orders Shaka's codec preference from what the device decodes in hardware. It extends what the paused branch already does for AV1 and H.264, and a codec's whole ladder is available to ABR.
2. **A mixed ladder: H.264 up to 1080p and VP9 above, in one load**, as live does. It needs fewer VP9 representations, but ABR would switch codec at the 1080p boundary on every bandwidth change, and Shaka's codec-switching path is the one that has stalled before on VOD. Rejected for the risk to the stable player.
3. **Leave the server alone and show VP9 only as a menu entry.** Cheap, but Auto would still stop at 1080p on most devices, which is the problem to solve. Rejected.

Jon chose to do streaming first; approach 1 is the proposal for his approval.

## Design

### Server (`services/stream_preview.py`)

- `_pick_adaptive_formats` also keeps VP9 video-only formats: `ext == "webm"`, `vcodec` starting `vp9` or `vp09`, direct https, no fragments, SDR only (profile 0). Codec family `vp09`.
- **The VP9 ladder is included only when its top height is above 1080p.** At 1080p and below it adds nothing a device can't get from H.264, the hardware probe says nothing about VP9 there, and it would add range probes to every manifest. When included, the whole ladder is included, so ABR can step down inside VP9. (Builder's call: the lowest steps, 144p and 240p, may be left out if the H.264 ladder is trimmed the same way today.)
- A WebM range probe beside `_probe_mp4_ranges`: read the head of the file, walk the EBML elements to the Segment's `Cues` element, and return `init_range = 0..(Cues start - 1)` and `index_range = Cues start..Cues end`. Only the Cues element's header has to be inside the window, not its body. Duration comes from the Segment `Info` element (`Duration` x `TimecodeScale`). A file with no Cues before the first Cluster fails that representation, as an MP4 without `sidx` does today.
- Codec string: yt-dlp gives `vp9`; reuse the rule in `live/sessions._vp9_codecs` (move it somewhere both can import) to produce `vp09.00.LL.08` from the pixel rate.
- `build_dash_manifest` emits the `vp09` set with `mimeType="video/webm"`. Order: `av01`, `vp09`, `avc1`. Audio stays the AAC MP4 set. The segment-alignment attributes are written only when boundaries are known; for WebM they may be omitted rather than parsing Cues bodies.
- `/api/preview/media` serves a WebM representation with `video/webm`.
- If every VP9 probe fails, the manifest is built without the set (as with any failed representation today).

### Client

- `decodeCapability` already reports `maxVp9Efficient` (hardware VP9 at 1440p / 2160p in WebM). No change beyond what the load needs.
- `streamLoadLimits` returns an ordered codec preference instead of `preferAv1`:
  - hardware AV1: `["av01", "vp09", "avc1"]` when VP9 is also hardware-decoded, else `["av01", "avc1"]`;
  - hardware VP9 only: `["vp09", "avc1"]`;
  - neither: `["avc1"]`.
  Shaka falls through the list only when a codec has no variants at all. A video whose AV1 ladder stopped below its VP9 one was not seen; if one turns up, the higher VP9 qualities are in the menu like any other-codec quality, and Auto stays on AV1. So a video with no AV1 plays VP9 on a hardware-AV1 device, and a video whose manifest has no VP9 set plays H.264 on a hardware-VP9 device.
- Auto's ceiling above 1080p is the hardware height of the codec that loaded (`maxAv1Efficient` or `maxVp9Efficient`), as the branch does for AV1.
- The quality menu: `qualitiesOnlyInAv1` becomes "qualities only another codec has", read from the manifest text for both `av01` and `vp09`. Picking one loads the stream again with the codec that has it; when both have it, VP9 where VP9 decodes in hardware, otherwise AV1 (today's behaviour). Picking Auto goes back to the hardware order.
- The frame-drop step-down: `blacklistAv1` becomes the codec family that was dropping frames; the reload skips that family for the rest of the video. It still ends with the video.

### What a viewer sees

| Device | Video has AV1 and VP9 to 4K | Video has VP9 to 4K, no AV1 | Video tops out at 1080p |
|---|---|---|---|
| Hardware AV1 (and VP9) | AV1 to 4K | VP9 to 4K (today: H.264 1080p) | as today |
| Hardware VP9 only | VP9 to 4K (today: H.264 1080p) | VP9 to 4K (today: H.264 1080p) | H.264 (as today) |
| Neither | H.264 1080p; 1440p/4K in the menu | H.264 1080p; 1440p/4K in the menu (today: not offered) | H.264 (as today) |

## Checks

- Backend: unit tests for the EBML walk (the two layouts above, a truncated window, no Cues); `TestClient` tests that a VP9-to-4K video yields a `video/webm` set with ranges and that a 1080p video's manifest is unchanged from today.
- Frontend: vitest for the codec order, the Auto ceiling and the menu list in each row of the table above; the existing e2e stream specs stay green, plus one spec where a fake VP9 set is preferred when the probe reports hardware VP9.
- Real check: a 4K video with no AV1 (`FwNqnodc9eg`) and one with both (`aqz-KE-bpKQ`) in Chrome with hardware VP9, Firefox on Linux, and Safari on a Mac; seek, let ABR settle, pick 4K by hand.
- Manifest time for a 4K video before and after, reported in the PR.

## Left to the builder

- Where the shared VP9 codec-string helper lives.
- Whether to parse Cues bodies for segment alignment.
- Probe concurrency (6 workers today) if the extra representations slow the manifest.
- Docs in the same change: `docs/guides/player.md`, `docs/design/player-architecture.md`, `CHANGELOG.md`, and a short ADR for "streams choose a codec by hardware decoding".

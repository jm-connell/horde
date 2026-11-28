# VP9 Stream Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stream of a video that isn't downloaded plays AV1 with hardware AV1, otherwise VP9 with hardware VP9 when the video has VP9 above 1080p, otherwise H.264 up to 1080p.

**Architecture:** The DASH preview manifest gains a `video/webm` VP9 AdaptationSet for videos whose VP9 goes above 1080p, with init and index ranges read from the WebM header. The player turns the device's hardware-decode probe into an ordered Shaka codec preference per load, lists qualities other codecs have in the menu, and steps down by codec family for the rest of that video only.

**Tech Stack:** Python 3.14 / FastAPI (`backend/app/services/stream_preview.py`), React + TypeScript + Shaka Player 5 (`frontend/src/hooks/useShakaDash.ts`), pytest, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-24-vp9-stream-tier-design.md`

## Precondition

The uncommitted work in the `claude/stream-warmup-quality-cap` worktree (`/home/jon/horde/.claude/worktrees/horde-audio-desync-bb8e91`) is finished, merged to `main` as its own change, and this branch is rebased onto it. Every frontend task below edits names that work introduces (`streamLoadLimits`, `StreamQualityState`, `StreamDowngrade`, `qualitiesOnlyInAv1`, `maxVp9Efficient`). Do not start Task 3 before it is in. Tasks 1 and 2 touch only code that work leaves alone, apart from a `priority` parameter on `_extract_preview_info`.

## Global Constraints

- VP9 is added only when the video's VP9 top height is above 1080p; a video at 1080p or below gets a manifest byte-for-byte the same as before this change (token aside).
- VP9 profile 0 (SDR, 8 bit) only: skip formats whose `dynamic_range` is not `SDR`/`None` or whose `vcodec` starts `vp09.02` / `vp9.2`.
- Live streams, downloads, casting: unchanged.
- Nothing learned from dropped frames is written to `localStorage` or outlives the video.
- Manifest for a video above 1080p: at most 0.5 s slower at the median than before, over five such videos. If not met after raising probe workers and leaving out 144p/240p VP9, stop and report.
- AdaptationSet order in the manifest: `av01`, `vp09`, `avc1`.
- Project rules in `CLAUDE.md` apply (no silent `except`, mypy at zero, `eslint --max-warnings 0`, docs in the same change, small commits).

## Review Focus

1. A WebM whose `Cues` header is past the first probe window (a server that puts a large `Void` or `Tags` first): the probe grows the window like the MP4 one, then fails only that representation. Test in Task 1.
2. Every VP9 probe fails (YouTube 403): the manifest is still served, without the VP9 set. Test in Task 2.
3. A browser that reports VP9 as `supported: false` (older iPhone): 1440p/4K are not in the menu, and the stream plays H.264. Test in Task 4.
4. Frames drop on VP9 on a hardware-VP9 device: the reload skips `vp09`, plays H.264, and the next video loads VP9 again. Test in Task 4.
5. A hardware-AV1 device with no hardware VP9 (not seen in practice) on a video with no AV1: H.264 on Auto, VP9 qualities in the menu. Test in Task 3.

---

### Task 1: Read a WebM file's init and index ranges

**Files:**
- Modify: `backend/app/services/stream_preview.py` (beside `_probe_mp4_ranges`)
- Test: `backend/tests/test_stream_preview_webm.py` (new)

**Interfaces:**
- Produces: `_find_webm_ranges(data: bytes) -> tuple[str, str, float | None] | None` returning `(init_range, index_range, duration_sec)`, `None` when the window is too small to contain the `Cues` header; raises `RuntimeError("WebM stream has no Cues index (cannot build DASH)")` when a `Cluster` is reached first. `_probe_webm_ranges(direct_url: str, headers: dict[str, str]) -> tuple[str, str, dict[str, Any]]` with the same return shape as `_probe_mp4_ranges`; its dict has `timescale=0`, `earliest_presentation_time=0`, `duration_sec`, `boundaries=[]`.

- [ ] **Step 1: Write failing tests.** Build fixtures with a small helper `_webm(*, cues_size: int, void_before: int = 0, duration: float | None = 635.0, cues: bool = True) -> bytes` that writes EBML (`1A45DFA3`), Segment (`18538067`, 8-byte size), SeekHead (`114D9B74`), Info (`1549A966`, with TimecodeScale `2AD7B1` = 1_000_000 and Duration `4489` as an 8-byte float in milliseconds), Tracks (`1654AE6B`), optional Void (`EC`), Cues (`1C53BB6B`), Cluster (`1F43B675`).

```python
def test_ranges_end_where_cues_starts():
    data = _webm(cues_size=2189)
    start = data.index(bytes.fromhex("1C53BB6B"))
    init, index, dur = stream_preview._find_webm_ranges(data)
    assert init == f"0-{start - 1}"
    assert index == f"{start}-{start + 4 + 2 + 2189 - 1}"  # id + 2-byte size + body
    assert dur == pytest.approx(635.0)

def test_only_the_cues_header_must_be_in_the_window():
    data = _webm(cues_size=163_814)
    start = data.index(bytes.fromhex("1C53BB6B"))
    assert stream_preview._find_webm_ranges(data[: start + 12])[1].startswith(f"{start}-")

def test_a_window_that_stops_before_cues_asks_for_more():
    data = _webm(cues_size=100, void_before=5000)
    assert stream_preview._find_webm_ranges(data[:1000]) is None

def test_no_cues_before_the_first_cluster_fails():
    with pytest.raises(RuntimeError, match="no Cues"):
        stream_preview._find_webm_ranges(_webm(cues_size=0, cues=False))

def test_the_probe_grows_its_window(monkeypatch):
    data = _webm(cues_size=100, void_before=300_000)
    sizes = []
    def fake(url, *, max_bytes, timeout, headers):
        sizes.append(max_bytes)
        return SimpleNamespace(body=data[:max_bytes])
    monkeypatch.setattr(stream_preview, "fetch_bytes", fake)
    init, index, info = stream_preview._probe_webm_ranges("https://x/v", {})
    start = data.index(bytes.fromhex("1C53BB6B"))
    assert sizes == [256 * 1024, 1024 * 1024]
    assert init == f"0-{start - 1}" and info["boundaries"] == []
```

- [ ] **Step 2: Run** `cd backend && PYTHONPATH=. pytest tests/test_stream_preview_webm.py -q`; expect failures on the missing functions.
- [ ] **Step 3: Implement both functions.** EBML ids keep their length marker; sizes are vints with the marker masked. Descend into Segment only; skip every other element by its size. `_probe_webm_ranges` loops `_PREVIEW_PROBE_SIZES` exactly as `_probe_mp4_ranges` does (same `fetch_bytes` call, same error handling).
- [ ] **Step 4: Run** the same command; expect pass. `ruff check . && ruff format --check . && mypy`.
- [ ] **Step 5: Commit** "Read init and index ranges from a WebM header".

### Task 2: Put the VP9 ladder in the manifest

**Files:**
- Modify: `backend/app/services/stream_preview.py` (`_video_codec_family`, `_pick_adaptive_formats`, `_codecs_string`, `_build_representation`, `_build_manifest_entry` error text, `build_dash_manifest`)
- Modify: `backend/app/services/media_info.py` (rename `_vp9_level` to `vp9_level`, update its callers)
- Test: `backend/tests/test_stream_preview_webm.py`

**Interfaces:**
- Consumes: `_probe_webm_ranges` (Task 1); `media_info.vp9_level(width: int, height: int, fps: float) -> int`.
- Produces: representations with `codec_family == "vp09"`, `mime_type == "video/webm"`, `content_type == "video/webm"`, `codecs == f"vp09.00.{level:02d}.08"`. The manifest's VP9 set is `<AdaptationSet ... mimeType="video/webm" ...>` between the `av01` and `avc1` sets. `/api/preview/media` already answers with the representation's `content_type`.

- [ ] **Step 1: Write failing tests** (formats as yt-dlp dicts; `_probe_mp4_ranges` / `_probe_webm_ranges` monkeypatched to return fixed ranges):

```python
def test_vp9_above_1080p_joins_the_ladder():        # H.264 to 1080, VP9 144..2160 webm
    videos, _ = stream_preview._pick_adaptive_formats(info)
    assert {f["height"] for f in videos if f["_codec_family"] == "vp09"} == {144, 240, 360, 480, 720, 1080, 1440, 2160}

def test_vp9_at_1080p_or_below_is_left_out():       # H.264 to 720, VP9 to 1080
    assert all(f["_codec_family"] != "vp09" for f in videos)

def test_hdr_vp9_is_left_out():                     # dynamic_range "HDR10", vcodec "vp09.02.51.10"

def test_manifest_lists_webm_between_av1_and_h264():
    mpd = stream_preview.build_dash_manifest(entry)
    assert mpd.index('codecs="av01') < mpd.index('mimeType="video/webm"') < mpd.index('codecs="avc1')
    assert 'codecs="vp09.00.51.08"' in mpd          # 3840x2160 at 60 fps
    assert 'indexRange="219-2413"' in mpd

def test_a_1080p_video_gets_the_manifest_it_got_before():
    # same info with and without a 360p-only VP9 format: identical MPD text

def test_failed_vp9_probes_leave_the_other_ladders(monkeypatch):
    # _probe_webm_ranges raises; entry still has avc1 (and av01) reps, no vp09
```

- [ ] **Step 2: Run**; expect failures.
- [ ] **Step 3: Implement.** In `_pick_adaptive_formats`, accept `ext == "webm"` for VP9 video-only formats alongside the `mp4`/`m4a` filter, collect them, and drop the whole family unless its top height is above 1080. `_build_representation` picks the probe and mime by family. `_segment_base_xml` already omits timescale when it is 0. `_boundaries_aligned` gets empty boundaries for WebM: make sure that reads as "not aligned" so the alignment attributes are omitted for that set.
- [ ] **Step 4: Run** `pytest tests/test_stream_preview_webm.py tests/test_stream_preview.py -q`, ruff, mypy; expect pass. Regenerate `backend/openapi.json` only if it changed.
- [ ] **Step 5: Measure.** With a real instance (see the worktree test notes), time `GET /api/preview/manifest` cold for five videos above 1080p (`aqz-KE-bpKQ`, `LXb3EKWsInQ`, `FwNqnodc9eg`, `zFiqZMTmolY`, `BTMjD7_evjE`) on `main` and on this branch, three runs each. If the median grows by more than 0.5 s: raise the probe pool from 6 to 12; if still over, leave out VP9 144p and 240p; if still over, stop and report.
- [ ] **Step 6: Commit** "Offer VP9 above 1080p in the stream manifest".

### Task 3: Choose the codec per load from hardware decoding

**Files:**
- Modify: `frontend/src/utils/decodeCapability.ts` (add `vp9Supported: boolean` to `DecodeSupport`; bump the cache key to `horde.decode-capability.v4`)
- Modify: `frontend/src/hooks/useShakaDash.ts` (`streamLoadLimits`, `videoCodecConfig`)
- Test: `frontend/src/hooks/useShakaDash.test.ts`

**Interfaces:**
- Produces:

```ts
export type CodecFamily = "av01" | "vp09" | "avc1";
export type StreamQualityState = {
  downgrade: StreamDowngrade | null;      // Task 4 changes StreamDowngrade
  pickedCodec: CodecFamily | null;        // replaces av1Picked
  otherCodecQualities: { quality: number; codec: CodecFamily }[]; // replaces av1Only; filled in Task 4
};
export function streamLoadLimits(caps: DecodeSupport, live: boolean, state: StreamQualityState):
  { codecs: CodecFamily[]; maxHeight: number };
export function videoCodecConfig(live: boolean, codecs: CodecFamily[]): object;
```

- [ ] **Step 1: Write failing vitest cases** for `streamLoadLimits` (not live, no downgrade, nothing picked):

| caps | `codecs` | `maxHeight` |
|---|---|---|
| `maxAv1Efficient: 2160, maxVp9Efficient: 2160` | `["av01","vp09","avc1"]` | 2160 |
| `maxAv1Efficient: 2160, maxVp9Efficient: 0` | `["av01","avc1"]` | 2160 |
| `maxAv1Efficient: 0, maxVp9Efficient: 1440` | `["vp09","avc1"]` | 1440 |
| both 0 | `["avc1"]` | 1080 |
| both 0, `pickedCodec: "vp09"` | `["vp09","avc1"]` | 1080 (Auto is off after a pick; the pick's own restrictions apply) |
| `maxVp9Efficient: 2160`, `downgrade.skipCodecs: ["vp09"]` | `["avc1"]` | `min(1080, downgrade.maxHeight)` |

  Plus: live returns `codecs: []` and `maxHeight` from `maxVp9Efficient` as today; `videoCodecConfig(false, ["vp09","avc1"])` yields `preferredVideo` with those two codecs in order; `videoCodecConfig(true, …)` is `{}`.

  `maxHeight` rule: `min(caps.maxSupportedHeight, max(1080, hardwareTop), downgrade?.maxHeight ?? Infinity)`, where `hardwareTop` is the larger of the efficient heights of the hardware codecs in `codecs` (AV1 and VP9 can both be in the list; which one loads depends on the video).

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/hooks/useShakaDash.test.ts`; expect failures.
- [ ] **Step 3: Implement**; update the one caller in `useShakaDash` and the explicit-pick branches that re-configure `preferredVideo` for an AV1 track so they pass the picked track's codec family first.
- [ ] **Step 4: Run** vitest, `npm run typecheck`, `npm run lint`; expect pass.
- [ ] **Step 5: Commit** "Order a stream's codecs by hardware decoding".

### Task 4: Menu qualities from other codecs, and stepping down by codec

**Files:**
- Modify: `frontend/src/hooks/useShakaDash.ts` (`qualitiesOnlyInAv1` → `qualitiesInOtherCodecs`)
- Modify: `frontend/src/hooks/usePlaybackHealth.ts` (`HealthDowngrade` / `StreamDowngrade`: `blacklistAv1: boolean` → `skipCodec: CodecFamily | null` on the event, `skipCodecs: CodecFamily[]` on the stream state)
- Modify: `frontend/src/components/player/useStreamQuality.ts`
- Test: `frontend/src/hooks/useShakaDash.test.ts`, the existing `useStreamQuality` / `usePlaybackHealth` tests

**Interfaces:**
- Consumes: `CodecFamily`, `StreamQualityState`, `streamLoadLimits` (Task 3).
- Produces: `qualitiesInOtherCodecs(mpd: string, top: number, caps: DecodeSupport): { quality: number; codec: CodecFamily }[]`: qualities above `top` found in `av01` or `vp09` sets, highest first, one entry per quality.

- [ ] **Step 1: Write failing tests.**
  - `qualitiesInOtherCodecs` on a manifest with AV1 and VP9 to 2160: `caps.maxVp9Efficient = 2160` gives `vp09` for 2160 and 1440; `maxVp9Efficient = 0` with `av1Supported` gives `av01`; a VP9-only manifest gives `vp09`.
  - `vp9Supported: false` and `av1Supported: false`: returns `[]` (Review Focus 3).
  - `vp9Supported: false`, `av1Supported: true`, VP9-only manifest: `[]`.
  - Picking a listed quality sets `pickedCodec` to its codec and reloads at the current time; picking Auto clears it and reloads.
  - A health downgrade while the active track is VP9 adds `"vp09"` to `skipCodecs`, reloads, and `streamLoadLimits` then omits it; opening another video starts from `freshStreamState()` (Review Focus 4).
  - A downgrade on H.264 adds no codec and does not reload.
- [ ] **Step 2: Run** `npx vitest run`; expect failures.
- [ ] **Step 3: Implement.** The manifest text filter is registered whenever the load is not live (today only when AV1 is not preferred), since a VP9 or AV1 load can still be missing qualities only on a device that picked by hand. `usePlaybackHealth` reads the active track's `videoCodec` prefix (`av01`, `vp09`/`vp9`, else `avc1`).
- [ ] **Step 4: Run** vitest, typecheck, lint; expect pass.
- [ ] **Step 5: Commit** "List other codecs' qualities and step down by codec".

### Task 5: End-to-end check, docs, decision record

**Files:**
- Modify: `frontend/e2e/stream-warmup.spec.ts` or a new `frontend/e2e/stream-codec.spec.ts`; `backend/app/e2e_seed.py` if a seeded VP9 preview is needed
- Modify: `docs/guides/player.md`, `docs/design/player-architecture.md`, `CHANGELOG.md`
- Create: `docs/adr/0040-streams-choose-a-codec-by-hardware-decoding.md`; list it in `docs/adr/index.md` and `mkdocs.yml`

- [ ] **Step 1: Playwright spec.** Route `/api/preview/manifest` to an MPD with an `avc1` set to 1080p and a `video/webm` `vp09` set to 2160p (media from the seeded VP9 clip `e2e_seed.py` already documents), stub `navigator.mediaCapabilities.decodingInfo` to report `powerEfficient: true` for `vp09` at 2160 and `supported: false` for `av01`. Assert the playing variant's codec starts `vp09` and the quality menu lists 2160p. A second test with every `powerEfficient: false`: playing codec `avc1`, 2160p still in the menu, picking it reloads into `vp09`.
- [ ] **Step 2: Run** `npx playwright test e2e/stream-codec.spec.ts` with this worktree's own `E2E_APP_PORT` / `E2E_SETUP_PORT`; expect pass.
- [ ] **Step 3: Real check** with a real instance, in Chrome with hardware VP9, Firefox on Linux, and Safari on a Mac if one is at hand: `FwNqnodc9eg` (VP9 to 4K, no AV1) and `aqz-KE-bpKQ` (both). Seek, let Auto settle, pick 4K by hand, go back to Auto. Record what each browser played. Check a 1080p video still plays as before.
- [ ] **Step 4: Docs.** `player.md`: replace the "AV1 only where hardware, H.264 elsewhere" paragraph with the three steps and the menu rule. `player-architecture.md`: the WebM set, `streamLoadLimits`' codec order, `qualitiesInOtherCodecs`. ADR 0040 (Context / Decision / Consequences) from the spec's measurements and approaches. CHANGELOG entry under Added.
- [ ] **Step 5: Full gate** `E2E_SHARDS=4 scripts/check.sh --e2e` (see the worktree test notes for the env vars); expect green.
- [ ] **Step 6: Commit** docs and the spec separately from the e2e spec; one independent review pass of the whole branch (new API surface in the manifest, player behaviour) and fix its findings.

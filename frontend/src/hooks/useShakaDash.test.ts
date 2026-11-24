import { describe, expect, it } from "vitest";
import type {
  ShakaPlayer,
  ShakaVariantTrack,
} from "shaka-player/dist/shaka-player.dash.js";
import {
  LIVE_MANIFEST_CONFIG,
  applyQualityPick,
  selectQualityTrack,
} from "./useShakaDash";

describe("live stream config", () => {
  it("appends live segments back to back (HLS sequence mode)", () => {
    // In segments mode Shaka pins each audio segment to its playlist start
    // (5.000 s apart) although YouTube's AAC segments run 4.992 or 5.016 s.
    // The few-ms gaps that leaves make Chrome's audio clock drift ahead of
    // the picture, about 1 s every 10 minutes, until a seek.
    expect(LIVE_MANIFEST_CONFIG.hls.sequenceMode).toBe(true);
  });
});

function fakePlayer(live: boolean) {
  const calls: [ShakaVariantTrack, boolean | undefined][] = [];
  const player = {
    isLive: () => live,
    selectVariantTrack: (track: ShakaVariantTrack, clearBuffer?: boolean) => {
      calls.push([track, clearBuffer]);
    },
  } as unknown as ShakaPlayer;
  return { player, calls };
}

describe("selectQualityTrack", () => {
  const track = { id: 7, height: 480 } as ShakaVariantTrack;

  it("clears the buffer on a video so the new quality shows at once", () => {
    const { player, calls } = fakePlayer(false);
    selectQualityTrack(player, track);
    expect(calls).toEqual([[track, true]]);
  });

  it("keeps the buffer on a live stream (sequence mode would misplace the new segments)", () => {
    const { player, calls } = fakePlayer(true);
    selectQualityTrack(player, track);
    expect(calls).toEqual([[track, false]]);
  });
});

describe("applyQualityPick", () => {
  it("lifts an automatic step-down's cap before choosing the track", () => {
    // Shaka leaves tracks over the restrictions out of getVariantTracks(),
    // so reading them under the cap made every pick above it land on it.
    let maxHeight = 480;
    const all = [2160, 1080, 480].map((height, id) => ({
      id,
      height,
      width: (height * 16) / 9,
      bandwidth: height * 1000,
      videoCodec: "avc1.64002A",
    })) as ShakaVariantTrack[];
    const picked: number[] = [];
    const player = {
      isLive: () => true,
      configure: (config: { restrictions?: { maxHeight?: number } }) => {
        if (config.restrictions?.maxHeight) {
          maxHeight = config.restrictions.maxHeight;
        }
      },
      getVariantTracks: () => all.filter((t) => (t.height ?? 0) <= maxHeight),
      selectVariantTrack: (t: ShakaVariantTrack) => picked.push(t.height ?? 0),
    } as unknown as ShakaPlayer;
    const { target, tracks } = applyQualityPick(player, 2160);
    expect(target).toBe(2160);
    expect(picked).toEqual([2160]);
    expect(tracks).toHaveLength(3);
  });
});

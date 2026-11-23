import { describe, expect, it } from "vitest";
import type {
  ShakaPlayer,
  ShakaVariantTrack,
} from "shaka-player/dist/shaka-player.dash.js";
import { LIVE_MANIFEST_CONFIG, selectQualityTrack } from "./useShakaDash";

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

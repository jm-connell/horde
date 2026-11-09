import { describe, expect, it } from "vitest";
import { blendBandwidthEstimate } from "./decodeCapability";

describe("blendBandwidthEstimate", () => {
  it("takes a higher reading as it is", () => {
    expect(blendBandwidthEstimate(null, 3_000_000)).toBe(3_000_000);
    expect(blendBandwidthEstimate(8_000_000, 20_000_000)).toBe(20_000_000);
  });

  it("eases down only a little on a low reading", () => {
    // A slow first segment does not drag a 20 Mbps line down to 2 Mbps.
    expect(blendBandwidthEstimate(20_000_000, 2_000_000)).toBe(18_000_000);
  });

  it("follows a connection that stays slow", () => {
    let bw = 20_000_000;
    for (let i = 0; i < 40; i++) bw = blendBandwidthEstimate(bw, 2_000_000);
    expect(bw).toBe(2_000_000);
  });
});

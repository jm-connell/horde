import { describe, expect, it } from "vitest";
import type { SponsorSegment } from "../hooks/useSponsorBlock";
import {
  sponsorSegmentKey,
  suppressSponsorSegmentsOnBackwardSeek,
} from "./videoPlayerSponsor";

const sponsor: SponsorSegment = {
  startSec: 20,
  endSec: 40,
  category: "sponsor",
};

const intro: SponsorSegment = {
  startSec: 0,
  endSec: 8,
  category: "intro",
};

describe("suppressSponsorSegmentsOnBackwardSeek", () => {
  it("suppresses a segment the playhead seeks backward into", () => {
    const suppressed = new Set<string>();
    suppressSponsorSegmentsOnBackwardSeek(45, 30, [sponsor], suppressed);
    expect(suppressed.has(sponsorSegmentKey(sponsor))).toBe(true);
  });

  it("does not suppress when seeking forward into a segment", () => {
    const suppressed = new Set<string>();
    suppressSponsorSegmentsOnBackwardSeek(10, 30, [sponsor], suppressed);
    expect(suppressed.size).toBe(0);
  });

  it("does not suppress when seeking backward to before the segment", () => {
    const suppressed = new Set<string>();
    suppressSponsorSegmentsOnBackwardSeek(45, 15, [sponsor], suppressed);
    expect(suppressed.size).toBe(0);
  });

  it("does not treat landing on the segment end as inside it", () => {
    const suppressed = new Set<string>();
    suppressSponsorSegmentsOnBackwardSeek(50, 40, [sponsor], suppressed);
    expect(suppressed.size).toBe(0);
  });

  it("ignores tiny backward jitter", () => {
    const suppressed = new Set<string>();
    suppressSponsorSegmentsOnBackwardSeek(30.02, 30, [sponsor], suppressed);
    expect(suppressed.size).toBe(0);
  });

  it("only suppresses the segment that contains the seek target", () => {
    const suppressed = new Set<string>();
    suppressSponsorSegmentsOnBackwardSeek(45, 30, [intro, sponsor], suppressed);
    expect([...suppressed]).toEqual([sponsorSegmentKey(sponsor)]);
  });
});

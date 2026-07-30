import { describe, expect, it } from "vitest";
import {
  abrRestrictions,
  distinctQualities,
  isPortraitLadder,
  qualityMenuLabel,
  streamQualityToChoice,
} from "./videoPlayerQuality";
import type { StreamQuality } from "../hooks/useSettings";

describe("videoPlayerQuality", () => {
  it("maps stream quality settings", () => {
    expect(streamQualityToChoice("auto")).toBe("auto");
    expect(streamQualityToChoice("1080")).toBe(1080);
    expect(streamQualityToChoice("nope" as StreamQuality)).toBe("auto");
  });

  it("labels quality menu choices", () => {
    expect(qualityMenuLabel("auto")).toBe("Auto");
    expect(qualityMenuLabel(2160)).toBe("4K");
    expect(qualityMenuLabel(720)).toBe("720p");
  });

  it("collects distinct qualities descending", () => {
    expect(
      distinctQualities([
        { width: 1920, height: 1080 },
        { width: 1280, height: 720 },
        { width: 1920, height: 1080 },
      ])
    ).toEqual([1080, 720]);
  });

  it("detects portrait ladders and ABR caps", () => {
    const portrait = [{ width: 1080, height: 1920 }];
    expect(isPortraitLadder(portrait)).toBe(true);
    expect(abrRestrictions(1080, portrait)).toEqual({
      maxWidth: 1080,
      maxHeight: 8192,
    });
    expect(abrRestrictions(720, [{ width: 1280, height: 720 }])).toEqual({
      maxHeight: 720,
      maxWidth: 8192,
    });
  });
});

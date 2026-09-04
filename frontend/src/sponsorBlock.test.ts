import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPONSOR_BLOCK_CATEGORIES,
  enabledSponsorBlockCategories,
  normalizeSponsorBlockCategories,
  normalizeSponsorBlockSkipMode,
  sponsorBlockSegmentLabel,
} from "./sponsorBlock";

describe("enabledSponsorBlockCategories", () => {
  it("returns only enabled ids in catalog order", () => {
    expect(
      enabledSponsorBlockCategories({
        ...DEFAULT_SPONSOR_BLOCK_CATEGORIES,
        intro: false,
        filler: true,
      })
    ).toEqual([
      "sponsor",
      "selfpromo",
      "interaction",
      "outro",
      "filler",
    ]);
  });
});

describe("sponsorBlockSegmentLabel", () => {
  it("labels known categories and falls back", () => {
    expect(sponsorBlockSegmentLabel("selfpromo")).toBe("Self-promo");
    expect(sponsorBlockSegmentLabel("interaction")).toBe("Interaction");
    expect(sponsorBlockSegmentLabel("unknown")).toBe("Segment");
  });
});

describe("normalizeSponsorBlockSkipMode", () => {
  it("defaults missing or invalid values to auto", () => {
    expect(normalizeSponsorBlockSkipMode(undefined)).toBe("auto");
    expect(normalizeSponsorBlockSkipMode("nope")).toBe("auto");
    expect(normalizeSponsorBlockSkipMode("prompt")).toBe("prompt");
  });
});

describe("normalizeSponsorBlockCategories", () => {
  it("merges partial maps and ignores unknown keys", () => {
    expect(
      normalizeSponsorBlockCategories({
        sponsor: false,
        filler: true,
        bogus: true,
        intro: "yes",
      })
    ).toEqual({
      ...DEFAULT_SPONSOR_BLOCK_CATEGORIES,
      sponsor: false,
      filler: true,
    });
  });

  it("returns defaults for non-objects", () => {
    expect(normalizeSponsorBlockCategories(null)).toEqual(
      DEFAULT_SPONSOR_BLOCK_CATEGORIES
    );
  });
});

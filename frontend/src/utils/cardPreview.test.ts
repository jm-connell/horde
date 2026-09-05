import { describe, expect, it } from "vitest";
import {
  CENTER_BAND_RATIO,
  CENTER_MARGIN_PX,
  MIN_WIDTH_RATIO,
  pickCenteredPreview,
  previewResumeFor,
  previewStartSec,
  reportPreviewTime,
  resolvePreviewMode,
  shouldHandoffPreview,
} from "./cardPreview";

const phone = { width: 390, height: 844 };

describe("resolvePreviewMode", () => {
  it("disables previews when the user prefers reduced motion", () => {
    expect(
      resolvePreviewMode({
        previewOnHover: true,
        previewWhenCentered: true,
        hoverCapable: true,
        reducedMotion: true,
      })
    ).toBe("off");
  });

  it("uses hover on fine pointers and center otherwise", () => {
    expect(
      resolvePreviewMode({
        previewOnHover: true,
        previewWhenCentered: false,
        hoverCapable: true,
        reducedMotion: false,
      })
    ).toBe("hover");
    expect(
      resolvePreviewMode({
        previewOnHover: false,
        previewWhenCentered: true,
        hoverCapable: true,
        reducedMotion: false,
      })
    ).toBe("off");
    expect(
      resolvePreviewMode({
        previewOnHover: true,
        previewWhenCentered: true,
        hoverCapable: false,
        reducedMotion: false,
      })
    ).toBe("center");
    expect(
      resolvePreviewMode({
        previewOnHover: true,
        previewWhenCentered: false,
        hoverCapable: false,
        reducedMotion: false,
      })
    ).toBe("off");
  });
});

describe("previewStartSec", () => {
  it("starts at zero without progress", () => {
    expect(previewStartSec(0, 120)).toBe(0);
    expect(previewStartSec(undefined, 120)).toBe(0);
  });

  it("resumes from continue-watching when enough time remains", () => {
    expect(previewStartSec(40, 120)).toBe(40);
  });

  it("restarts near the end", () => {
    expect(previewStartSec(119, 120)).toBe(0);
    expect(previewStartSec(115, 120)).toBe(115);
  });
});

describe("shouldHandoffPreview", () => {
  it("hands off after more than 5 seconds of preview", () => {
    expect(shouldHandoffPreview(0, 5.1)).toBe(true);
    expect(shouldHandoffPreview(0, 5)).toBe(false);
    expect(shouldHandoffPreview(40, 46)).toBe(true);
    expect(shouldHandoffPreview(40, 45)).toBe(false);
  });

  it("ignores tiny or invalid positions", () => {
    expect(shouldHandoffPreview(0, 0)).toBe(false);
    expect(shouldHandoffPreview(0, 1)).toBe(false);
    expect(shouldHandoffPreview(0, Number.NaN)).toBe(false);
  });
});

describe("previewResumeFor", () => {
  it("returns the preview time after a long watch of that video", () => {
    reportPreviewTime(7, 0, 12);
    expect(previewResumeFor(7)).toBe(12);
    expect(previewResumeFor(8)).toBeNull();
    reportPreviewTime(7, 0, 3);
    expect(previewResumeFor(7)).toBeNull();
    reportPreviewTime(9, 40, 46.5);
    expect(previewResumeFor(9)).toBe(46.5);
  });
});

describe("pickCenteredPreview", () => {
  const minWidth = phone.width * MIN_WIDTH_RATIO;
  const full = minWidth + 20;

  it("picks a full-width card in the vertical center", () => {
    const height = 200;
    const top = phone.height / 2 - height / 2;
    expect(
      pickCenteredPreview(
        [{ id: "mid", top, left: 16, width: full, height }],
        phone
      )
    ).toBe("mid");
  });

  it("ignores narrow continue-watching cards even when centered", () => {
    expect(
      pickCenteredPreview(
        [
          {
            id: "cw",
            top: phone.height / 2 - 63,
            left: 16,
            width: 224,
            height: 126,
          },
        ],
        phone
      )
    ).toBeNull();
  });

  it("ignores cards whose center is outside the mid-screen band", () => {
    const band = phone.height * CENTER_BAND_RATIO;
    expect(
      pickCenteredPreview(
        [
          {
            id: "top",
            top: 8,
            left: 16,
            width: full,
            height: 200,
          },
        ],
        phone
      )
    ).toBeNull();
    expect(band).toBeGreaterThan(50);
  });

  it("picks the uniquely closer of two stacked full-width cards", () => {
    const height = 180;
    const closerTop = phone.height / 2 - height / 2;
    const fartherTop = closerTop - height - 24;
    expect(
      pickCenteredPreview(
        [
          { id: "far", top: fartherTop, left: 16, width: full, height },
          { id: "near", top: closerTop, left: 16, width: full, height },
        ],
        phone
      )
    ).toBe("near");
  });

  it("returns null when two in-band cards are not uniquely central", () => {
    const height = 160;
    const cy = phone.height / 2;
    const aTop = cy - height / 2 - 8;
    const bTop = aTop + CENTER_MARGIN_PX / 2;
    expect(
      pickCenteredPreview(
        [
          { id: "a", top: aTop, left: 16, width: full, height },
          { id: "b", top: bTop, left: 16, width: full, height },
        ],
        phone
      )
    ).toBeNull();
  });

  it("returns null for an empty list or zero viewport", () => {
    expect(pickCenteredPreview([], phone)).toBeNull();
    expect(
      pickCenteredPreview(
        [{ id: "x", top: 0, left: 0, width: 400, height: 200 }],
        { width: 0, height: 800 }
      )
    ).toBeNull();
  });
});

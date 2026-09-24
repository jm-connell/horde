import { describe, expect, it } from "vitest";
import { shouldApplyResumePosition } from "./videoPlayerResume";

describe("shouldApplyResumePosition", () => {
  it("seeks when a new source has a resume point", () => {
    expect(
      shouldApplyResumePosition({
        currentTime: 400,
        resumeAt: 12,
        sourceChanged: true,
      }),
    ).toBe(true);
  });

  it("seeks when the resume point arrives before playback starts", () => {
    expect(
      shouldApplyResumePosition({
        currentTime: 0,
        resumeAt: 80,
        sourceChanged: false,
      }),
    ).toBe(true);
  });

  it("does not seek a lagging progress save while this source is playing", () => {
    expect(
      shouldApplyResumePosition({
        currentTime: 102,
        resumeAt: 100,
        sourceChanged: false,
      }),
    ).toBe(false);
  });

  it("does not yank playback back to the original resume point", () => {
    expect(
      shouldApplyResumePosition({
        currentTime: 400,
        resumeAt: 12,
        sourceChanged: false,
      }),
    ).toBe(false);
  });

  it("ignores an empty resume point", () => {
    expect(
      shouldApplyResumePosition({
        currentTime: 0,
        resumeAt: 0,
        sourceChanged: true,
      }),
    ).toBe(false);
  });
});

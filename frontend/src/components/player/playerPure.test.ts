import { describe, expect, it } from "vitest";
import { SPEED_STEPS, snapRateToStep } from "./constants";
import { playerLayout } from "./playerLayout";
import {
  activeChapterAt,
  isChapterActive,
  nextChapterStartAfter,
} from "./useChapters";
import { liveResumeTime } from "./useLiveResume";
import { noticeReducer, skipNoticeText } from "./useSkipSegments";

const seg = { startSec: 5, endSec: 9, label: "Sponsor" };

describe("noticeReducer / skipNoticeText", () => {
  it("shows a prompt, then a skipped notice, then clears", () => {
    const prompt = noticeReducer(null, { type: "prompt", segment: seg });
    expect(prompt).toEqual({ kind: "prompt", segment: seg });
    expect(skipNoticeText(prompt!)).toBe("Sponsor");

    const skipped = noticeReducer(prompt, { type: "skipped", segment: seg });
    expect(skipped).toEqual({ kind: "skipped", segment: seg });
    expect(skipNoticeText(skipped!)).toBe("Skipped: Sponsor");

    expect(noticeReducer(skipped, { type: "clear" })).toBeNull();
  });
});

describe("chapters", () => {
  const chapters = [
    { startSec: 0, title: "Intro" },
    { startSec: 8, title: "Middle" },
    { startSec: 14, title: "End" },
  ];

  it("finds the active chapter", () => {
    expect(activeChapterAt([], 3)).toBeNull();
    expect(activeChapterAt(chapters, 0)?.title).toBe("Intro");
    expect(activeChapterAt(chapters, 7.9)?.title).toBe("Intro");
    expect(activeChapterAt(chapters, 8)?.title).toBe("Middle");
    expect(activeChapterAt(chapters, 99)?.title).toBe("End");
  });

  it("knows whether a chapter index is active", () => {
    expect(isChapterActive(chapters, 1, 7.9)).toBe(false);
    expect(isChapterActive(chapters, 1, 8)).toBe(true);
    expect(isChapterActive(chapters, 1, 14)).toBe(false);
    expect(isChapterActive(chapters, 2, 500)).toBe(true);
  });

  it("jumps to the first chapter more than a second ahead", () => {
    expect(nextChapterStartAfter(chapters, 1)).toBe(8);
    expect(nextChapterStartAfter(chapters, 7)).toBe(14); // 8 is within 1 s
    expect(nextChapterStartAfter(chapters, 6.9)).toBe(8);
    expect(nextChapterStartAfter(chapters, 13)).toBeNull();
    expect(nextChapterStartAfter([], 0)).toBeNull();
  });
});

describe("snapRateToStep", () => {
  it("keeps known steps and snaps others to the nearest", () => {
    for (const s of SPEED_STEPS) expect(snapRateToStep(s)).toBe(s);
    expect(snapRateToStep(1.1)).toBe(1);
    expect(snapRateToStep(1.4)).toBe(1.5);
    expect(snapRateToStep(10)).toBe(3);
    expect(snapRateToStep(0)).toBe(0.25);
  });
});

describe("playerLayout", () => {
  const base = {
    isMini: false,
    isMobile: false,
    isNativeFullscreen: false,
    mode: "standard" as const,
    videoAspect: null,
    canMoveMini: false,
    subtitleSize: "medium" as const,
  };

  it("sizes the standard video by device", () => {
    expect(playerLayout(base).videoClass).toContain("max-h-[85vh]");
    expect(playerLayout({ ...base, isMobile: true }).videoClass).toContain(
      "max-h-[70vh]"
    );
    expect(playerLayout(base).subtitleClass).toBe("sub-medium");
  });

  it("fills the box in fit-window and native fullscreen", () => {
    for (const o of [
      { mode: "windowed" as const },
      { isNativeFullscreen: true },
    ]) {
      const l = playerLayout({ ...base, ...o });
      expect(l.wrapperClass).toContain("h-full");
      expect(l.innerClass).toContain("h-full");
      expect(l.videoClass).toContain("object-contain");
    }
  });

  it("gives the mini player the picture's aspect and a grab cursor when movable", () => {
    const mini = { ...base, isMini: true };
    expect(playerLayout(mini).miniStyle).toEqual({ aspectRatio: "16 / 9" });
    expect(playerLayout({ ...mini, videoAspect: 2 }).miniStyle).toEqual({
      aspectRatio: "2",
    });
    expect(playerLayout(mini).wrapperClass).not.toContain("cursor-grab");
    expect(playerLayout({ ...mini, canMoveMini: true }).wrapperClass).toContain(
      "cursor-grab"
    );
    expect(playerLayout(base).miniStyle).toBeUndefined();
  });
});

describe("liveResumeTime", () => {
  const range = { start: 100, end: 3700 };

  it("keeps the distance behind live plus the time away", () => {
    expect(liveResumeTime(range, 0)).toBe(3700);
    expect(liveResumeTime(range, 600)).toBe(3100);
  });

  it("stops at the oldest part the stream still keeps", () => {
    expect(liveResumeTime(range, 9000)).toBe(100);
  });
});

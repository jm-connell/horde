import { describe, expect, it } from "vitest";
import {
  COPY_GAP_REM,
  META_LH_REM,
  TITLE_LH_REM,
  combinedMetaOverflows,
  lineCountFromBox,
  shouldStackMeta,
  titleLinesShown,
} from "./useCardCopyLayout";

const rem = 16;
const titleLh = TITLE_LH_REM * rem;
const metaLh = META_LH_REM * rem;
const gap = COPY_GAP_REM * rem;

function compactInner(titleLines: number, metaLines: number): number {
  const metaGaps = Math.max(0, metaLines - 1);
  return titleLines * titleLh + (1 + metaGaps) * gap + metaLines * metaLh;
}

describe("combinedMetaOverflows", () => {
  it("is false when the nowrap footer fits", () => {
    expect(combinedMetaOverflows(200, 220)).toBe(false);
  });

  it("is true when channel, date, and res exceed the card width", () => {
    expect(combinedMetaOverflows(240, 220)).toBe(true);
  });

  it("treats a subpixel overflow as too wide", () => {
    expect(combinedMetaOverflows(220.6, 220)).toBe(true);
  });
});

describe("lineCountFromBox", () => {
  it("counts a single line", () => {
    expect(lineCountFromBox(20, 20)).toBe(1);
  });

  it("counts two lines", () => {
    expect(lineCountFromBox(40, 20)).toBe(2);
  });

  it("caps long titles", () => {
    expect(lineCountFromBox(400, 20)).toBe(8);
  });
});

describe("shouldStackMeta", () => {
  it("stacks a one-line title even with no leftover", () => {
    expect(
      shouldStackMeta({
        titleNeeded: 1,
        detailsInner: compactInner(1, 1),
        rem,
        hasSecondary: true,
      })
    ).toBe(true);
  });

  it("combines a two-line title that fills a compact cell", () => {
    expect(
      shouldStackMeta({
        titleNeeded: 2,
        detailsInner: compactInner(2, 1),
        rem,
        hasSecondary: true,
      })
    ).toBe(false);
  });

  it("stacks a two-line title when leftover remains after a combined footer", () => {
    expect(
      shouldStackMeta({
        titleNeeded: 2,
        detailsInner: compactInner(2, 2),
        rem,
        hasSecondary: true,
      })
    ).toBe(true);
  });

  it("keeps stacking after the footer is stacked (no flicker)", () => {
    const inner = compactInner(2, 2);
    expect(
      shouldStackMeta({
        titleNeeded: 2,
        detailsInner: inner,
        rem,
        hasSecondary: true,
      })
    ).toBe(true);
  });

  it("does not stack when there is no date/views to split", () => {
    expect(
      shouldStackMeta({
        titleNeeded: 1,
        detailsInner: compactInner(2, 2),
        rem,
        hasSecondary: false,
      })
    ).toBe(false);
  });

  it("stacks when combined channel, date, and res do not fit on one line", () => {
    expect(
      shouldStackMeta({
        titleNeeded: 2,
        detailsInner: compactInner(2, 1),
        rem,
        hasSecondary: true,
        combinedOverflows: true,
      })
    ).toBe(true);
  });

  it("does not stack a long title that still needs the combined footer", () => {
    expect(
      shouldStackMeta({
        titleNeeded: 3,
        detailsInner: compactInner(2, 1) + titleLh,
        rem,
        hasSecondary: true,
      })
    ).toBe(false);
  });

  it("stacks once leftover remains after the full title and a combined footer", () => {
    expect(
      shouldStackMeta({
        titleNeeded: 3,
        detailsInner: compactInner(3, 2),
        rem,
        hasSecondary: true,
      })
    ).toBe(true);
  });
});

describe("titleLinesShown", () => {
  it("keeps a short title to one line when the cell is stretched", () => {
    expect(
      titleLinesShown({
        titleNeeded: 1,
        detailsInner: compactInner(2, 2) + 2 * titleLh,
        stacked: true,
        rem,
      })
    ).toBe(1);
  });

  it("clamps a wrapping title to two lines in a compact cell", () => {
    expect(
      titleLinesShown({
        titleNeeded: 4,
        detailsInner: compactInner(2, 1),
        stacked: false,
        rem,
      })
    ).toBe(2);
  });

  it("grows the clamp when leftover can fit the full title", () => {
    expect(
      titleLinesShown({
        titleNeeded: 3,
        detailsInner: compactInner(2, 1) + titleLh,
        stacked: false,
        rem,
      })
    ).toBe(3);
  });

  it("does not exceed titleNeeded", () => {
    expect(
      titleLinesShown({
        titleNeeded: 2,
        detailsInner: compactInner(2, 1) + 3 * titleLh,
        stacked: false,
        rem,
      })
    ).toBe(2);
  });

  it("defaults to at most two lines before the details box is measured", () => {
    expect(
      titleLinesShown({
        titleNeeded: 5,
        detailsInner: 0,
        stacked: false,
        rem,
      })
    ).toBe(2);
  });

  it("clamps the title to one line when stacked meta takes the second compact slot", () => {
    expect(
      titleLinesShown({
        titleNeeded: 2,
        detailsInner: compactInner(2, 1),
        stacked: true,
        rem,
      })
    ).toBe(1);
  });
});

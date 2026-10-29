import { describe, expect, it } from "vitest";
import { groupDetails, planCopy, type CopyMeasures } from "./cardCopyPlan";

/** A 240px card: channel 80px, facts 70px each, " · " 10px. */
function card(over: Partial<CopyMeasures> = {}): CopyMeasures {
  return {
    titleNeeded: 1,
    units: 0,
    width: 240,
    channelWidth: 80,
    factWidths: [70, 60],
    required: 2,
    sepWidth: 10,
    trailingWidth: 0,
    ...over,
  };
}

describe("groupDetails", () => {
  it("puts everything on one line, then the channel alone", () => {
    expect(groupDetails(true, 3, 1)).toEqual([["c", 0, 1, 2]]);
    expect(groupDetails(true, 3, 2)).toEqual([["c"], [0, 1, 2]]);
    expect(groupDetails(true, 3, 3)).toEqual([["c"], [0, 1], [2]]);
    expect(groupDetails(true, 3, 9)).toEqual([["c"], [0], [1], [2]]);
  });

  it("spreads facts alone when there is no channel", () => {
    expect(groupDetails(false, 2, 1)).toEqual([[0, 1]]);
    expect(groupDetails(false, 2, 2)).toEqual([[0], [1]]);
  });
});

describe("planCopy", () => {
  it("asks for the title and the fewest lines that show every detail whole", () => {
    // 80 + 10 + 70 + 10 + 60 = 230 fits 240: one line.
    expect(planCopy(card())).toMatchObject({
      titleLines: 1,
      lines: [["c", 0, 1]],
      naturalUnits: 2,
    });
    // With a 40px download button the line no longer fits: two lines.
    expect(planCopy(card({ trailingWidth: 40 }))).toMatchObject({
      lines: [["c"], [0, 1]],
      naturalUnits: 3,
    });
  });

  it("never shows more than two title lines", () => {
    expect(planCopy(card({ titleNeeded: 5 })).titleLines).toBe(2);
  });

  it("splits the details to fill a taller row", () => {
    // Its row is four units tall (a neighbour has a two-line title and two lines).
    expect(planCopy(card({ units: 4 }))).toMatchObject({
      lines: [["c"], [0], [1]],
      naturalUnits: 2,
    });
    expect(planCopy(card({ units: 3 })).lines).toEqual([["c"], [0, 1]]);
  });

  it("brings in optional facts only to fill whole lines", () => {
    const sparse = card({ factWidths: [70, 60], required: 1 });
    // Natural: channel and the required date on one line; views stay hidden.
    expect(planCopy(sparse)).toMatchObject({
      lines: [["c", 0]],
      naturalUnits: 2,
    });
    expect(planCopy({ ...sparse, units: 3 }).lines).toEqual([["c"], [0]]);
    expect(planCopy({ ...sparse, units: 4 }).lines).toEqual([["c"], [0], [1]]);
  });

  it("keeps the trailing status on a line even without details", () => {
    expect(
      planCopy(
        card({
          channelWidth: 0,
          factWidths: [],
          required: 0,
          trailingWidth: 30,
        })
      )
    ).toMatchObject({ lines: [[]], naturalUnits: 2 });
  });

  it("asks for the most lines when nothing fits, and lets the line cut off", () => {
    expect(planCopy(card({ width: 50 })).lines).toEqual([["c"], [0], [1]]);
  });
});

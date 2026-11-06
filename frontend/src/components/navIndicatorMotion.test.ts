import { describe, expect, it } from "vitest";
import {
  BAR_BASE,
  CORNERS,
  DOT_SIZE,
  cornerKeyframes,
  dotKeyframes,
  dotPoint,
  focusCorners,
  isStackedRow,
  stretchBar,
  stretchKeyframes,
} from "./navIndicatorMotion";

/** translate(x, y) and optional scale(sx, sy) out of a keyframe's transform. */
function parse(k: Keyframe) {
  const t = String(k.transform);
  const [x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/
    .exec(t)!
    .slice(1)
    .map(Number);
  const scale = /scale\(([-\d.]+), ([-\d.]+)\)/.exec(t);
  const [sx, sy] = scale ? scale.slice(1).map(Number) : [1, 1];
  return { x, y, sx, sy };
}

const home = { left: 0, top: 0, width: 80, height: 36 };
const settings = { left: 200, top: 0, width: 100, height: 36 };

describe("stretchKeyframes", () => {
  it("reaches the new item with its leading end first, thinning as it goes", () => {
    const frames = stretchKeyframes(stretchBar(home), stretchBar(settings));
    const reach = parse(frames[1]);
    const to = stretchBar(settings);
    // The tail has barely left; the head is already at the far edge.
    expect(reach.x).toBeLessThan(to.x / 2);
    expect(reach.x + reach.sx * BAR_BASE).toBeCloseTo(to.x + to.w);
    expect(reach.sy).toBeLessThan(1);
    expect(parse(frames[frames.length - 1])).toEqual({
      x: to.x,
      y: to.y,
      sx: to.w / BAR_BASE,
      sy: 1,
    });
  });

  it("leads with its left end when it moves left", () => {
    const frames = stretchKeyframes(stretchBar(settings), stretchBar(home));
    const reach = parse(frames[1]);
    expect(reach.x).toBe(stretchBar(home).x);
    // The right end is still near where it started.
    expect(reach.x + reach.sx * BAR_BASE).toBeGreaterThan(
      stretchBar(settings).x
    );
  });

  it("just glides between stacked items", () => {
    const below = { ...home, top: 48 };
    expect(stretchKeyframes(stretchBar(home), stretchBar(below))).toHaveLength(
      2
    );
  });
});

describe("dotKeyframes", () => {
  it("stretches along the way and lands round", () => {
    const frames = dotKeyframes({ x: 0, y: 30 }, { x: 160, y: 30 });
    const mid = parse(frames[1]);
    expect(mid.sx).toBeGreaterThan(2);
    expect(mid.sy).toBeLessThan(1);
    expect(parse(frames[frames.length - 1])).toEqual({
      x: 160,
      y: 30,
      sx: 1,
      sy: 1,
    });
  });
});

describe("dotPoint", () => {
  it("sits under a tab, but beside the label of a full-width menu row", () => {
    const tab = { left: 100, top: 0, width: 80, height: 36 };
    const row = { left: 12, top: 48, width: 360, height: 44 };
    expect(isStackedRow(tab, 400)).toBe(false);
    expect(isStackedRow(row, 384)).toBe(true);
    // Under the tab: centred, near the bottom edge.
    expect(dotPoint(tab).x + DOT_SIZE / 2).toBe(tab.left + tab.width / 2);
    expect(dotPoint(tab).y).toBeGreaterThan(tab.top + tab.height / 2);
    // In the row: at its left, vertically centred.
    const bullet = dotPoint(row, true);
    expect(bullet.x).toBeLessThan(row.left + 16);
    expect(bullet.y + DOT_SIZE / 2).toBe(row.top + row.height / 2);
  });
});

describe("cornerKeyframes", () => {
  it("lands each corner a little wide, then tightens onto the item", () => {
    const from = focusCorners(home);
    const to = focusCorners(settings);
    CORNERS.forEach((out, i) => {
      const frames = cornerKeyframes(from[i], to[i], out).map(parse);
      const wide = frames[1];
      expect(Math.sign(wide.x - to[i].x)).toBe(out.x);
      expect(Math.sign(wide.y - to[i].y)).toBe(out.y);
      expect(frames[2]).toMatchObject({ x: to[i].x, y: to[i].y });
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  CORNERS,
  DOT_SIZE,
  cornerKeyframes,
  dotKeyframes,
  dotPoint,
  focusCorners,
  isStackedRow,
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

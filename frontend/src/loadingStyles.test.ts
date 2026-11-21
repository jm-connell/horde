import { describe, expect, it } from "vitest";
import {
  LOADING_STYLES,
  LOADING_STYLE_OPTIONS,
  isLoadingStyle,
  normalizeLoadingStyle,
} from "./loadingStyles";

const KEPT = [
  "spinner",
  "orbit",
  "helix",
  "infinity",
  "sweep",
  "spokes",
  "dots",
  "pulse",
  "wave",
  "cube",
  "spiral",
  "swarm",
  "leapfrog",
];

describe("loading styles", () => {
  it("lists exactly the 13 kept styles", () => {
    expect([...LOADING_STYLES]).toEqual(KEPT);
  });

  it("offers one option per style, in the Settings order", () => {
    expect(LOADING_STYLE_OPTIONS.map((o) => o.value)).toEqual(KEPT);
    expect(LOADING_STYLE_OPTIONS.map((o) => o.label)).toEqual([
      "Spinner",
      "Orbit",
      "Helix",
      "Infinity",
      "Sweep",
      "Spokes",
      "Dots",
      "Pulse",
      "Wave",
      "Cube",
      "Spiral",
      "Swarm",
      "Leapfrog",
    ]);
    for (const option of LOADING_STYLE_OPTIONS)
      expect(option.description).not.toBe("");
  });
});

describe("normalizeLoadingStyle", () => {
  it.each(KEPT)("keeps %s as it is", (value) => {
    expect(normalizeLoadingStyle(value)).toBe(value);
  });

  it("maps the old arc to spinner and the old bar to sweep", () => {
    expect(normalizeLoadingStyle("arc")).toBe("spinner");
    expect(normalizeLoadingStyle("bar")).toBe("sweep");
  });

  it.each([
    "comet",
    "tiles",
    "petal",
    "plus",
    "ringwalk",
    "cradle",
    "clapper",
    "play",
  ])("falls back to dots for the removed %s", (value) => {
    expect(isLoadingStyle(value)).toBe(false);
    expect(normalizeLoadingStyle(value)).toBe("dots");
  });

  it.each([
    "",
    "Spinner",
    "nope",
    "toString",
    "__proto__",
    undefined,
    null,
    3,
    true,
    {},
    ["spinner"],
  ])("falls back to dots for %j", (value) => {
    expect(normalizeLoadingStyle(value)).toBe("dots");
  });
});

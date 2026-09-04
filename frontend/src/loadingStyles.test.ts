import { describe, expect, it } from "vitest";
import {
  isLoadingStyle,
  LOADING_STYLE_OPTIONS,
  LOADING_STYLES,
} from "./loadingStyles";
import { firstMatchingTab } from "./pages/settings/search";

describe("loading styles", () => {
  it("lists a unique option for every style", () => {
    const values = LOADING_STYLE_OPTIONS.map((o) => o.value);
    expect(values).toEqual([...LOADING_STYLES]);
    expect(new Set(values).size).toBe(LOADING_STYLES.length);
    for (const opt of LOADING_STYLE_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });

  it("accepts known styles and rejects unknown ones", () => {
    expect(isLoadingStyle("dots")).toBe(true);
    expect(isLoadingStyle("blob")).toBe(true);
    expect(isLoadingStyle("atom")).toBe(true);
    expect(isLoadingStyle("cube")).toBe(true);
    expect(isLoadingStyle("leapfrog")).toBe(true);
    expect(isLoadingStyle("goo")).toBe(true);
    expect(isLoadingStyle("pong")).toBe(true);
    expect(isLoadingStyle("infinity")).toBe(false);
    expect(isLoadingStyle("tesseract")).toBe(false);
    expect(isLoadingStyle("nope")).toBe(false);
    expect(isLoadingStyle(null)).toBe(false);
  });
});

describe("settings search for loading styles", () => {
  it("routes loading animation names to appearance", () => {
    expect(firstMatchingTab("orbit")).toBe("appearance");
    expect(firstMatchingTab("comet")).toBe("appearance");
    expect(firstMatchingTab("helix")).toBe("appearance");
    expect(firstMatchingTab("leapfrog")).toBe("appearance");
    expect(firstMatchingTab("newton")).toBe("appearance");
    expect(firstMatchingTab("equalizer")).toBe("appearance");
  });
});

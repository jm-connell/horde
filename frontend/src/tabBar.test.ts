import { describe, expect, it } from "vitest";
import { DEFAULT_TAB_BAR, TAB_BAR_MAX, normalizeTabBarItems } from "./tabBar";

describe("normalizeTabBarItems", () => {
  it("keeps known tabs in the saved order", () => {
    expect(normalizeTabBarItems(["download", "home", "chat"])).toEqual([
      "download",
      "home",
      "chat",
    ]);
  });

  it("drops unknown and repeated tabs and caps the count", () => {
    expect(
      normalizeTabBarItems([
        "home",
        "nope",
        3,
        "home",
        "search",
        "download",
        "chat",
        "history",
        "settings",
      ])
    ).toHaveLength(TAB_BAR_MAX);
    expect(normalizeTabBarItems(["home", "nope", "home"])).toEqual(["home"]);
  });

  it("falls back to the defaults when nothing usable is saved", () => {
    expect(normalizeTabBarItems(undefined)).toEqual(DEFAULT_TAB_BAR);
    expect(normalizeTabBarItems([])).toEqual(DEFAULT_TAB_BAR);
    expect(normalizeTabBarItems(["nope"])).toEqual(DEFAULT_TAB_BAR);
  });
});

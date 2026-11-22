import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_BAR, normalizeNavBarItems } from "./navBar";

describe("normalizeNavBarItems", () => {
  it("keeps known pages in the saved order", () => {
    expect(normalizeNavBarItems(["settings", "history", "home"])).toEqual([
      "settings",
      "history",
      "home",
    ]);
  });

  it("drops unknown and repeated pages", () => {
    expect(
      normalizeNavBarItems(["home", "nope", 3, "home", "settings"])
    ).toEqual(["home", "settings"]);
  });

  it("always keeps Settings, at the end when it was missing", () => {
    expect(normalizeNavBarItems(["history", "home"])).toEqual([
      "history",
      "home",
      "settings",
    ]);
    expect(normalizeNavBarItems([])).toEqual(["settings"]);
  });

  it("falls back to every page when nothing was saved", () => {
    expect(normalizeNavBarItems(undefined)).toEqual(DEFAULT_NAV_BAR);
    expect(normalizeNavBarItems("home")).toEqual(DEFAULT_NAV_BAR);
  });
});

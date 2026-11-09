import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_ITEMS, moveNavItem, normalizeNavItems } from "./navItems";

describe("normalizeNavItems", () => {
  it("keeps the saved order of known pages, each once", () => {
    expect(
      normalizeNavItems(["history", "home", "bogus", "home", "settings"])
    ).toEqual(["history", "home", "settings"]);
  });
  it("always keeps Settings, and falls back to the default", () => {
    expect(normalizeNavItems(["home"])).toEqual(["home", "settings"]);
    expect(normalizeNavItems([])).toEqual(DEFAULT_NAV_ITEMS);
    expect(normalizeNavItems("nope")).toEqual(DEFAULT_NAV_ITEMS);
  });
});

describe("moveNavItem", () => {
  it("puts the dragged page where the target was", () => {
    expect(
      moveNavItem(["home", "history", "settings"], "settings", "home")
    ).toEqual(["settings", "home", "history"]);
    expect(
      moveNavItem(["home", "history", "settings"], "home", "history")
    ).toEqual(["history", "home", "settings"]);
  });
});

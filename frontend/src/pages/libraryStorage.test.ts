import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOME_TAB_KEY, homeTabOf, takeBrowserHomeTab } from "./libraryStorage";

let saved: Map<string, string>;

beforeEach(() => {
  saved = new Map();
  const storage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  vi.stubGlobal("window", { localStorage: storage, sessionStorage: storage });
});
afterEach(() => vi.unstubAllGlobals());

describe("home tab", () => {
  it("reads what was saved, the old Recommended+ as Recommended", () => {
    expect(homeTabOf("recommended")).toBe("recommended");
    expect(homeTabOf("discover")).toBe("recommended");
    expect(homeTabOf("library")).toBe("library");
    expect(homeTabOf(undefined)).toBe("library");
    expect(homeTabOf("elsewhere")).toBe("library");
  });

  it("hands over this browser's old choice once", () => {
    expect(takeBrowserHomeTab()).toBeNull();
    saved.set(HOME_TAB_KEY, "discover");
    expect(takeBrowserHomeTab()).toBe("recommended");
    expect(saved.has(HOME_TAB_KEY)).toBe(false);
    expect(takeBrowserHomeTab()).toBeNull();
  });
});

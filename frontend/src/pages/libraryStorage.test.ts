import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOME_TAB_KEY, loadHomeTab, saveHomeTab } from "./libraryStorage";

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
  it("comes back as it was saved", () => {
    saveHomeTab("recommended");
    expect(loadHomeTab()).toBe("recommended");
    saveHomeTab("library");
    expect(loadHomeTab()).toBe("library");
  });

  it("opens Recommended for the old Recommended+ choice", () => {
    saved.set(HOME_TAB_KEY, "discover");
    expect(loadHomeTab()).toBe("recommended");
  });

  it("starts on Library when nothing (or nonsense) is saved", () => {
    expect(loadHomeTab()).toBe("library");
    saved.set(HOME_TAB_KEY, "elsewhere");
    expect(loadHomeTab()).toBe("library");
  });
});

import { describe, expect, it } from "vitest";
import {
  SEARCH_HISTORY_CHARS,
  SEARCH_HISTORY_MAX,
  addSearch,
  normalizeSearchHistory,
  removeSearch,
} from "./searchHistory";

describe("addSearch", () => {
  it("puts the newest search first and moves a repeat up", () => {
    expect(addSearch(["cedar", "aurora"], "kites")).toEqual([
      "kites",
      "cedar",
      "aurora",
    ]);
    expect(addSearch(["cedar", "Aurora"], " aurora ")).toEqual([
      "aurora",
      "cedar",
    ]);
  });

  it("ignores a blank search and keeps at most the cap", () => {
    expect(addSearch(["cedar"], "   ")).toEqual(["cedar"]);
    const full = Array.from({ length: SEARCH_HISTORY_MAX }, (_, i) => `q${i}`);
    const next = addSearch(full, "new");
    expect(next).toHaveLength(SEARCH_HISTORY_MAX);
    expect(next[0]).toBe("new");
    expect(next).not.toContain(`q${SEARCH_HISTORY_MAX - 1}`);
  });

  it("cuts a very long search", () => {
    expect(addSearch([], "x".repeat(500))[0]).toHaveLength(
      SEARCH_HISTORY_CHARS
    );
  });
});

describe("removeSearch", () => {
  it("drops just that entry", () => {
    expect(removeSearch(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("normalizeSearchHistory", () => {
  it("keeps trimmed strings, each once, in order", () => {
    expect(
      normalizeSearchHistory([" cedar ", 3, null, "", "Cedar", "aurora"])
    ).toEqual(["cedar", "aurora"]);
  });

  it("is empty for anything but a list, and capped", () => {
    expect(normalizeSearchHistory(undefined)).toEqual([]);
    expect(normalizeSearchHistory("cedar")).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => `q${i}`);
    expect(normalizeSearchHistory(many)).toHaveLength(SEARCH_HISTORY_MAX);
  });
});

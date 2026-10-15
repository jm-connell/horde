import { describe, expect, it } from "vitest";
import { safeNextPath } from "./authPaths";

describe("safeNextPath", () => {
  it("keeps same-origin paths with their query", () => {
    expect(safeNextPath("/watch/3?t=40")).toBe("/watch/3?t=40");
    expect(safeNextPath("/settings?tab=ai")).toBe("/settings?tab=ai");
  });

  it("refuses anything that could leave the site or loop", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("https://evil.example/")).toBe("/");
    expect(safeNextPath("//evil.example/")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    expect(safeNextPath("/login?next=/x")).toBe("/");
  });
});

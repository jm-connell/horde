import { describe, expect, it } from "vitest";
import { safeNextPath } from "./authPaths";

describe("safeNextPath", () => {
  it("keeps same-origin paths with their query and hash", () => {
    expect(safeNextPath("/watch/3?t=40")).toBe("/watch/3?t=40");
    expect(safeNextPath("/settings?tab=ai#x")).toBe("/settings?tab=ai#x");
  });

  it("refuses anything that could leave the site or loop", () => {
    for (const bad of [
      null,
      "",
      "https://evil.example/",
      "//evil.example/",
      "javascript:alert(1)",
      "/login?next=/x",
      "/login",
      "/login/",
    ]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });

  it("refuses the backslash and control-character tricks browsers normalise", () => {
    for (const bad of [
      "/\\evil.example/x",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\u0000/evil.example",
      "/ok\\..\\evil",
    ]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });

  it("refuses dot segments that resolve to a protocol-relative path", () => {
    for (const bad of [
      "/.//evil.example",
      "/..//evil.example",
      "/./..//evil.example/x?y=1",
      "/a/..//evil.example",
      "/login/../login",
    ]) {
      expect(safeNextPath(bad)).toBe("/");
    }
    expect(safeNextPath("/a/../library?q=1")).toBe("/library?q=1");
  });
});

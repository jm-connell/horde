import { describe, expect, it } from "vitest";
import { isServerOnlyPath } from "./serverPaths";

describe("isServerOnlyPath", () => {
  it("keeps API, docs and asset paths away from the SPA shell", () => {
    for (const path of [
      "/api/videos",
      "/wiki/",
      "/docs",
      "/redoc",
      "/openapi.json",
      "/assets/index.js",
    ]) {
      expect(isServerOnlyPath(path), path).toBe(true);
    }
  });

  it("ignores case and extra leading slashes, as the server does", () => {
    for (const path of ["/API/x", "//api/x", "///Api/videos", "//WIKI"]) {
      expect(isServerOnlyPath(path), path).toBe(true);
    }
  });

  it("treats the bare /api like the rest of the API", () => {
    for (const path of ["/api", "/API", "//api", "///Api"]) {
      expect(isServerOnlyPath(path), path).toBe(true);
    }
  });

  it("decodes percent-escapes and survives malformed ones", () => {
    for (const path of ["/%61pi/x", "/%61pi", "/%41PI/x", "//%61pi/x"]) {
      expect(isServerOnlyPath(path), path).toBe(true);
    }
    expect(isServerOnlyPath("/%E0%A4%A")).toBe(false);
    expect(isServerOnlyPath("/%zz")).toBe(false);
  });

  it("leaves app routes to the shell", () => {
    for (const path of [
      "/",
      "/watch/3",
      "/settings",
      "/apis",
      "/application",
    ]) {
      expect(isServerOnlyPath(path), path).toBe(false);
    }
  });
});

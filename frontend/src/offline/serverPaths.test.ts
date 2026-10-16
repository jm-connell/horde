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

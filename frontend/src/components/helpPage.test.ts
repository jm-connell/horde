import { describe, expect, it } from "vitest";
import { describePage } from "./helpPage";

describe("describePage", () => {
  it("names the page and keeps the path", () => {
    expect(describePage("/history", "")).toBe("History (/history)");
    expect(describePage("/nope", "?a=1")).toBe("an unknown page (/nope?a=1)");
  });

  it("adds what part of the page is showing and the mini player", () => {
    expect(describePage("/settings", "", { detail: "AI tab" })).toBe(
      "Settings, AI tab (/settings)"
    );
    expect(describePage("/playlists", "", { miniPlayer: true })).toBe(
      "Playlists, with a video in the mini player (/playlists)"
    );
  });

  it("stays within what the server keeps", () => {
    const long = "x".repeat(500);
    const page = describePage(`/${long}`, `?${long}`, {
      detail: long,
      miniPlayer: true,
    });
    expect(page.length).toBeLessThanOrEqual(200);
  });
});

import { describe, expect, it } from "vitest";
import { describePage } from "./helpPage";

describe("describePage", () => {
  it("names the page and keeps the path", () => {
    expect(describePage("/history", "")).toBe("History (/history)");
    expect(describePage("/nope", "?a=1")).toBe("an unknown page (/nope?a=1)");
  });

  it("adds the selected tab, the library search and what is playing", () => {
    expect(describePage("/settings", "", { detail: "AI tab" })).toBe(
      "Settings, AI tab (/settings)"
    );
    expect(describePage("/", "", { query: " cats " })).toBe(
      'Library, searching "cats" (/)'
    );
    expect(
      describePage("/watch/7", "", { playing: { title: "Cats", mini: false } })
    ).toBe('Watch page, watching "Cats" (/watch/7)');
    expect(
      describePage("/playlists", "", { playing: { title: "Cats", mini: true } })
    ).toBe('Playlists, with "Cats" in the mini player (/playlists)');
  });

  it("stays within what the server accepts", () => {
    const long = "x".repeat(500);
    const page = describePage("/", `?${long}`, {
      detail: long,
      query: long,
      playing: { title: long, mini: true },
    });
    expect(page.length).toBeLessThanOrEqual(300);
  });
});

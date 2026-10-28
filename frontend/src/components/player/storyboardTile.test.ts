import { describe, expect, it } from "vitest";
import { storyboardTileStyle } from "./storyboardTile";

const board = {
  tile_width: 160,
  tile_height: 90,
  columns: 5,
  rows: 5,
  interval_sec: 5,
  count: 60,
  sheets: [
    "https://i.ytimg.com/a.jpg",
    "https://i.ytimg.com/b.jpg",
    "https://i.ytimg.com/c.jpg",
  ],
};

describe("storyboardTileStyle", () => {
  it("finds the sheet, row and column for a time", () => {
    // 137 s -> frame 27: second sheet, frame 2 on it (row 0, column 2).
    const style = storyboardTileStyle(board, 137);
    expect(style?.backgroundImage).toBe('url("https://i.ytimg.com/b.jpg")');
    expect(style?.backgroundPosition).toBe("-320px -0px");
    expect(style?.backgroundSize).toBe("800px 450px");
  });

  it("clamps past the end to the last frame", () => {
    const style = storyboardTileStyle(board, 10_000);
    // Frame 59: third sheet, frame 9 (row 1, column 4).
    expect(style?.backgroundImage).toBe('url("https://i.ytimg.com/c.jpg")');
    expect(style?.backgroundPosition).toBe("-640px -90px");
  });
});

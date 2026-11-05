import { describe, expect, it } from "vitest";
import { chromecastSource } from "./useCasting";

describe("chromecastSource", () => {
  it("sends the H.264 copy when the video has one", () => {
    expect(chromecastSource(7, true, "video/webm")).toEqual({
      path: "/api/videos/7/stream?rendition=compat",
      mimeType: "video/mp4",
    });
  });

  it("sends the original otherwise", () => {
    expect(chromecastSource(7, false, "video/webm")).toEqual({
      path: "/api/videos/7/stream",
      mimeType: "video/webm",
    });
  });
});

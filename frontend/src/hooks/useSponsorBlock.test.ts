import { describe, expect, it } from "vitest";
import { extractYouTubeId } from "../hooks/useSponsorBlock";

describe("extractYouTubeId", () => {
  it("reads watch URLs, short links, and [id] file paths", () => {
    expect(
      extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "")
    ).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ", "")).toBe(
      "dQw4w9WgXcQ"
    );
    expect(
      extractYouTubeId(null, "Chan/2024/Title [dQw4w9WgXcQ].mp4")
    ).toBe("dQw4w9WgXcQ");
  });

  it("returns null when nothing looks like a YouTube id", () => {
    expect(extractYouTubeId(null, "imports/drop.mp4")).toBeNull();
    expect(extractYouTubeId("https://vimeo.com/123", "imports/drop.mp4")).toBeNull();
  });
});
